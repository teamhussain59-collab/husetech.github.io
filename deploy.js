const { neon } = require("@neondatabase/serverless");

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: "Method not allowed" }) };
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const body = JSON.parse(event.body || "{}");
    const { bot_token, chat_id } = body;

    // ── Validate inputs ──
    if (!bot_token || typeof bot_token !== "string" || bot_token.length < 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Valid Bot Token required." }) };
    }
    if (!chat_id || isNaN(Number(chat_id))) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Valid Chat ID required." }) };
    }

    // ── Ensure tables exist ──
    await ensureTables(sql);

    // ── Verify the bot token with Telegram ──
    const meRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: "Invalid Bot Token. Please check and try again." }),
      };
    }

    const botInfo = meData.result;

    // ── Build webhook URL ──
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || "";
    const webhookUrl = `${siteUrl}/.netlify/functions/webhook`;

    // ── Set Telegram Webhook ──
    const whRes = await fetch(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
        drop_pending_updates: true,
      }),
    });
    const whData = await whRes.json();
    if (!whData.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: "Telegram Webhook Error: " + whData.description }),
      };
    }

    // ── Save / Update in Database ──
    await sql`
      INSERT INTO deployed_bots (bot_token, chat_id, webhook_url, expires_at, is_active)
      VALUES (${bot_token}, ${chat_id}, ${webhookUrl}, NOW() + INTERVAL '7 days', TRUE)
      ON CONFLICT (bot_token)
      DO UPDATE SET
        chat_id = EXCLUDED.chat_id,
        webhook_url = EXCLUDED.webhook_url,
        expires_at = NOW() + INTERVAL '7 days',
        is_active = TRUE
    `;

    // ── Send confirmation to admin ──
    await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat_id,
        text: `✅ *Bot Deployed Successfully!*\n\n🤖 Bot: @${botInfo.username}\n🌐 Webhook: Active\n⏰ Expires: 7 days\n\n📱 /num 03XXXXXXXXX — Phone Search\n🆔 /cnic XXXXX-XXXXXXX-X — CNIC Search\n\nSeedha number ya CNIC bhi type kar sakte hain!`,
        parse_mode: "Markdown",
      }),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        bot_name: botInfo.first_name,
        bot_username: botInfo.username,
        webhook_url: webhookUrl,
        expires_in: "7 days",
      }),
    };
  } catch (error) {
    console.error("Deploy Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: "Server error: " + error.message }),
    };
  }
};

async function ensureTables(sql) {
  await sql`CREATE TABLE IF NOT EXISTS deployed_bots (id SERIAL PRIMARY KEY, bot_token TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, channel_link TEXT, channel_username TEXT, webhook_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'), is_active BOOLEAN DEFAULT TRUE)`;
  await sql`CREATE TABLE IF NOT EXISTS verified_users (id SERIAL PRIMARY KEY, bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE, user_id TEXT NOT NULL, verified_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(bot_id, user_id))`;
  await sql`CREATE TABLE IF NOT EXISTS pending_join_messages (id SERIAL PRIMARY KEY, bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(bot_id, user_id))`;
  await sql`CREATE TABLE IF NOT EXISTS bot_logs (id SERIAL PRIMARY KEY, bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE, query_text TEXT, query_type TEXT, user_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`;
}
