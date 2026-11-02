// D1 database layer — the Cloudflare equivalent of database.py.
//
// Every helper degrades gracefully when the D1 binding is missing so the
// dashboard and bot still answer (with a clear warning) instead of throwing.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tracked_users (
     username TEXT PRIMARY KEY,
     last_id TEXT DEFAULT '',
     last_checked INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
     chat_id TEXT NOT NULL,
     username TEXT NOT NULL,
     PRIMARY KEY (chat_id, username)
   )`,
  `CREATE TABLE IF NOT EXISTS sent_ids (
     chat_id TEXT NOT NULL,
     tweet_id TEXT NOT NULL,
     created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
     PRIMARY KEY (chat_id, tweet_id)
   )`,
  `CREATE TABLE IF NOT EXISTS tweets_content (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL,
     title TEXT DEFAULT '',
     translation TEXT DEFAULT '',
     img_url TEXT DEFAULT '',
     tweet_link TEXT DEFAULT '',
     created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
   )`,
  'CREATE INDEX IF NOT EXISTS idx_subs_username ON subscriptions(username)',
  'CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets_content(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sent_created ON sent_ids(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_tracked_checked ON tracked_users(last_checked ASC)',
];

let schemaReady = false;

export function dbEnabled(env) {
  return Boolean(env && env.DB);
}

export async function ensureSchema(env) {
  if (!dbEnabled(env)) return false;
  if (schemaReady) return true;
  try {
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    schemaReady = true;
    return true;
  } catch (error) {
    console.error('D1 schema init failed:', error?.message || error);
    return false;
  }
}

async function all(env, sql, params = [], fallback = []) {
  if (!dbEnabled(env)) return fallback;
  try {
    const { results } = await env.DB.prepare(sql).bind(...params).all();
    return results || fallback;
  } catch (error) {
    console.error('D1 query failed:', error?.message || error);
    return fallback;
  }
}

async function first(env, sql, params = [], fallback = null) {
  if (!dbEnabled(env)) return fallback;
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch (error) {
    console.error('D1 query failed:', error?.message || error);
    return fallback;
  }
}

async function run(env, sql, params = []) {
  if (!dbEnabled(env)) return null;
  try {
    return await env.DB.prepare(sql).bind(...params).run();
  } catch (error) {
    console.error('D1 write failed:', error?.message || error);
    return null;
  }
}

/* ── Tracked accounts ─────────────────────────────────────────────────── */

export function getAllTracked(env) {
  return all(env, 'SELECT username, last_id FROM tracked_users');
}

// Round-robin: the accounts checked longest ago go first, so with a small
// per-run batch every account is eventually visited.
export function pickAccountsForCheck(env, limit = 5) {
  return all(
    env,
    `SELECT username, last_id FROM tracked_users
     ORDER BY COALESCE(last_checked, 0) ASC, username ASC
     LIMIT ?`,
    [Math.max(1, Number(limit) || 5)]
  );
}

export function updateLastId(env, username, lastId) {
  return run(env, 'UPDATE tracked_users SET last_id = ? WHERE username = ?', [String(lastId), username]);
}

export function touchChecked(env, username) {
  return run(
    env,
    `UPDATE tracked_users SET last_checked = CAST(strftime('%s', 'now') AS INTEGER) WHERE username = ?`,
    [username]
  );
}

/* ── Subscriptions ────────────────────────────────────────────────────── */

export async function getSubsForUser(env, username) {
  const rows = await all(env, 'SELECT chat_id FROM subscriptions WHERE username = ?', [username]);
  return rows.map((row) => String(row.chat_id));
}

export async function getSubsForChat(env, chatId) {
  const rows = await all(env, 'SELECT username FROM subscriptions WHERE chat_id = ?', [String(chatId)]);
  return rows.map((row) => row.username);
}

export async function isSubscribed(env, chatId, username) {
  const row = await first(env, 'SELECT 1 AS ok FROM subscriptions WHERE chat_id = ? AND username = ?', [
    String(chatId),
    username,
  ]);
  return Boolean(row);
}

export async function addSubscription(env, chatId, username, lastId = '') {
  if (!dbEnabled(env)) return false;
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO tracked_users (username, last_id) VALUES (?, ?) ON CONFLICT (username) DO NOTHING'
      ).bind(username, String(lastId || '')),
      env.DB.prepare(
        'INSERT INTO subscriptions (chat_id, username) VALUES (?, ?) ON CONFLICT (chat_id, username) DO NOTHING'
      ).bind(String(chatId), username),
    ]);
    return true;
  } catch (error) {
    console.error('addSubscription failed:', error?.message || error);
    return false;
  }
}

export async function removeSubscription(env, chatId, username) {
  await run(env, 'DELETE FROM subscriptions WHERE chat_id = ? AND username = ?', [String(chatId), username]);
  const stillUsed = await first(env, 'SELECT 1 AS ok FROM subscriptions WHERE username = ?', [username]);
  if (!stillUsed) await run(env, 'DELETE FROM tracked_users WHERE username = ?', [username]);
}

/* ── Delivery bookkeeping ─────────────────────────────────────────────── */

export async function isDuplicate(env, chatId, tweetId) {
  const row = await first(env, 'SELECT 1 AS ok FROM sent_ids WHERE chat_id = ? AND tweet_id = ?', [
    String(chatId),
    String(tweetId),
  ]);
  return Boolean(row);
}

export function markSent(env, chatId, tweetId) {
  return run(env, 'INSERT INTO sent_ids (chat_id, tweet_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [
    String(chatId),
    String(tweetId),
  ]);
}

export function saveTweetContent(env, { username, title, translation, imgUrl, tweetLink }) {
  return run(
    env,
    `INSERT INTO tweets_content (username, title, translation, img_url, tweet_link)
     VALUES (?, ?, ?, ?, ?)`,
    [username, title || '', translation || '', imgUrl || '', tweetLink || '']
  );
}

/* ── Dashboard data ───────────────────────────────────────────────────── */

export function getLatestTweets(env, limit = 30) {
  return all(
    env,
    `SELECT id, username, title, translation, img_url, tweet_link, created_at
     FROM tweets_content ORDER BY created_at DESC, id DESC LIMIT ?`,
    [Math.max(1, Number(limit) || 30)]
  );
}

function escapeLike(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

export function searchTweets(env, query, chatId = null, limit = 5) {
  // SQLite's LIKE is case-insensitive for ASCII; LOWER() keeps it predictable.
  const pattern = `%${escapeLike(String(query ?? '').toLowerCase())}%`;
  if (chatId) {
    return all(
      env,
      `SELECT username, title, translation, tweet_link FROM tweets_content
       WHERE (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(translation) LIKE ? ESCAPE '\\'
              OR LOWER(username) LIKE ? ESCAPE '\\')
         AND username IN (SELECT username FROM subscriptions WHERE chat_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
      [pattern, pattern, pattern, String(chatId), Math.max(1, Number(limit) || 5)]
    );
  }
  return all(
    env,
    `SELECT username, title, translation, tweet_link FROM tweets_content
     WHERE (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(translation) LIKE ? ESCAPE '\\'
            OR LOWER(username) LIKE ? ESCAPE '\\')
     ORDER BY created_at DESC LIMIT ?`,
    [pattern, pattern, pattern, Math.max(1, Number(limit) || 5)]
  );
}

export async function countTweets(env) {
  const row = await first(env, 'SELECT COUNT(*) AS count FROM tweets_content', [], { count: 0 });
  return Number(row?.count || 0);
}

export async function countMissingTranslations(env) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS count FROM tweets_content
     WHERE TRIM(COALESCE(translation, '')) = '' AND TRIM(COALESCE(title, '')) <> ''`,
    [],
    { count: 0 }
  );
  return Number(row?.count || 0);
}

export async function getTweetsMissingTranslation(env, limit = 5) {
  return all(
    env,
    `SELECT id, username, title, tweet_link FROM tweets_content
     WHERE TRIM(COALESCE(translation, '')) = '' AND TRIM(COALESCE(title, '')) <> ''
     ORDER BY created_at DESC LIMIT ?`,
    [Math.max(1, Number(limit) || 5)]
  );
}

export function updateTweetTranslation(env, id, translation) {
  return run(env, 'UPDATE tweets_content SET translation = ? WHERE id = ?', [translation, id]);
}

export async function cleanup(env) {
  await run(env, `DELETE FROM sent_ids WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')`);
  await run(
    env,
    `DELETE FROM tweets_content WHERE id NOT IN (
       SELECT id FROM tweets_content ORDER BY created_at DESC, id DESC LIMIT 300
     )`
  );
  console.log('D1 cleanup done.');
}
