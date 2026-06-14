const { neon } = require("@neondatabase/serverless");

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const sql = neon(process.env.DATABASE_URL);
    const params = event.queryStringParameters || {};
    const token = params.token;

    if (!token) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Token required" }) };
    }

    const [bot] = await sql`
      SELECT id, chat_id, webhook_url, created_at, expires_at, is_active
      FROM deployed_bots WHERE bot_token = ${token}
    `;

    if (!bot) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: "Bot not found" }) };
    }

    const [{ count: logCount }] = await sql`SELECT COUNT(*) as count FROM bot_logs WHERE bot_id = ${bot.id}`;
    const [{ count: userCount }] = await sql`SELECT COUNT(*) as count FROM verified_users WHERE bot_id = ${bot.id}`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        bot: {
          chat_id: bot.chat_id,
          webhook_url: bot.webhook_url,
          created_at: bot.created_at,
          expires_at: bot.expires_at,
          is_active: bot.is_active,
          total_queries: Number(logCount),
          verified_users: Number(userCount),
        },
      }),
    };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: error.message }) };
  }
};
