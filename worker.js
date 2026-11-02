// XRelaya on Cloudflare Workers
//
// Telegram bot + live PWA dashboard + RSS polling, running without a server:
//   • Telegram talks to this Worker through a webhook (no long polling)
//   • Cloudflare Cron Triggers run the tweet check on a schedule
//   • Cloudflare D1 stores tracked accounts, sent ids and the dashboard feed
//
// All outbound calls go through a subrequest budget (free plan allows 50 per
// invocation), and accounts are checked round-robin so the work always fits.

import dashboardHtml from './dashboard.html';
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  buildMessage,
  escapeHtml,
} from './lib/text.js';
import {
  cleanUsername,
  extractId,
  extractImageUrl,
  extractTweetText,
  fetchFeed,
  isNewerTweetId,
  isRetweet,
  isValidTwitter,
} from './lib/rss.js';
import { translateDetailed, translateText, translationStatus } from './lib/translate.js';
import {
  addSubscription,
  cleanup,
  countMissingTranslations,
  countTweets,
  dbEnabled,
  ensureSchema,
  getAllTracked,
  getLatestTweets,
  getMeta,
  getSubsForChat,
  getSubsForUser,
  getTweetsMissingTranslation,
  isDuplicate,
  isSubscribed,
  markSent,
  pickAccountsForCheck,
  removeSubscription,
  saveTweetContent,
  searchTweets,
  setMeta,
  touchChecked,
  updateLastId,
  updateTweetTranslation,
} from './lib/db.js';
import { createBudget } from './lib/budget.js';
import {
  answerInlineQuery,
  deleteWebhook,
  downloadImage,
  getMe,
  getWebhookInfo,
  sendMessage,
  sendPhoto,
  setMyCommands,
  setWebhook,
  validateWebhookSecret,
} from './lib/telegram.js';

/* ── Config ───────────────────────────────────────────────────────────── */

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function botConfig(env = {}) {
  return {
    accountsPerCycle: Math.floor(num(env.ACCOUNTS_PER_CRON, 3)),
    maxTweetsPerCheck: Math.floor(num(env.MAX_TWEETS_PER_CHECK, 3)),
    backfillLimit: Math.floor(num(env.TRANSLATION_BACKFILL_LIMIT, 5)),
    subrequestBudget: Math.floor(num(env.SUBREQUEST_BUDGET, 40)),
    webhookBudget: Math.floor(num(env.WEBHOOK_BUDGET, 20)),
    feedMirrors: Math.floor(num(env.FEED_MIRRORS, 6)),
    feedBatch: Math.floor(num(env.FEED_BATCH, 3)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Tweet engine ─────────────────────────────────────────────────────── */

export async function buildContent(env, username, entry, budget = null) {
  const tid = extractId(entry);
  if (!tid || isRetweet(entry, username)) return null;
  const title = extractTweetText(entry);
  // translateDetailed keeps the per-provider failure reasons, which /test
  // surfaces so a broken translation service is never a silent mystery.
  const detail = await translateDetailed(env, title, budget);
  return {
    tid,
    username,
    title,
    translation: detail.translation,
    translationProvider: detail.provider,
    translationFailures: detail.failures,
    translationSkipped: detail.skipped,
    img_url: extractImageUrl(entry),
    link: `https://x.com/i/status/${tid}`,
  };
}

export async function deliver(env, content, chatIds, budget = null, force = false) {
  if (!content) return false;
  const keyboard = { inline_keyboard: [[{ text: '🔗 View on X', url: content.link }]] };
  const hasPhoto = Boolean(content.img_url);
  const caption = buildMessage(content, TELEGRAM_CAPTION_LIMIT);
  const fullText = buildMessage(content, TELEGRAM_TEXT_LIMIT);

  let photo = null;
  if (hasPhoto) {
    // Downloading costs one subrequest, uploading another; skip when the
    // budget is tight and let Telegram fetch the URL instead.
    if (!budget || budget.remaining() >= 2) {
      photo = await downloadImage(env, content.img_url, budget);
    }
  }

  let saved = false;
  let allHandled = true;
  for (const chatId of chatIds) {
    if (!force && (await isDuplicate(env, chatId, content.tid))) continue;

    let sent = false;
    if (hasPhoto) {
      sent = await sendPhoto(env, chatId, { photo, photoUrl: content.img_url, caption, keyboard, budget });
      if (!sent) {
        const fallback = await sendMessage(env, chatId, fullText, { keyboard, budget });
        sent = Boolean(fallback?.ok);
      }
    } else {
      const result = await sendMessage(env, chatId, fullText, { keyboard, budget });
      sent = Boolean(result?.ok);
    }

    if (sent) {
      await markSent(env, chatId, content.tid);
      saved = true;
    } else {
      // Keep last_id where it is so the next cycle retries this tweet;
      // per-chat dedupe makes the retry safe for chats that already got it.
      allHandled = false;
    }
  }

  if (saved) {
    await saveTweetContent(env, {
      username: content.username,
      title: content.title,
      translation: content.translation,
      imgUrl: content.img_url,
      tweetLink: content.link,
    });
  }
  return allHandled;
}

function sortByTweetId(entries) {
  return entries.slice().sort((a, b) => {
    const left = String(a[0]);
    const right = String(b[0]);
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
      try {
        const diff = BigInt(left) - BigInt(right);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      } catch {
        /* fall through to string compare */
      }
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function processAccount(env, account, budget) {
  const config = botConfig(env);
  const username = account.username;
  const entries = await fetchFeed(env, username, budget, { mirrorCount: config.feedMirrors });
  if (!entries.length) return;

  const withIds = [];
  for (const entry of entries.slice(0, Math.max(10, config.maxTweetsPerCheck))) {
    const tid = extractId(entry);
    if (tid) withIds.push([tid, entry]);
  }
  if (!withIds.length) return;

  if (!account.last_id) {
    await updateLastId(env, username, withIds[0][0]);
    console.log(`Baseline @${username}: ${withIds[0][0]}`);
    return;
  }

  const fresh = withIds.filter(([tid]) => isNewerTweetId(tid, account.last_id));
  if (!fresh.length) return;

  const subs = await getSubsForUser(env, username);
  if (!subs.length) return;

  console.log(`@${username}: ${fresh.length} new tweets`);
  const selected = sortByTweetId(fresh.slice(0, config.maxTweetsPerCheck));

  for (const [tid, entry] of selected) {
    if (budget.remaining() < 4) {
      console.warn(`Budget low, postponing remaining tweets for @${username}`);
      break;
    }
    const content = await buildContent(env, username, entry, budget);
    if (!content) continue;
    if (!content.translation) await rememberTranslationFailure(env, content);
    const handled = await deliver(env, content, subs, budget);
    if (handled) await updateLastId(env, username, tid);
  }
}


// Keep the last translation failure in D1 so a card that arrives without a
// translation can be explained afterwards ("why is there no Persian text?").
async function rememberTranslationFailure(env, content) {
  const detail = {
    username: content.username,
    tweet: String(content.title || '').slice(0, 120),
    skipped: content.translationSkipped || null,
    failures: (content.translationFailures || []).slice(0, 4),
    ts: new Date().toISOString(),
  };
  console.warn('Translation missing:', JSON.stringify(detail));
  await setMeta(env, 'last_translation_failure', detail);
}

async function backfillTranslations(env, budget, config) {
  if (!dbEnabled(env)) return;
  const rows = await getTweetsMissingTranslation(env, config.backfillLimit);
  if (!rows.length) return;
  console.log(`Backfilling translations for ${rows.length} saved tweets`);
  for (const row of rows) {
    if (budget.remaining() < 2) break;
    const translation = await translateText(env, row.title, budget);
    if (translation && translation.trim()) {
      await updateTweetTranslation(env, row.id, translation.trim());
    }
    await sleep(400);
  }
}

async function maybeCleanup(env) {
  const now = new Date();
  // Once a day, on the 03:00 UTC cron run.
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
    await cleanup(env);
  }
}

export async function runCheckCycle(env) {
  if (!dbEnabled(env)) {
    console.error('D1 binding "DB" is missing — add a [[d1_databases]] block to wrangler.toml');
    return;
  }
  await ensureSchema(env);
  const config = botConfig(env);
  const budget = createBudget(config.subrequestBudget);

  const accounts = await pickAccountsForCheck(env, config.accountsPerCycle);
  console.log(`Cron: checking ${accounts.length} account(s), budget ${budget.limit}`);

  for (const account of accounts) {
    if (budget.remaining() < 4) break;
    try {
      await processAccount(env, account, budget);
    } catch (error) {
      console.error(`Error processing @${account.username}:`, error?.message || error);
    }
    await touchChecked(env, account.username);
  }

  await backfillTranslations(env, budget, config);
  await maybeCleanup(env);
  console.log(`Cron finished, subrequests used: ${budget.used}`);
}

/* ── Telegram UI copy ─────────────────────────────────────────────────── */

const WELCOME = [
  '👋 <b>سلام!</b>',
  '',
  'ربات فالوور توییتر/X',
  'بدون نیاز به API پولی — با RSS کار می‌کنه.',
  '',
  '📌 <b>دستورات:</b>',
  '/add username  — اضافه کردن',
  '/del username  — حذف کردن',
  '/list  — لیست اکانت‌ها',
  '/test  — تست سریع',
  '/search متن  — جستجو در توییت‌ها',
  '',
  '💡 از کیبورد پایین هم می‌تونی استفاده کنی.',
  '🔍 <b>Inline Mode:</b> از هر چتی بنویس <code>@رباتت متن</code>',
].join('\n');

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '➕ اضافه کردن' }, { text: '📋 لیست اکانت‌ها' }],
    [{ text: '🔍 جستجو' }, { text: '🌐 داشبورد' }],
    [{ text: '📊 وضعیت' }, { text: 'ℹ️ راهنما' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'نام کاربری توییتر رو بنویس...',
};

const BOT_COMMANDS = [
  { command: 'start', description: 'شروع و راهنما' },
  { command: 'add', description: 'اضافه کردن اکانت' },
  { command: 'del', description: 'حذف اکانت' },
  { command: 'list', description: 'لیست اکانت‌ها' },
  { command: 'test', description: 'تست سریع' },
  { command: 'search', description: 'جستجو در توییت‌ها' },
  { command: 'status', description: 'وضعیت ربات' },
];

function reply(env, chatId, text, options = {}) {
  return sendMessage(env, chatId, text, options);
}

async function replyList(env, chatId, budget) {
  if (!dbEnabled(env)) {
    await reply(env, chatId, '❌ دیتابیس D1 متصل نیست.');
    return;
  }
  const users = [...new Set(await getSubsForChat(env, chatId))].sort();
  if (!users.length) {
    await reply(env, chatId, '📋 لیست شما خالیه.');
    return;
  }
  const lines = users.map((user) => `• @${escapeHtml(user)}`);
  await reply(env, chatId, `📋 لیست شما (${lines.length}):\n\n${lines.join('\n')}`, { budget });
}

// "enabled" means configured, not "known reachable" — the fallback services
// are always listed, and only a real /test proves they answer.
function providerLabel(provider) {
  if (!provider.enabled) return '❌ تنظیم نشده';
  return '✅ در دسترس';
}

async function replyStatus(env, chatId, budget) {
  if (!dbEnabled(env)) {
    await reply(env, chatId, '❌ دیتابیس D1 متصل نیست.');
    return;
  }
  const users = await getSubsForChat(env, chatId);
  const tracked = await getAllTracked(env);
  const tweetCount = await countTweets(env);
  const missing = await countMissingTranslations(env);

  // Report what is actually configured instead of guessing from one key.
  const status = translationStatus(env);
  const byName = Object.fromEntries(status.providers.map((p) => [p.name, p]));
  const primary = byName[status.primary];
  const primaryLine = status.enabled
    ? primary?.name === 'ai'
      ? `✅ ${escapeHtml(primary.model || 'AI')}`
      : primary?.name === 'workers-ai'
        ? `✅ Workers AI (${escapeHtml(primary.model || '')})`
        : '⚠️ فقط fallback ها (رایگان ولی بی‌ثبات)'
    : '❌ خاموش (TRANSLATE_FA=false)';

  const lines = [
    '📊 <b>وضعیت ربات</b>',
    '',
    `🤖 <b>ترجمه:</b> ${primaryLine}`,
    `  • AI key: ${providerLabel(byName.ai)}`,
    `  • Workers AI: ${providerLabel(byName['workers-ai'])}`,
    `  • Google: ${providerLabel(byName['google-endpoint'])} <i>(fallback)</i>`,
    `  • MyMemory: ${providerLabel(byName.mymemory)} <i>(fallback)</i>`,
    `💾 <b>دیتابیس:</b> ✅ Cloudflare D1`,
    `📝 <b>توییت‌های ذخیره شده:</b> ${tweetCount}`,
    `🦁 <b>بدون ترجمه:</b> ${missing}`,
    `👤 <b>اکانت‌های شما:</b> ${new Set(users).size}`,
    `🌐 <b>اکانت‌های کل:</b> ${tracked.length}`,
    `⏱ <b>بررسی هر:</b> ${env.CHECK_INTERVAL || 300} ثانیه`,
  ];
  if (byName.ai.enabled && status.ai) {
    lines.push(`  ↳ کلید: ${escapeHtml(status.ai.keySource || 'نامشخص')} • مدل: ${escapeHtml(status.ai.model || '')}`);
  }
  if (!byName.ai.enabled && !byName['workers-ai'].enabled) {
    lines.push('', '💡 برای ترجمه باکیفیت: /setup یا یک GEMINI_API_KEY ست کن،', '   یا در wrangler.toml بخش [ai] را فعال کن.');
  }

  // Last real failure, so "why is there no Persian text?" has an answer.
  const lastFailure = await getMeta(env, 'last_translation_failure');
  if (lastFailure?.value) {
    const info = lastFailure.value;
    const reason = info.skipped
      ? info.skipped
      : (info.failures || []).map((f) => `${f.provider}: ${f.reason}`).join(' | ');
    lines.push('', `🕓 <b>آخرین خطای ترجمه</b> (${escapeHtml(String(lastFailure.updated_at || ''))})`, `<code>${escapeHtml(String(reason || 'نامشخص').slice(0, 220))}</code>`);
  }

  await reply(env, chatId, lines.join('\n'), { budget });
}

async function addAccounts(env, chatId, raw, budget) {
  if (!dbEnabled(env)) {
    await reply(env, chatId, '❌ دیتابیس D1 متصل نیست. اول با /setup دیتابیس رو بساز.');
    return;
  }
  const names = [...new Set(String(raw || '').split(/[\s,]+/).map(cleanUsername).filter(Boolean))];
  if (!names.length) {
    await reply(env, chatId, 'Usage: /add username1 username2');
    return;
  }
  const added = [];
  const skipped = [];
  for (const name of names) {
    if (!isValidTwitter(name) || (await isSubscribed(env, chatId, name))) {
      skipped.push(`@${escapeHtml(name)}`);
      continue;
    }
    await addSubscription(env, chatId, name, '');
    added.push(`@${escapeHtml(name)}`);
  }
  const parts = [];
  if (added.length) parts.push(`✅ اضافه شد: ${added.join(', ')}`);
  if (skipped.length) parts.push(`⏭ رد شد: ${skipped.join(', ')}`);
  await reply(env, chatId, parts.join('\n') || 'هیچی اضافه نشد.', { budget });
}

async function deleteAccounts(env, chatId, args, budget) {
  for (const arg of args) {
    await removeSubscription(env, chatId, cleanUsername(arg));
  }
  await reply(env, chatId, '✅ حذف شد.', { budget });
}

async function searchAndReply(env, chatId, query, budget) {
  if (!dbEnabled(env)) {
    await reply(env, chatId, '❌ دیتابیس D1 متصل نیست.');
    return;
  }
  const rows = await searchTweets(env, query, String(chatId), 5);
  if (!rows.length) {
    await reply(env, chatId, '🔍 نتیجه‌ای پیدا نشد.', { budget });
    return;
  }
  for (const row of rows) {
    let text = `🐦 @${escapeHtml(row.username)}:\n${escapeHtml(String(row.title || '').slice(0, 200))}`;
    if (row.translation) {
      text += `\n\n🦁 ${escapeHtml(String(row.translation).slice(0, 200))}`;
    }
    const keyboard = row.tweet_link
      ? { inline_keyboard: [[{ text: '🔗 View', url: row.tweet_link }]] }
      : undefined;
    await reply(env, chatId, text, { keyboard, budget });
  }
}

async function runTest(env, chatId, username, budget) {
  await reply(env, chatId, `🔍 تست @${escapeHtml(username)}...`, { budget });
  const entries = await fetchFeed(env, username, budget, { mirrorCount: botConfig(env).feedMirrors });
  if (!entries.length) {
    await reply(env, chatId, '❌ خطا در دریافت فید.', { budget });
    return;
  }
  const content = await buildContent(env, username, entries[0], budget);
  if (!content) {
    await reply(env, chatId, '⚠️ آیتم اول فید ریتوییت بود یا شناسه نداشت.', { budget });
    return;
  }
  await deliver(env, content, [String(chatId)], budget, true);

  // Translation problems are reported explicitly, otherwise a silent
  // fallback looks like "translation is off".
  if (!content.translation) {
    const reason = content.translationSkipped
      ? `دلیل: ${content.translationSkipped}`
      : content.translationFailures?.length
        ? content.translationFailures
            .map((failure) => `• ${failure.provider}: ${failure.reason}`)
            .join('\n')
        : 'دلیل نامشخص';
    await reply(
      env,
      chatId,
      `🦁 <b>ترجمه انجام نشد</b>\n${reason}\n\n💡 /status را ببین یا GEMINI_API_KEY ست کن.`,
      { budget }
    );
  }
}

/* ── Telegram updates ─────────────────────────────────────────────────── */

function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  return { command: rawCommand.slice(1).split('@')[0].toLowerCase(), args };
}

export async function handleUpdate(env, update, origin = '', budget = null) {
  if (!budget) budget = createBudget(botConfig(env).webhookBudget);
  const message = update?.message || update?.edited_message;
  const inlineQuery = update?.inline_query;

  if (inlineQuery) {
    if (!dbEnabled(env)) {
      await answerInlineQuery(env, inlineQuery.id, [], budget);
      return;
    }
    const query = String(inlineQuery.query || '').trim();
    if (query.length < 2) {
      await answerInlineQuery(env, inlineQuery.id, [], budget);
      return;
    }
    const rows = await searchTweets(env, query, null, 5);
    const results = rows.map((row, index) => {
      const safeTitle = escapeHtml(String(row.title || '')).slice(0, 300);
      const safeTranslation = escapeHtml(String(row.translation || '')).slice(0, 300);
      let text = `🐦 @${escapeHtml(row.username)}\n\n${safeTitle}`;
      if (safeTranslation) text += `\n\n🦁 ${safeTranslation}`;
      return {
        type: 'article',
        id: String(index),
        title: `@${row.username}: ${String(row.title || '').slice(0, 50)}...`,
        description: String(row.title || '').slice(0, 100),
        input_message_content: { message_text: text, parse_mode: 'HTML' },
        ...(row.tweet_link
          ? { reply_markup: { inline_keyboard: [[{ text: '🔗 View on X', url: row.tweet_link }]] } }
          : {}),
      };
    });
    await answerInlineQuery(env, inlineQuery.id, results, budget);
    return;
  }

  if (!message || !message.chat) return;
  const chatId = message.chat.id;
  const text = String(message.text || '').trim();
  if (!text) return;

  const dashboardUrl = env.DASHBOARD_URL || (origin ? `${origin}/` : '');
  const parsed = parseCommand(text);

  if (parsed) {
    const { command, args } = parsed;
    if (command === 'start' || command === 'help') {
      await reply(env, chatId, WELCOME, { keyboard: MAIN_KEYBOARD, budget });
    } else if (command === 'add') {
      await addAccounts(env, chatId, args.join(' '), budget);
    } else if (command === 'del' || command === 'remove') {
      if (!args.length) {
        await reply(env, chatId, 'Usage: /del username', { budget });
      } else {
        await deleteAccounts(env, chatId, args, budget);
      }
    } else if (command === 'list') {
      await replyList(env, chatId, budget);
    } else if (command === 'test') {
      const username = cleanUsername(args[0] || 'ElonMusk');
      await runTest(env, chatId, username, budget);
    } else if (command === 'search') {
      const query = args.join(' ').trim();
      if (!query) {
        await reply(env, chatId, '🔍 استفاده: /search متن جستجو', { budget });
      } else {
        await searchAndReply(env, chatId, query, budget);
      }
    } else if (command === 'status') {
      await replyStatus(env, chatId, budget);
    }
    return;
  }

  // Keyboard buttons (same labels as the Python bot).
  if (text === '➕ اضافه کردن') {
    await reply(env, chatId, '📝 یوزرنیم توییتر رو بنویس (مثلاً ElonMusk):', { budget });
    return;
  }
  if (text === '📋 لیست اکانت‌ها') {
    await replyList(env, chatId, budget);
    return;
  }
  if (text === '🔍 جستجو') {
    await reply(env, chatId, '🔍 متن جستجو رو بنویس:', { budget });
    return;
  }
  if (text === '🌐 داشبورد') {
    if (!dashboardUrl) {
      await reply(env, chatId, '🌐 داشبورد در دسترس نیست.', { budget });
      return;
    }
    await reply(env, chatId, '🌐 داشبورد لایو توییترها:', {
      keyboard: { inline_keyboard: [[{ text: '🌐 باز کردن داشبورد', url: dashboardUrl }]] },
      budget,
    });
    return;
  }
  if (text === '🔄 بروزرسانی') {
    await reply(env, chatId, '🔄 بروزرسانی شد! توییت‌های جدید بررسی می‌شن.', { budget });
    return;
  }
  if (text === '📊 وضعیت') {
    await replyStatus(env, chatId, budget);
    return;
  }
  if (text === 'ℹ️ راهنما') {
    await reply(env, chatId, WELCOME, { keyboard: MAIN_KEYBOARD, budget });
    return;
  }

  const candidate = cleanUsername(text);
  if (isValidTwitter(candidate)) {
    if (await isSubscribed(env, chatId, candidate)) {
      await reply(env, chatId, `⏭ @${escapeHtml(candidate)} قبلاً اضافه شده.`, { budget });
    } else {
      await addSubscription(env, chatId, candidate, '');
      await reply(env, chatId, `✅ @${escapeHtml(candidate)} اضافه شد!`, { budget });
    }
    return;
  }
  await searchAndReply(env, chatId, text, budget);
}

/* ── Dashboard assets ─────────────────────────────────────────────────── */

const MANIFEST_JSON = `{
  "name": "CryptoX Monitor",
  "short_name": "CryptoX",
  "description": "Twitter/X to Telegram Monitor",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "orientation": "portrait",
  "icons": [
    {
      "src": "https://cdn-icons-png.flaticon.com/512/733/733579.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}`;

const SERVICE_WORKER_JS = `const CACHE = 'cryptox-v4';
const PRECACHE = ['/', '/manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = e.request.url;
    // Live data must always hit the network — never serve stale tweets.
    if (url.includes('/api/') || url.includes('cdn.tailwindcss')) return;

    e.respondWith(
        fetch(e.request)
            .then(resp => {
                const clone = resp.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
                return resp;
            })
            .catch(() => caches.match(e.request))
    );
});
`;

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function tweetToJson(tweet) {
  return {
    username: tweet.username || '',
    title: tweet.title || '',
    translation: tweet.translation || '',
    img_url: tweet.img_url || '',
    tweet_link: tweet.tweet_link || '',
    created_at: tweet.created_at || null,
  };
}

/* ── HTTP routes ──────────────────────────────────────────────────────── */

async function handleWebhook(request, env, ctx) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (provided !== secret) {
      return new Response('forbidden', { status: 403 });
    }
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const origin = new URL(request.url).origin;
  ctx.waitUntil(
    (async () => {
      try {
        await ensureSchema(env);
        await handleUpdate(env, update, origin);
      } catch (error) {
        console.error('Update handling failed:', error?.stack || error);
      }
    })()
  );
  return new Response('ok');
}

async function handleSetup(request, env) {
  const url = new URL(request.url);
  // Secrets are typed by hand, so a stray space or newline is the single most
  // common reason /setup "rejects" a key that looks identical.
  const provided = String(url.searchParams.get('key') || request.headers.get('X-Setup-Key') || '').trim();
  const expected = String(env.SETUP_KEY || '').trim();

  if (!expected) {
    return jsonResponse(
      {
        ok: false,
        error: 'SETUP_KEY is not configured',
        hint: 'Run: npx wrangler secret put SETUP_KEY',
      },
      400
    );
  }

  if (provided !== expected) {
    const diagnosis = { ok: false, error: 'invalid setup key' };
    if (!provided) diagnosis.hint = 'Add ?key=<SETUP_KEY> to the URL or send an X-Setup-Key header.';
    else if (provided.toLowerCase() === expected.toLowerCase()) diagnosis.hint = 'The key matches except for letter case.';
    else if (provided.length !== expected.length) diagnosis.hint = `Key length differs (sent ${provided.length}, stored ${expected.length}).`;
    else diagnosis.hint = 'The key differs from the stored secret. Set a new one with: npx wrangler secret put SETUP_KEY';
    if (expected !== String(env.SETUP_KEY)) {
      diagnosis.hint += ' (Your stored SETUP_KEY has leading/trailing whitespace — it is compared trimmed.)';
    }
    return jsonResponse(diagnosis, 403);
  }

  const result = { ok: true, steps: [] };
  const schemaOk = await ensureSchema(env);
  result.steps.push({ step: 'database', ok: schemaOk });

  const me = await getMe(env);
  result.steps.push({
    step: 'getMe',
    ok: Boolean(me.ok),
    username: me.result?.username,
    ...(me.ok ? {} : { error: me.description, error_code: me.error_code }),
  });

  const commands = await setMyCommands(env, BOT_COMMANDS);
  result.steps.push({
    step: 'setMyCommands',
    ok: Boolean(commands.ok),
    ...(commands.ok ? {} : { error: commands.description, error_code: commands.error_code }),
  });

  const origin = url.origin;
  const secretToken = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const secretError = validateWebhookSecret(secretToken);

  if (secretError) {
    // Rejected locally with a readable reason instead of Telegram's opaque 400.
    result.steps.push({ step: 'webhookSecret', ok: false, error: secretError });
    const plain = await setWebhook(env, `${origin}/telegram`, '');
    result.steps.push({
      step: 'setWebhook',
      ok: Boolean(plain.ok),
      url: `${origin}/telegram`,
      note: 'Registered WITHOUT secret_token. The Worker still expects a secret, so requests will be rejected until it is fixed or removed.',
      ...(plain.ok ? {} : { error: plain.description, error_code: plain.error_code }),
    });
  } else {
    const webhook = await setWebhook(env, `${origin}/telegram`, secretToken);
    result.steps.push({
      step: 'setWebhook',
      ok: Boolean(webhook.ok),
      url: `${origin}/telegram`,
      ...(webhook.ok ? {} : { error: webhook.description, error_code: webhook.error_code }),
    });
    if (secretToken) result.steps.push({ step: 'webhookSecret', ok: true });
  }

  // Always report the webhook state, even when the lookup itself failed —
  // otherwise a silent bot has no diagnostic at all.
  const info = await getWebhookInfo(env);
  result.webhook = info.ok
    ? {
        configured: Boolean(info.result?.url),
        url: info.result?.url || '',
        pending_updates: info.result?.pending_update_count ?? 0,
        last_error: info.result?.last_error_message || null,
        last_error_at: info.result?.last_error_date || null,
      }
    : { configured: false, error: info.description || 'getWebhookInfo failed' };

  const translation = translationStatus(env);
  result.translation = {
    enabled: translation.enabled,
    primary: translation.primary,
    note:
      translation.primary === 'google-endpoint'
        ? 'No AI key and no Workers AI binding: translation will use the free Google/MyMemory fallbacks.'
        : undefined,
  };

  result.dashboard = `${origin}/`;
  result.ok = result.steps.every((step) => step.ok !== false);

  if (result.ok) {
    // Save the operator a trip to the README.
    result.next_steps = [
      `Open Telegram and send /start to @${me.result?.username || 'your bot'}`,
      'Send /add <username> to follow an account (e.g. /add nasa)',
      translation.primary === 'google-endpoint'
        ? 'Translation quality: add GEMINI_API_KEY or enable the [ai] binding, then re-check /status'
        : `Translation is using ${translation.primary}`,
      'First cron run only records a baseline; new tweets arrive within ~10 minutes',
      'Check /health any time to see the webhook and translation state',
    ];
  } else {
    result.hint = 'Check the "error" field of each failing step. If setWebhook failed with "secret token contains unallowed characters", set TELEGRAM_WEBHOOK_SECRET to only A-Z a-z 0-9 _ - (or delete it).';
  }
  return jsonResponse(result, result.ok ? 200 : 500);
}


// Live translation probe: runs the real provider chain on a sample sentence
// and returns exactly what happened. Solves the "I set an API key but nothing
// is translated" loop, since every provider's reason is included.
async function handleTranslateTest(request, env, url) {
  const key = String(url.searchParams.get('key') || request.headers.get('X-Setup-Key') || '').trim();
  if (!String(env.SETUP_KEY || '').trim() || key !== String(env.SETUP_KEY).trim()) {
    return jsonResponse({ ok: false, error: 'invalid setup key' }, 403);
  }

  // The probe writes its result to bot_meta, so the schema must exist even on
  // a fresh deployment where /setup was never called.
  await ensureSchema(env);

  const sample =
    String(url.searchParams.get('q') || '').trim() ||
    'Hello world, this is a translation test from XRelaya.';

  const status = translationStatus(env);
  const budget = createBudget(botConfig(env).webhookBudget);
  const detail = await translateDetailed(env, sample, budget);

  const ok = Boolean(detail.translation);
  if (!ok) await setMeta(env, 'last_translation_failure', {
    username: 'translate-test',
    tweet: sample.slice(0, 120),
    skipped: detail.skipped || null,
    failures: detail.failures,
    ts: new Date().toISOString(),
  });

  return jsonResponse(
    {
      ok,
      input: sample,
      translation: detail.translation || null,
      provider: detail.provider || null,
      skipped: detail.skipped || null,
      failures: detail.failures,
      config: status.ai || { keySource: null, provider: null, model: null },
      hint: ok
        ? 'Translation works. New tweets will include the Persian text.'
        : 'No provider produced a translation. Fix the first failure listed above, or set GEMINI_API_KEY / enable the [ai] binding.',
    },
    ok ? 200 : 502
  );
}

async function handleHealth(env) {
  const translation = translationStatus(env);
  const secretError = validateWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
  // Secrets can never be read back, so at least report whether one exists and
  // how long it is — that is enough to recognise the key you set and matches
  // the diagnostic /setup already returns for a wrong key.
  const setupKey = {
    configured: Boolean(String(env.SETUP_KEY || '').trim()),
    length: String(env.SETUP_KEY || '').trim().length,
  };

  if (!dbEnabled(env)) {
    return jsonResponse(
      { ok: false, error: 'D1 binding missing', setupKey, translation, webhookSecret: secretError || 'ok' },
      500
    );
  }
  await ensureSchema(env);
  const [accounts, tweets] = await Promise.all([getAllTracked(env), countTweets(env)]);
  const lastTranslationFailure = await getMeta(env, 'last_translation_failure');

  // Tell the truth about the delivery path: a webhook that was never
  // registered is the single most common reason the bot stays silent.
  const info = env.TELEGRAM_BOT_TOKEN ? await getWebhookInfo(env) : { ok: false };
  const webhook = info.ok
    ? {
        configured: Boolean(info.result?.url),
        url: info.result?.url || '',
        pending_updates: info.result?.pending_update_count ?? 0,
        last_error: info.result?.last_error_message || null,
      }
    : { configured: false, error: info.description || 'getWebhookInfo failed' };

  const ok = Boolean(env.TELEGRAM_BOT_TOKEN) && webhook.configured && !secretError;
  return jsonResponse({
    ok,
    botToken: Boolean(env.TELEGRAM_BOT_TOKEN),
    setupKey,
    webhook,
    webhookSecret: secretError || 'ok',
    trackedAccounts: accounts.length,
    savedTweets: tweets,
    translation,
    lastTranslationFailure,
    ts: new Date().toISOString(),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'POST' && (path === '/telegram' || path === '/webhook')) {
      return handleWebhook(request, env, ctx);
    }

    if (path === '/setup') return handleSetup(request, env);
    if (path === '/health') return handleHealth(env);
    if (path === '/translate') return handleTranslateTest(request, env, url);

    if (path === '/api/tweets') {
      if (!dbEnabled(env)) return jsonResponse({ tweets: [], error: 'D1 missing' });
      await ensureSchema(env);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const tweets = await getLatestTweets(env, limit);
      return jsonResponse({ tweets: tweets.map(tweetToJson), ts: new Date().toISOString() });
    }

    if (path === '/api/search') {
      const query = url.searchParams.get('q') || '';
      if (!query.trim()) return jsonResponse({ tweets: [] });
      const rows = await searchTweets(env, query, null, 10);
      return jsonResponse({ tweets: rows.map(tweetToJson) });
    }

    if (path === '/manifest.json') {
      return new Response(MANIFEST_JSON, {
        headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
      });
    }

    if (path === '/sw.js') {
      return new Response(SERVICE_WORKER_JS, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (path === '/' || path === '/index.html' || path === '/dashboard') {
      return htmlResponse(dashboardHtml);
    }

    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // Convenience: /set-webhook /del-webhook from the browser, still key-gated.
    if (path === '/del-webhook') {
      const key = String(url.searchParams.get('key') || request.headers.get('X-Setup-Key') || '').trim();
      if (!env.SETUP_KEY || key !== String(env.SETUP_KEY).trim()) {
        return jsonResponse({ ok: false, error: 'invalid setup key' }, 403);
      }
      return jsonResponse(await deleteWebhook(env));
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await runCheckCycle(env);
        } catch (error) {
          console.error('Cron run failed:', error?.stack || error);
        }
      })()
    );
  },
};
