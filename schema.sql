-- Cloudflare D1 Database Schema for XRelaya (Twitter/X to Telegram Bot)
-- Run with: npx wrangler d1 execute xrelaya-db --remote --file=./schema.sql
-- (Note: The Worker also auto-initializes these tables on /setup or first run)

CREATE TABLE IF NOT EXISTS tracked_users (
    username TEXT PRIMARY KEY,
    last_id TEXT DEFAULT '',
    last_checked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (chat_id, username)
);

CREATE TABLE IF NOT EXISTS sent_ids (
    chat_id TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (chat_id, tweet_id)
);

CREATE TABLE IF NOT EXISTS tweets_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    title TEXT DEFAULT '',
    translation TEXT DEFAULT '',
    img_url TEXT DEFAULT '',
    tweet_link TEXT DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_subs_username ON subscriptions(username);
CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets_content(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_created ON sent_ids(created_at);
CREATE INDEX IF NOT EXISTS idx_tracked_checked ON tracked_users(last_checked ASC);
