// Minimal Telegram Bot API client for Workers (plain fetch, no SDK).

import { budgetFetch } from './budget.js';

const API_ROOT = 'https://api.telegram.org';

// TELEGRAM_API_BASE allows pointing at a self-hosted Bot API server (or a local
// mock during development); it defaults to the official endpoint.
function apiRoot(env) {
  return String(env?.TELEGRAM_API_BASE || API_ROOT).replace(/\/+$/, '');
}

function apiUrl(env, method) {
  return `${apiRoot(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function tgCall(env, method, payload, budget = null) {
  if (!env?.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is not configured');
    return { ok: false, description: 'missing bot token' };
  }
  try {
    const response = await budgetFetch(budget, apiUrl(env, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response) return { ok: false, description: 'subrequest budget exhausted' };
    const data = await response.json().catch(() => ({ ok: response.ok }));
    if (!data.ok) {
      console.warn(`Telegram ${method} failed:`, data.error_code, data.description);
    }
    return data;
  } catch (error) {
    console.error(`Telegram ${method} threw:`, error?.message || error);
    return { ok: false, description: String(error?.message || error) };
  }
}

export function sendMessage(env, chatId, text, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode === undefined ? 'HTML' : options.parseMode,
    disable_web_page_preview: options.disablePreview === true,
  };
  if (options.keyboard) payload.reply_markup = options.keyboard;
  return tgCall(env, 'sendMessage', payload, options.budget || null);
}

export function answerInlineQuery(env, inlineQueryId, results, budget = null) {
  return tgCall(
    env,
    'answerInlineQuery',
    { inline_query_id: inlineQueryId, results, cache_time: 300, is_persistent: true },
    budget
  );
}

export function setMyCommands(env, commands, budget = null) {
  return tgCall(env, 'setMyCommands', { commands }, budget);
}

// Telegram accepts only A-Z a-z 0-9 _ - in secret_token. Anything else makes
// setWebhook fail with an opaque "Bad Request", which is very hard to debug
// from the outside — so reject it locally with a readable reason first.
const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateWebhookSecret(secretToken) {
  const value = String(secretToken || '');
  if (!value) return null;
  if (value !== value.trim()) {
    return 'TELEGRAM_WEBHOOK_SECRET has leading/trailing whitespace. Re-set it with: npx wrangler secret put TELEGRAM_WEBHOOK_SECRET';
  }
  if (!SECRET_TOKEN_PATTERN.test(value)) {
    const bad = [...new Set(value.split('').filter((char) => !/[A-Za-z0-9_-]/.test(char)))];
    return `TELEGRAM_WEBHOOK_SECRET contains characters Telegram rejects: ${bad.join(' ')}. Only A-Z a-z 0-9 _ - are allowed.`;
  }
  if (value.length > 256) return 'TELEGRAM_WEBHOOK_SECRET is longer than 256 characters.';
  return null;
}

export function setWebhook(env, url, secretToken, budget = null) {
  const payload = {
    url,
    allowed_updates: ['message', 'edited_message', 'inline_query'],
    drop_pending_updates: true,
  };
  if (secretToken) payload.secret_token = secretToken;
  return tgCall(env, 'setWebhook', payload, budget);
}

export function getWebhookInfo(env, budget = null) {
  return tgCall(env, 'getWebhookInfo', {}, budget);
}

export function deleteWebhook(env, budget = null) {
  return tgCall(env, 'deleteWebhook', { drop_pending_updates: true }, budget);
}

export function getMe(env, budget = null) {
  return tgCall(env, 'getMe', {}, budget);
}

// Download tweet media locally so Telegram does not have to reach pbs.twimg.com
// itself (its fetchers are often blocked, which used to turn photo tweets into
// plain text).
export async function downloadImage(env, url, budget = null, timeoutMs = 20000) {
  if (!url || !/^https?:\/\//i.test(String(url))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await budgetFetch(budget, url, { redirect: 'follow', signal: controller.signal });
    if (!response || response.status !== 200) return null;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
      return null;
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > 20 * 1024 * 1024) return null;
    return { bytes: buffer, type: contentType || 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function keyboardJson(keyboard) {
  return keyboard ? JSON.stringify(keyboard) : undefined;
}

// Send a photo card. Prefers an uploaded file (downloaded bytes), falls back
// to letting Telegram fetch the URL when the download failed.
export async function sendPhoto(env, chatId, options = {}) {
  const { photo, photoUrl, caption, keyboard, budget = null } = options;
  const markup = keyboardJson(keyboard);

  if (photo?.bytes) {
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', caption || '');
      form.append('parse_mode', 'HTML');
      if (markup) form.append('reply_markup', markup);
      const extension = photo.type.includes('png') ? 'png' : 'jpg';
      form.append('photo', new Blob([photo.bytes], { type: photo.type || 'image/jpeg' }), `tweet.${extension}`);

      const response = await budgetFetch(budget, apiUrl(env, 'sendPhoto'), { method: 'POST', body: form });
      if (!response) return false;
      const data = await response.json().catch(() => ({ ok: response.ok }));
      if (!data.ok) console.warn('Telegram sendPhoto (upload) failed:', data.error_code, data.description);
      return Boolean(data.ok);
    } catch (error) {
      console.error('Telegram sendPhoto upload threw:', error?.message || error);
      return false;
    }
  }

  if (!photoUrl) return false;
  const data = await tgCall(
    env,
    'sendPhoto',
    {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption || '',
      parse_mode: 'HTML',
      ...(markup ? { reply_markup: keyboard } : {}),
    },
    budget
  );
  return Boolean(data.ok);
}
