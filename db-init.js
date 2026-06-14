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

  try {
    const sql = neon(process.env.DATABASE_URL);

    await sql`
      CREATE TABLE IF NOT EXISTS deployed_bots (
        id SERIAL PRIMARY KEY,
        bot_token TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        channel_link TEXT,
        channel_username TEXT,
        webhook_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
        is_active BOOLEAN DEFAULT TRUE
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS verified_users (
        id SERIAL PRIMARY KEY,
        bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        verified_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(bot_id, user_id)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS pending_join_messages (
        id SERIAL PRIMARY KEY,
        bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(bot_id, user_id)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS bot_logs (
        id SERIAL PRIMARY KEY,
        bot_id INTEGER REFERENCES deployed_bots(id) ON DELETE CASCADE,
        query_text TEXT,
        query_type TEXT,
        user_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: "Database tables created successfully." }),
    };
  } catch (error) {
    console.error("DB Init Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
