// RSS parsing + the retweet/repost filter.
//
// The Python bot uses feedparser; Workers have no such luxury, so this file
// contains a small purpose-built parser for the RSS shapes Nitter mirrors and
// RSS bridges emit, plus a faithful port of `retweet_reason()` and its
// helpers (display names must never be mistaken for handles).

import { cleanTweetText, htmlUnescape } from './text.js';
import { budgetFetch } from './budget.js';

export const RSS_SOURCES = [
  'https://nitter.net/{username}/rss',
  'https://xcancel.com/{username}/rss',
  'https://nitter.perennialte.ch/{username}/rss',
  'https://nitter.privacydev.net/{username}/rss',
  'https://lightbrd.com/{username}/rss',
  'https://nitter.poast.org/{username}/rss',
  'https://nitter.cz/{username}/rss',
  'https://nitter.netbub.com/{username}/rss',
];

export const RSS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
};

const USERNAME_RESERVED = new Set([
  'i',
  'status',
  'statuses',
  'home',
  'explore',
  'search',
  'intent',
  'share',
]);

/* ── Username helpers ─────────────────────────────────────────────────── */

export function cleanUsername(raw) {
  let value = String(raw ?? '').trim().toLowerCase();
  value = value.replace(/https?:\/\//g, '');
  for (const domain of ['x.com/', 'twitter.com/', 'nitter.net/', 'xcancel.com/', 'uni-sonia.com/']) {
    value = value.split(domain).join('');
  }
  return value
    .replace(/^@+/, '')
    .split('?')[0]
    .split('/')[0]
    .trim();
}

export function isValidTwitter(username) {
  return /^[a-z0-9_]{1,15}$/.test(String(username ?? ''));
}

function handleOrEmpty(candidate) {
  const username = cleanUsername(candidate);
  if (!username || USERNAME_RESERVED.has(username)) return '';
  return isValidTwitter(username) ? username : '';
}

/* ── Tweet ids and links ──────────────────────────────────────────────── */

export function extractId(entry) {
  for (const key of ['id', 'guid', 'link']) {
    const value = String(entry?.[key] ?? '');
    let match = value.match(/status(?:es)?\/(\d+)/);
    if (match) return match[1];
    match = value.match(/(\d{17,})/);
    if (match) return match[1];
  }
  const tail = String(entry?.id ?? '');
  const last = tail.match(/(\d+)$/);
  if (last && last[1].length >= 10) return last[1];
  return null;
}

export function extractTweetIdFromLink(link) {
  const value = String(link ?? '');
  let match = value.match(/status(?:es)?\/(\d+)/);
  if (match) return match[1];
  match = value.match(/(\d{17,})/);
  return match ? match[1] : null;
}

export function isNewerTweetId(tweetId, lastId) {
  if (!lastId) return true;
  try {
    return BigInt(String(tweetId)) > BigInt(String(lastId));
  } catch {
    return String(tweetId) > String(lastId);
  }
}

export function extractLinkUsername(entry) {
  for (const key of ['link', 'id', 'guid']) {
    const value = String(entry?.[key] ?? '');
    const match = value.match(/(?:https?:\/\/[^/]+)?\/([^/?#]+)\/status(?:es)?\/\d+/i);
    if (!match) continue;
    const username = handleOrEmpty(match[1]);
    if (username) return username;
  }
  return null;
}

/* ── Author fields ────────────────────────────────────────────────────── */

function authorFields(entry) {
  const candidates = [entry.author, entry.dc_creator, entry.creator];
  const detail = entry.author_detail;
  if (detail && typeof detail === 'object') {
    candidates.push(detail.name, detail.href, detail.email);
  }
  for (const author of entry.authors || []) {
    if (author && typeof author === 'object') {
      candidates.push(author.name, author.href, author.email);
    } else {
      candidates.push(author);
    }
  }
  return candidates;
}

// Read a handle out of a feed field such as `<author>` or `<dc:creator>`.
// Returns [username, explicit]; only an `@name`, an `email (name)` author or a
// profile/status URL is explicit. A bare token ("RippleX") is a weak hint that
// can confirm the expected account but must never accuse another one.
export function usernameFromText(value) {
  const text = htmlUnescape(String(value ?? '')).trim();
  if (!text) return ['', false];

  const email = text.match(/(?<![A-Za-z0-9_])([A-Za-z0-9_]{1,15})@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) return [handleOrEmpty(email[1]), true];

  const mention = text.match(/(?<![\w.@])@([A-Za-z0-9_]{1,15})/);
  if (mention) return [handleOrEmpty(mention[1]), true];

  for (const pattern of [
    /(?:https?:\/\/[^/]+)?\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/\d+/i,
    /(?:https?:\/\/[^/]+)?\/([A-Za-z0-9_]{1,15})\/?$/i,
  ]) {
    const ref = text.match(pattern);
    if (!ref) continue;
    const username = handleOrEmpty(ref[1]);
    if (username) return [username, true];
  }

  if (/\s/.test(text)) return ['', false];
  return [handleOrEmpty(text), false];
}

export function extractAuthorUsername(entry) {
  let weak = ['', false];
  for (const value of authorFields(entry)) {
    const [username, explicit] = usernameFromText(value);
    if (!username) continue;
    if (explicit) return [username, true];
    if (!weak[0]) weak = [username, false];
  }
  return weak;
}

/* ── Retweet / repost filter ──────────────────────────────────────────── */

const EMBEDDED_BLOCK_RE = /<(?:blockquote|hr)\b|class=["'][^"']*\bquote\b/i;

function ownItemText(entry) {
  const raw = ['title', 'description', 'summary']
    .map((key) => String(entry?.[key] ?? ''))
    .join('\n');
  const match = raw.match(EMBEDDED_BLOCK_RE);
  return match ? raw.slice(0, match.index) : raw;
}

// Note: Python's `\b` knows about Persian letters, JavaScript's does not, so
// the banner patterns end with explicit lookaheads instead of `\b`.
const BANNER_PATTERNS = [
  /^\s*rt\s+(?:by\s+)?@?[a-z0-9_]{1,15}(?=\s|$|[:,.!])/im,
  /^\s*rt\s*[:\-]/im,
  /^\s*[[(]\s*rt\s*[\])]/im,
  /^\s*(?:retweet|repost)(?:ed)?(?:\s+by)?(?=\s|$|:)/im,
  /^\s*@?[a-z0-9_]{1,15}\s+(?:retweeted|reposted)(?=\s|$|:)/im,
  /^\s*(?:@?[a-z0-9_]{1,15}\s+)?(?:retweeted|reposted)\s+by\s+@/im,
  /^\s*(?:بازتوییت|ریتوییت)(?=\s|$|:)/im,
];

const RETWEET_TAGS = new Set(['rt', 'retweet', 'repost']);

// Why an entry looks like a retweet instead of a tweet by `username`, else null.
// Returning the reason keeps the filter debuggable in `wrangler tail`.
export function retweetReason(entry, username) {
  const ownRaw = ownItemText(entry);
  const ownLower = ownRaw.toLowerCase();

  if (ownLower.includes('retweet-header') || ownLower.includes('retweet_header')) {
    return 'retweet-header markup';
  }
  if (/class=["'][^"']*\bretweet\b[^"']*["']/i.test(ownRaw)) {
    return 'retweet css class';
  }

  for (const field of [entry?.tags || [], entry?.categories || []]) {
    for (const tag of field) {
      const term = tag && typeof tag === 'object' ? tag.term || tag.label : String(tag ?? '');
      if (term && RETWEET_TAGS.has(String(term).trim().toLowerCase())) return 'retweet tag';
    }
  }

  const cleaned = cleanTweetText(ownRaw).toLowerCase();
  if (BANNER_PATTERNS.some((pattern) => pattern.test(cleaned))) return 'retweet banner text';

  const expected = username ? handleOrEmpty(username) : '';
  if (!expected) return null;

  const linkUsername = extractLinkUsername(entry);
  if (linkUsername) {
    return linkUsername !== expected ? `status link is @${linkUsername}` : null;
  }

  const [authorUsername, authorExplicit] = extractAuthorUsername(entry);
  if (authorExplicit && authorUsername !== expected) return `author @${authorUsername}`;
  return null;
}

export function isRetweet(entry, username) {
  return retweetReason(entry, username) !== null;
}

/* ── Tweet text and media ─────────────────────────────────────────────── */

export function extractTweetText(entry) {
  for (const key of ['title', 'summary', 'description']) {
    const text = cleanTweetText(entry?.[key] ?? '');
    // RSS descriptions can be media-only HTML; prefer the first real text.
    if (/[\p{L}\p{N}]/u.test(text)) return text;
  }
  return '';
}

export function extractImageUrl(entry) {
  const candidates = [];
  const ok = (url) => {
    const value = String(url ?? '').toLowerCase();
    return value.startsWith('http') && !value.includes('profile_images');
  };

  for (const media of entry?.media_content || []) {
    const url = media && typeof media === 'object' ? media.url : null;
    if (url && ok(url) && (url.includes('pbs.twimg.com') || url.includes('media'))) {
      candidates.push(url);
    }
  }

  const description = entry?.description || entry?.summary || '';
  for (const match of String(description).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (raw.includes('profile_images') || raw.includes('profile_images%2F')) continue;
    if (raw.includes('/pic/media%2F')) {
      const mediaId = raw.split('%2F').pop().split('?')[0];
      candidates.push(`https://pbs.twimg.com/media/${mediaId}?format=jpg&name=large`);
    } else if (ok(raw) && raw.toLowerCase().includes('media')) {
      candidates.push(raw);
    }
  }

  return candidates[0] || null;
}

/* ── Minimal RSS / Atom parser ────────────────────────────────────────── */

function unwrapCdata(value) {
  return String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagText(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) {
      const value = unwrapCdata(match[1]).trim();
      if (value) return value;
    }
  }
  return '';
}

function attrValue(tag, attr) {
  const match = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? match[1] : '';
}

function selfClosingTags(block, names) {
  const tags = [];
  for (const name of names) {
    const regex = new RegExp(`<${name}\\b[^>]*\\/?>`, 'gi');
    for (const match of block.matchAll(regex)) tags.push(match[0]);
  }
  return tags;
}

export function resolveUrl(value, baseUrl) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

// Pull absolute URLs out of `<img>` tags so the media extractor can use them.
function absolutizeImages(html, baseUrl) {
  return String(html ?? '').replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (match, pre, src, post) => {
    return pre + resolveUrl(src, baseUrl) + post;
  });
}

export function parseFeed(xml, feedUrl = '') {
  const text = String(xml ?? '');
  const entries = [];
  const itemRegex = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of text.matchAll(itemRegex)) {
    const block = match[2];
    const entry = {};

    const title = tagText(block, ['title']);
    if (title) entry.title = unwrapCdata(title);

    let link = tagText(block, ['link']);
    if (!link) {
      const linkTag = selfClosingTags(block, ['link'])[0];
      if (linkTag) link = attrValue(linkTag, 'href');
    }
    if (link) {
      entry.link = unwrapCdata(link).
        trim();
    }

    const guid = tagText(block, ['guid', 'id']);
    if (guid) {
      entry.guid = unwrapCdata(guid).trim();
      entry.id = entry.guid;
    }

    const description = tagText(block, ['content:encoded', 'description', 'content', 'summary']);
    if (description) {
      entry.description = absolutizeImages(description, feedUrl);
      entry.summary = entry.description;
    }

    const author = tagText(block, ['author', 'dc:creator']);
    if (author) entry.author = unwrapCdata(author).trim();
    const dcCreator = tagText(block, ['dc:creator']);
    if (dcCreator) entry.dc_creator = unwrapCdata(dcCreator).trim();

    const pubDate = tagText(block, ['pubDate', 'published', 'updated', 'dc:date']);
    if (pubDate) entry.pubDate = pubDate;

    const tags = [];
    for (const tag of selfClosingTags(block, ['category'])) {
      const term = attrValue(tag, 'term');
      tags.push({ term: term || '' });
    }
    for (const tagMatch of block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)) {
      const value = unwrapCdata(tagMatch[1]).trim();
      if (value) tags.push({ term: value });
    }
    if (tags.length) entry.tags = tags;

    const media = [];
    for (const tag of selfClosingTags(block, ['media:content', 'media:thumbnail', 'enclosure'])) {
      const url = attrValue(tag, 'url');
      if (url) media.push({ url: resolveUrl(url, feedUrl) });
    }
    if (media.length) entry.media_content = media;

    entries.push(entry);
  }

  return entries;
}

/* ── Feed fetching ────────────────────────────────────────────────────── */

async function tryFeedInstance(budget, url, targetUsername, controller) {
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await budgetFetch(
      budget,
      url,
      {
        headers: RSS_HEADERS,
        redirect: 'follow',
        signal: controller.signal,
      },
      1
    );
    if (!response) return null;
    if (response.status !== 200) return null;
    if (String(response.url || '').includes('uni-sonia')) return null;

    const body = await response.text();
    const parsed = parseFeed(body, response.url || url);

    const valid = [];
    let usable = false;
    let skippedRetweets = 0;
    for (const entry of parsed) {
      const id = extractId(entry);
      if (!id) continue;
      usable = true;
      const reason = retweetReason(entry, targetUsername);
      if (reason) {
        skippedRetweets += 1;
        continue;
      }
      valid.push(entry);
    }
    if (skippedRetweets) {
      console.log(`Skipped ${skippedRetweets} reposts for @${targetUsername}`);
    }
    // A parsed feed is a complete answer even when it only held reposts.
    return usable ? valid : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Resolve with the first non-null result. `undefined` means every mirror in
// the batch failed; an empty array is a real answer ("feed has no originals").
async function firstUsable(promises, controllers) {
  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;
    if (!pending) {
      resolve(undefined);
      return;
    }
    promises.forEach((promise, index) => {
      promise
        .then((value) => {
          if (value !== null && value !== undefined && !settled) {
            settled = true;
            controllers.forEach((controller, other) => {
              if (other !== index) controller.abort();
            });
            resolve(value);
          }
        })
        .catch(() => {})
        .finally(() => {
          pending -= 1;
          if (pending === 0 && !settled) {
            settled = true;
            resolve(undefined);
          }
        });
    });
  });
}

// Users can override the mirror list without touching code, because Nitter
// instances come and go: RSS_MIRRORS="https://a/{username}/rss,https://b/{username}/rss"
export function mirrorList(env) {
  const custom = String(env?.RSS_MIRRORS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return custom.length ? custom : RSS_SOURCES;
}

// Query Nitter mirrors in small parallel batches; the first usable feed wins.
export async function fetchFeed(env, username, budget, options = {}) {
  const target = cleanUsername(username);
  const mirrorCount = Math.max(1, Number(options.mirrorCount || env?.FEED_MIRRORS || 6));
  const sources = mirrorList(env).slice(0, mirrorCount);
  const batchSize = Math.max(1, Math.min(3, Number(env?.FEED_BATCH || 3)));

  for (let index = 0; index < sources.length; index += batchSize) {
    if (budget && budget.remaining() < 1) break;
    const batch = sources.slice(index, index + batchSize);
    const controllers = batch.map(() => new AbortController());
    const tasks = batch.map((source, offset) =>
      tryFeedInstance(budget, source.replace('{username}', target), target, controllers[offset])
    );
    const result = await firstUsable(tasks, controllers);
    if (Array.isArray(result)) return result;
  }
  return [];
}
