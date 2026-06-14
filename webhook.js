const { neon } = require("@neondatabase/serverless");

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const body = JSON.parse(event.body || "{}");

    // Extract bot token from path or header
    // Telegram sends to: /.netlify/functions/webhook
    // We store token in DB — find bot by chat context
    const token = extractToken(event);

    if (!token) {
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── AUTO VERIFY: chat_member update ──
    if (body.chat_member) {
      const cm = body.chat_member;
      const newStatus = cm.new_chat_member?.status;
      const oldStatus = cm.old_chat_member?.status;
      const joinedUserId = cm.new_chat_member?.user?.id;
      const wasNotMember = ["left", "kicked", "banned", "restricted"].includes(oldStatus);
      const isNowMember = ["member", "administrator", "creator"].includes(newStatus);

      if (wasNotMember && isNowMember && joinedUserId) {
        const [bot] = await sql`SELECT * FROM deployed_bots WHERE bot_token = ${token} AND is_active = TRUE`;
        if (bot) {
          await sql`INSERT INTO verified_users (bot_id, user_id) VALUES (${bot.id}, ${String(joinedUserId)}) ON CONFLICT (bot_id, user_id) DO NOTHING`;
          const [pending] = await sql`SELECT * FROM pending_join_messages WHERE bot_id = ${bot.id} AND user_id = ${String(joinedUserId)}`;
          if (pending) {
            await deleteMessage(token, pending.chat_id, pending.message_id);
            await sql`DELETE FROM pending_join_messages WHERE bot_id = ${bot.id} AND user_id = ${String(joinedUserId)}`;
            await sendMessage(token, pending.chat_id,
              "✅ *Channel Join — Auto Verified!*\n\n🎉 Ab Search Kar Sakte Hain!\n\n📱 /num 03XXXXXXXXX\n🆔 /cnic XXXXX-XXXXXXX-X\n\nYa seedha number type karo!",
              [[{ text: "📱 Phone Search", switch_inline_query_current_chat: "/num " }],
               [{ text: "🆔 CNIC Search", switch_inline_query_current_chat: "/cnic " }]]
            );
          }
        }
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── CALLBACK QUERY ──
    if (body.callback_query) {
      const cb = body.callback_query;
      const cbChatId = cb.message.chat.id;
      const cbUserId = cb.from.id;
      const cbMsgId = cb.message.message_id;

      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id }),
      });

      if (cb.data === "check_join") {
        const [bot] = await sql`SELECT * FROM deployed_bots WHERE bot_token = ${token} AND is_active = TRUE`;
        if (!bot) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

        const isJoined = await checkMembership(token, cbUserId, bot.channel_username);
        if (isJoined) {
          await deleteMessage(token, cbChatId, cbMsgId);
          await sql`DELETE FROM pending_join_messages WHERE bot_id = ${bot.id} AND user_id = ${String(cbUserId)}`;
          await sql`INSERT INTO verified_users (bot_id, user_id) VALUES (${bot.id}, ${String(cbUserId)}) ON CONFLICT (bot_id, user_id) DO NOTHING`;
          await sendMessage(token, cbChatId,
            "✅ *Verify Ho Gaya!*\n\n🎉 Welcome to SB DATA HUB Bot!\n\n📱 /num 03XXXXXXXXX\n🆔 /cnic XXXXX-XXXXXXX-X",
            [[{ text: "📱 Phone Search", switch_inline_query_current_chat: "/num " }],
             [{ text: "🆔 CNIC Search", switch_inline_query_current_chat: "/cnic " }]]
          );
        } else {
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: "❌ Abhi Tak Join Nahi Kiya! Pehle Join Karein.", show_alert: true }),
          });
        }
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── NORMAL MESSAGES ──
    if (!body.message) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    const message = body.message;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = (message.text || "").trim();
    if (!text) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    const [bot] = await sql`SELECT * FROM deployed_bots WHERE bot_token = ${token} AND is_active = TRUE`;
    if (!bot) { await sendMessage(token, chatId, "❌ Bot active nahi hai."); return { statusCode: 200, body: JSON.stringify({ ok: true }) }; }
    if (new Date(bot.expires_at) < new Date()) { await sendMessage(token, chatId, "⏰ Bot ki 7 din ki hosting khatam ho gayi. Dobara deploy karein."); return { statusCode: 200, body: JSON.stringify({ ok: true }) }; }

    // Force join check
    if (bot.channel_username) {
      const [verified] = await sql`SELECT id FROM verified_users WHERE bot_id = ${bot.id} AND user_id = ${String(userId)}`;
      if (!verified) {
        const isJoined = await checkMembership(token, userId, bot.channel_username);
        if (!isJoined) {
          const sent = await sendMessage(token, chatId, "🔐 *SB DATA HUB Bot*\n\nPehle channel join karein:",
            [[{ text: "📢 Channel Join Karein", url: bot.channel_link || `https://t.me/${bot.channel_username.replace("@","")}` }],
             [{ text: "✅ Join Kar Liya — Verify", callback_data: "check_join" }]]
          );
          if (sent?.result?.message_id) {
            await sql`INSERT INTO pending_join_messages (bot_id, user_id, chat_id, message_id) VALUES (${bot.id}, ${String(userId)}, ${String(chatId)}, ${sent.result.message_id}) ON CONFLICT (bot_id, user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, message_id = EXCLUDED.message_id, created_at = NOW()`;
          }
          return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        } else {
          await sql`INSERT INTO verified_users (bot_id, user_id) VALUES (${bot.id}, ${String(userId)}) ON CONFLICT (bot_id, user_id) DO NOTHING`;
        }
      }
    }

    // Commands
    if (text === "/start") {
      await sendMessage(token, chatId,
        `👋 *Welcome to SB DATA HUB Bot!*\n\n📱 /num 03XXXXXXXXX — Phone Search\n🆔 /cnic XXXXX-XXXXXXX-X — CNIC Search\n\nYa seedha number ya CNIC type karo!`,
        [[{ text: "📱 Phone Search", switch_inline_query_current_chat: "/num " }],
         [{ text: "🆔 CNIC Search", switch_inline_query_current_chat: "/cnic " }]]
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (text.startsWith("/num") || text.startsWith("/cnic")) {
      const isPhone = text.startsWith("/num");
      const parts = text.split(/\s+/);
      const query = parts.length >= 2 ? parts.slice(1).join("") : "";
      if (!query) {
        await sendMessage(token, chatId, isPhone ? "📱 Usage: /num 03XXXXXXXXX" : "🆔 Usage: /cnic XXXXX-XXXXXXX-X");
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      await doSearch(sql, token, chatId, query, bot, userId, isPhone ? "phone" : "cnic");
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // Direct number detection
    const clean = text.replace(/[-\s]/g, "");
    if (/^(03|92)\d{9}$/.test(clean) || /^03\d{9}$/.test(text)) {
      await doSearch(sql, token, chatId, text, bot, userId, "phone");
    } else if (/^\d{13}$/.test(clean) || /^\d{5}-\d{7}-\d$/.test(text)) {
      await doSearch(sql, token, chatId, text, bot, userId, "cnic");
    } else {
      await sendMessage(token, chatId, "ℹ️ Commands:\n📱 /num 03XXXXXXXXX\n🆔 /cnic XXXXX-XXXXXXX-X\n\nYa seedha number type karein!");
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (error) {
    console.error("Webhook Error:", error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }
};

function extractToken(event) {
  // Token passed as query param: /.netlify/functions/webhook?token=XXX
  const params = event.queryStringParameters || {};
  return params.token || null;
}

async function doSearch(sql, token, chatId, query, bot, userId, type) {
  await sendMessage(token, chatId, "🔍 Database search ho rahi hai...");
  try {
    const res = await fetch(`https://famofc.site/api/database.php?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.success && data.data?.records?.length > 0) {
      const rec = data.data.records[0];
      if (!rec.full_name || rec.full_name.includes("*") || rec.full_name === "N/A") {
        await sendMessage(token, chatId, "🔒 RECORD ENCRYPTED!\n\nPaid data ke liye admin se contact karein.");
      } else {
        let txt = "✅ *Record Mila:*\n\n";
        data.data.records.forEach(item => {
          txt += `👤 *Naam:* ${escape(item.full_name)}\n📱 *Phone:* ${escape(item.phone)}\n🆔 *CNIC:* ${escape(item.cnic)}\n🏠 *Pata:* ${escape(item.address)}\n\n`;
        });
        await sendMessage(token, chatId, txt);
      }
    } else {
      await sendMessage(token, chatId, "❌ Koi record nahi mila!\n\nPaid data ke liye admin se contact karein.");
    }
    await sql`INSERT INTO bot_logs (bot_id, query_text, query_type, user_id) VALUES (${bot.id}, ${query}, ${type}, ${String(userId)})`;
  } catch (e) {
    console.error("Search error:", e);
    await sendMessage(token, chatId, "⚠️ System error! Thodi der baad try karein.");
  }
}

function escape(t) { return t ? String(t).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1") : "N/A"; }

async function sendMessage(token, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

async function deleteMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
}

async function checkMembership(token, userId, channelUsername) {
  try {
    const ch = channelUsername?.startsWith("@") ? channelUsername : `@${channelUsername}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(ch)}&user_id=${userId}`);
    const data = await res.json();
    return data.ok && ["member","administrator","creator"].includes(data.result.status);
  } catch { return false; }
}
