// Persian translation with graceful fallbacks. Providers, in order:
//   1. Any OpenAI-compatible AI endpoint (Gemini / OpenAI / Requesty)
//   2. Cloudflare Workers AI (free, no API key — needs the [ai] binding)
//   3. Google's unofficial translate endpoint
//   4. MyMemory (non-Google fallback)
//
// Every provider reports *why* it failed instead of silently returning "",
// so `/status`, `/test` and `/health` can tell the user what is actually
// broken. Empty results are never cached: a provider outage must not leave a
// tweet permanently untranslated.

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

// Workers AI's m2m100/nllb models want full language names, not ISO codes.
// Sending "en"/"fa" makes the model throw, which is why Workers AI used to
// silently fall through to Google every single time.
const WORKERS_AI_LANGUAGES = {
  en: 'english',
  fa: 'persian',
  ar: 'arabic',
  tr: 'turkish',
  ru: 'russian',
  de: 'german',
  fr: 'french',
};

const WORKERS_AI_MODELS = ['@cf/meta/m2m100-1.2b', '@cf/meta/nllb-200-distilled-600M'];

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

export function workersAiLanguage(code, fallback) {
  const key = String(code ?? '').trim().toLowerCase();
  if (!key) return fallback;
  return WORKERS_AI_LANGUAGES[key] || key;
}

// A key pasted into the wrong variable used to send Gemini tokens to the
// OpenAI endpoint (401) or to a third-party default (404). The key format is
// a strong hint, so it now decides the endpoint when nothing is configured
// explicitly: Google keys start with "AIza", OpenAI keys with "sk-".
export function inferProvider(env = {}, apiKey = '') {
  if (String(env.REQUESTY_BASE_URL || '').trim()) return 'custom';
  if (/^AIza[0-9A-Za-z_-]{10,}$/.test(apiKey)) return 'gemini';
  if (/^sk-[0-9A-Za-z_-]{10,}$/.test(apiKey)) return 'openai';
  if (cleanApiKey(env.GEMINI_API_KEY)) return 'gemini';
  if (cleanApiKey(env.OPENAI_API_KEY)) return 'openai';
  return 'custom';
}

const PROVIDER_ENDPOINTS = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
  },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { baseUrl: 'https://api.17.wtf/v1', model: 'posiden/deepseek-v4-flash' },
};

export function translationConfig(env = {}) {
  const geminiKey = cleanApiKey(env.GEMINI_API_KEY);
  const openaiKey = cleanApiKey(env.OPENAI_API_KEY);
  const requestyKey = cleanApiKey(env.REQUESTY_API_KEY);
  const apiKey = requestyKey || geminiKey || openaiKey;

  const provider = inferProvider(env, apiKey);
  const defaults = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;

  const baseUrl = env.REQUESTY_BASE_URL
    ? String(env.REQUESTY_BASE_URL).trim().replace(/\/+$/, '')
    : defaults.baseUrl;

  const model = env.REQUESTY_MODEL ? String(env.REQUESTY_MODEL).trim() : defaults.model;

  // Which variable actually supplied the key — shown by /health so a key in
  // the wrong variable is visible instead of mysterious.
  let keySource = null;
  if (apiKey) {
    if (requestyKey && apiKey === requestyKey) keySource = 'REQUESTY_API_KEY';
    else if (geminiKey && apiKey === geminiKey) keySource = 'GEMINI_API_KEY';
    else if (openaiKey && apiKey === openaiKey) keySource = 'OPENAI_API_KEY';
  }

  const sourceLang = String(env.MYMEMORY_SOURCE_LANG || 'en').trim() || 'en';

  return {
    apiKey,
    keySource,
    provider,
    baseUrl,
    model,
    translateFa: isTruthy(env.TRANSLATE_FA, true),
    timeoutMs: positiveNumber(env.TRANSLATION_TIMEOUT, 20) * 1000,
    retries: Math.max(1, Math.floor(positiveNumber(env.TRANSLATION_RETRIES, 2))),
    mymemorySourceLang: sourceLang,
    mymemoryEmail: String(env.MYMEMORY_EMAIL || '').trim(),
    workersAiModel: String(env.WORKERS_AI_MODEL || '').trim() || WORKERS_AI_MODELS[0],
    sourceLang,
  };
}

// Which translators this deployment will actually try, and on what.
// Used by /status, /test and /health so the answer is never a guess.
export function translationStatus(env = {}) {
  const config = translationConfig(env);
  const aiEnabled = Boolean(config.apiKey);
  const workersAiEnabled = Boolean(env?.AI && typeof env.AI.run === 'function');

  return {
    enabled: config.translateFa,
    primary: aiEnabled ? 'ai' : workersAiEnabled ? 'workers-ai' : 'google-endpoint',
    ai: aiEnabled
      ? {
          keySource: config.keySource,
          provider: config.provider,
          endpoint: config.baseUrl,
          model: config.model,
        }
      : null,
    providers: [
      { name: 'ai', enabled: aiEnabled, model: aiEnabled ? config.model : null },
      { name: 'workers-ai', enabled: workersAiEnabled, model: config.workersAiModel },
      { name: 'google-endpoint', enabled: true },
      { name: 'mymemory', enabled: true },
    ],
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

// Providers return { text, error } so the caller can report a real reason.
function fail(reason) {
  return { text: '', error: String(reason || 'unknown error') };
}

async function viaChatApi(config, text, budget) {
  if (!config.apiKey) return fail('no API key');
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
  if (!response) return fail('subrequest budget exhausted');
  if (response.status !== 200) {
    const detail = (await response.text()).slice(0, 200);
    console.warn('AI translate status', response.status, detail);
    return fail(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const translated = trimTranslation(messageContentToText(content));
  return translated ? { text: translated, error: null } : fail('empty response');
}

function workersAiLanguagePairs(sourceLang) {
  const source = String(sourceLang || 'en').trim().toLowerCase();
  const pairs = [[workersAiLanguage(source, 'english'), workersAiLanguage('fa', 'persian')]];
  // Some models accept the short ISO form; keep it as a second chance.
  const shortSource = source || 'en';
  if (pairs[0][0] !== shortSource) pairs.push([shortSource, 'fa']);
  return pairs;
}

async function viaWorkersAI(env, config, text, models = null) {
  if (!env?.AI || typeof env.AI.run !== 'function') return fail('AI binding not configured');

  const candidates = models && models.length ? models : [config.workersAiModel];
  const reasons = [];

  for (const model of candidates) {
    for (const [sourceLang, targetLang] of workersAiLanguagePairs(config.sourceLang)) {
      try {
        const result = await env.AI.run(model, {
          text,
          source_lang: sourceLang,
          target_lang: targetLang,
        });
        const translation = result?.translated_text ?? result?.translation ?? result?.response ?? '';
        const translated = trimTranslation(messageContentToText(translation));
        if (translated) return { text: translated, error: null };
        reasons.push(`${model}: empty response`);
      } catch (error) {
        const message = String(error?.message || error).slice(0, 160);
        console.warn(`Workers AI (${model}, ${sourceLang}->${targetLang}) failed:`, message);
        reasons.push(`${model}: ${message}`);
      }
    }
  }

  // Surface the first real error instead of a pile of duplicates.
  const unique = [...new Set(reasons)].slice(0, 2);
  return fail(unique.join(' | ') || 'Workers AI unavailable');
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
  if (!response) return fail('subrequest budget exhausted');
  if (response.status !== 200) {
    const detail = (await response.text()).slice(0, 120);
    console.warn('Google translate status', response.status, detail);
    return fail(`HTTP ${response.status}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return fail('invalid JSON from Google');
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) return fail('unexpected Google payload');
  const parts = [];
  for (const part of data[0]) {
    if (Array.isArray(part) && part[0]) parts.push(String(part[0]));
  }
  const translated = trimTranslation(parts.join(''));
  return translated ? { text: translated, error: null } : fail('empty translation');
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
    if (!response) return fail('subrequest budget exhausted');
    if (response.status !== 200) {
      console.warn('MyMemory translate status', response.status);
      return fail(`HTTP ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return fail('invalid JSON from MyMemory');
    }
    if (data?.responseStatus && Number(data.responseStatus) !== 200) {
      const detail = String(data.responseDetails || '').slice(0, 120);
      console.warn('MyMemory translate response', data.responseStatus, detail);
      return fail(`API ${data.responseStatus}${detail ? `: ${detail}` : ''}`);
    }
    const part = data?.responseData?.translatedText ?? '';
    if (!part || String(part).toUpperCase().includes('MYMEMORY WARNING')) {
      return fail('daily quota reached');
    }
    translated.push(String(part));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const result = trimTranslation(translated.join('\n'));
  return result ? { text: result, error: null } : fail('empty translation');
}

// Build the ordered provider list for this deployment.
// Workers AI runs before the Web endpoints: it is free, has no rate limit
// worth worrying about here, and does not consume the subrequest budget.
export function buildTranslators(env, config) {
  return [
    ...(config.apiKey ? [['ai', (text, budget) => viaChatApi(config, text, budget)]] : []),
    ...(env?.AI
      ? [['workers-ai', (text) => viaWorkersAI(env, config, text)]]
      : []),
    ['google-endpoint', (text, budget) => viaGoogle(config, text, budget)],
    ['mymemory', (text, budget) => viaMyMemory(config, text, budget)],
  ];
}

// Translate and keep the reason every provider failed.
export async function translateDetailed(env, text, budget = null) {
  const config = translationConfig(env);
  const result = { translation: '', provider: null, failures: [], skipped: null };

  if (!config.translateFa) {
    result.skipped = 'TRANSLATE_FA is off';
    return result;
  }

  const cleaned = cleanTweetText(text);
  if (!cleaned || !hasTextToTranslate(cleaned)) {
    result.skipped = 'nothing to translate (media-only, links or emoji)';
    return result;
  }

  // Keep enough context for long posts/quotes but stay below provider limits.
  const sourceText = cleaned.slice(0, 3000);
  const cacheKey = hashText(sourceText);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...result, translation: cached, provider: 'cache' };

  for (const [name, translator] of buildTranslators(env, config)) {
    let lastError = null;
    for (let attempt = 1; attempt <= config.retries; attempt += 1) {
      // Workers AI runs inside Cloudflare and costs no subrequest, so a tight
      // budget must not stop it; the fetch-based providers report it instead.
      if (budget && budget.remaining() < 1 && name !== 'workers-ai') {
        lastError = 'subrequest budget exhausted';
        result.failures.push({ provider: name, reason: lastError });
        break;
      }
      try {
        const outcome = await translator(sourceText, budget);
        if (outcome && outcome.text && outcome.text.trim()) {
          const value = outcome.text.trim();
          cacheSet(cacheKey, value);
          return { ...result, translation: value, provider: name };
        }
        lastError = outcome?.error || 'empty result';
      } catch (error) {
        lastError = String(error?.message || error);
        console.warn(`${name} translate failed (attempt ${attempt}):`, lastError);
      }
      if (attempt < config.retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    result.failures.push({ provider: name, reason: lastError || 'empty result' });
  }

  console.warn('Translation unavailable after all fallbacks:', sourceText.slice(0, 120));
  return result;
}

export async function translateText(env, text, budget = null) {
  const { translation } = await translateDetailed(env, text, budget);
  return translation;
}

export function clearTranslationCache() {
  translationsCache.clear();
}

export function translationCacheSize() {
  return translationsCache.size;
}

export { WORKERS_AI_MODELS };
