// Persian translation with graceful fallbacks, mirroring translate_text() in
// twitter_telegram_bot.py. Providers, in order:
//   1. Any OpenAI-compatible AI endpoint (Gemini / OpenAI / Requesty)
//   2. Cloudflare Workers AI (free, no API key — needs the [ai] binding)
//   3. Google's unofficial translate endpoint
//   4. MyMemory (non-Google fallback)
//
// Empty results are never cached: a provider outage must not leave a tweet
// permanently untranslated.

import {
  chunkText,
  cleanTweetText,
  hasTextToTranslate,
  trimTranslation,
} from './text.js';
import { budgetFetch } from './budget.js';

const PLACEHOLDER_API_KEYS = new Set([
  'key',
  'your_key',
  'your_api_key',
  'your_gemini_api_key',
  'your_requesty_or_gemini_key',
]);

const translationsCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function cleanApiKey(value) {
  const key = String(value ?? '').trim();
  return PLACEHOLDER_API_KEYS.has(key.toLowerCase()) ? '' : key;
}

function isTruthy(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function translationConfig(env = {}) {
  const geminiKey = cleanApiKey(env.GEMINI_API_KEY);
  const openaiKey = cleanApiKey(env.OPENAI_API_KEY);
  const apiKey = cleanApiKey(env.REQUESTY_API_KEY) || geminiKey || openaiKey;

  let baseUrl;
  if (env.REQUESTY_BASE_URL) {
    baseUrl = String(env.REQUESTY_BASE_URL).trim().replace(/\/+$/, '');
  } else if (geminiKey && apiKey === geminiKey) {
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
  } else if (openaiKey && apiKey === openaiKey) {
    baseUrl = 'https://api.openai.com/v1';
  } else {
    baseUrl = 'https://api.17.wtf/v1';
  }

  let model;
  if (env.REQUESTY_MODEL) {
    model = String(env.REQUESTY_MODEL).trim();
  } else if (geminiKey && apiKey === geminiKey) {
    model = 'gemini-2.0-flash';
  } else if (openaiKey && apiKey === openaiKey) {
    model = 'gpt-4o-mini';
  } else {
    model = 'posiden/deepseek-v4-flash';
  }

  return {
    apiKey,
    baseUrl,
    model,
    translateFa: isTruthy(env.TRANSLATE_FA, true),
    timeoutMs: positiveNumber(env.TRANSLATION_TIMEOUT, 20) * 1000,
    retries: Math.max(1, Math.floor(positiveNumber(env.TRANSLATION_RETRIES, 2))),
    mymemorySourceLang: String(env.MYMEMORY_SOURCE_LANG || 'en').trim() || 'en',
    mymemoryEmail: String(env.MYMEMORY_EMAIL || '').trim(),
  };
}

function cacheGet(key) {
  const value = translationsCache.get(key);
  if (value && value.trim()) return value;
  translationsCache.delete(key);
  return '';
}

function cacheSet(key, value) {
  if (!value || !value.trim()) return;
  if (translationsCache.size >= MAX_CACHE_ENTRIES) translationsCache.clear();
  translationsCache.set(key, value);
}

// Tiny FNV-1a hash; enough to key the in-memory cache without the WebCrypto
// ceremony (and without keeping full tweets in memory for long).
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + '-' + text.length.toString(36);
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object') return String(item.text ?? item.content ?? '');
        return String(item ?? '');
      })
      .join('');
  }
  return String(content ?? '');
}

async function withTimeout(timeoutMs, runner) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await runner(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function viaChatApi(config, text, budget) {
  if (!config.apiKey) return '';
  const base = /\/v\d/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/v1`;
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          "You are a reliable translation engine. Translate the user's tweet to natural, " +
          'colloquial Persian. Keep crypto symbols, tickers, hashtags, usernames, URLs, ' +
          'and product names in English. Return only the Persian translation; no notes.',
      },
      { role: 'user', content: text },
    ],
    temperature: 0.2,
  };
  const response = await withTimeout(config.timeoutMs, (signal) =>
    budgetFetch(budget, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  );
  if (!response) return '';
  if (response.status !== 200) {
    console.warn('AI translate status', response.status, (await response.text()).slice(0, 250));
    return '';
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return trimTranslation(messageContentToText(content));
}

async function viaWorkersAI(env, config, text) {
  if (!env?.AI || typeof env.AI.run !== 'function') return '';
  try {
    const result = await env.AI.run('@cf/meta/m2m100-1.2b', {
      text,
      source_lang: 'en',
      target_lang: 'fa',
    });
    const translation = result?.translated_text ?? result?.translation ?? result?.response ?? '';
    return trimTranslation(messageContentToText(translation));
  } catch (error) {
    console.warn('Workers AI translate failed:', error?.message || error);
    return '';
  }
}

async function viaGoogle(config, text, budget) {
  const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'fa', dt: 't' });
  const endpoint = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const response = await withTimeout(config.timeoutMs, async (signal) => {
    const post = await budgetFetch(budget, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: text }).toString(),
      signal,
    });
    if (post && post.status === 200) return post;
    return budgetFetch(budget, `${endpoint}&q=${encodeURIComponent(text)}`, { signal });
  });
  if (!response) return '';
  if (response.status !== 200) {
    console.warn('Google translate status', response.status, (await response.text()).slice(0, 200));
    return '';
  }
  const data = await response.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
  const parts = [];
  for (const part of data[0]) {
    if (Array.isArray(part) && part[0]) parts.push(String(part[0]));
  }
  return trimTranslation(parts.join(''));
}

async function viaMyMemory(config, text, budget) {
  const chunks = chunkText(text);
  const translated = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      q: chunk,
      langpair: `${config.mymemorySourceLang}|fa`,
    });
    if (config.mymemoryEmail) params.set('de', config.mymemoryEmail);
    const response = await withTimeout(config.timeoutMs, (signal) =>
      budgetFetch(budget, `https://api.mymemory.translated.net/get?${params.toString()}`, { signal })
    );
    if (!response) return '';
    if (response.status !== 200) {
      console.warn('MyMemory translate status', response.status);
      return '';
    }
    const data = await response.json();
    if (data?.responseStatus && Number(data.responseStatus) !== 200) {
      console.warn('MyMemory translate response', data.responseStatus, data.responseDetails);
      return '';
    }
    const part = data?.responseData?.translatedText ?? '';
    if (!part || String(part).toUpperCase().includes('MYMEMORY WARNING')) return '';
    translated.push(String(part));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return trimTranslation(translated.join('\n'));
}

export function buildTranslators(env, config) {
  // Order matters: better quality first, free/Google fallbacks afterwards.
  return [
    ...(config.apiKey ? [['ai', (text, budget) => viaChatApi(config, text, budget)]] : []),
    ...(env?.AI ? [['workers-ai', (text) => viaWorkersAI(env, config, text)]] : []),
    ['google-endpoint', (text, budget) => viaGoogle(config, text, budget)],
    ['mymemory', (text, budget) => viaMyMemory(config, text, budget)],
  ];
}

export async function translateText(env, text, budget = null) {
  const config = translationConfig(env);
  if (!config.translateFa) return '';

  const cleaned = cleanTweetText(text);
  if (!cleaned || !hasTextToTranslate(cleaned)) return '';

  // Keep enough context for long posts/quotes but stay below provider limits.
  const sourceText = cleaned.slice(0, 3000);
  const cacheKey = hashText(sourceText);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const translators = buildTranslators(env, config);
  for (const [name, translator] of translators) {
    for (let attempt = 1; attempt <= config.retries; attempt += 1) {
      if (budget && budget.remaining() < 1) {
        console.warn('Translation budget exhausted');
        return '';
      }
      try {
        const result = await translator(sourceText, budget);
        if (result && result.trim()) {
          const value = result.trim();
          cacheSet(cacheKey, value);
          return value;
        }
      } catch (error) {
        console.warn(`${name} translate failed (attempt ${attempt}):`, error?.message || error);
      }
      if (attempt < config.retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  console.warn('Translation unavailable after all fallbacks:', sourceText.slice(0, 120));
  return '';
}

export function clearTranslationCache() {
  translationsCache.clear();
}

export function translationCacheSize() {
  return translationsCache.size;
}
