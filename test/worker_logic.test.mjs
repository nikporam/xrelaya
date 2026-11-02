// Node tests for the Cloudflare Worker logic (no Wrangler required).
// Run with: npm test   (node --test test/worker_logic.test.mjs)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  buildMessage,
  chunkText,
  cleanTweetText,
  escapeAndTruncate,
  hasTextToTranslate,
  trimTranslation,
  utf16Len,
} from '../lib/text.js';
import {
  cleanUsername,
  extractAuthorUsername,
  extractId,
  extractImageUrl,
  extractTweetText,
  fetchFeed,
  isNewerTweetId,
  isRetweet,
  isValidTwitter,
  parseFeed,
  retweetReason,
} from '../lib/rss.js';
import { createBudget } from '../lib/budget.js';
import {
  clearTranslationCache,
  inferProvider,
  translateDetailed,
  translationConfig,
  translateText,
  translationCacheSize,
  translationStatus,
  workersAiLanguage,
} from '../lib/translate.js';
import { validateWebhookSecret } from '../lib/telegram.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

function rss(items) {
  return (
    '<?xml version="1.0"?><rss version="2.0" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>ch</title>' +
    items +
    '</channel></rss>'
  );
}

function nitterItem({ title, link, creator, description = '', guid }) {
  return (
    '<item>' +
    `<title><![CDATA[${title}]]></title>` +
    `<link>${link}</link>` +
    `<guid isPermaLink="false">${guid || link}</guid>` +
    (creator ? `<dc:creator><![CDATA[${creator}]]></dc:creator>` : '') +
    `<description><![CDATA[${description || title}]]></description>` +
    '</item>'
  );
}

async function withMockFetch(mock, runner) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await runner();
  } finally {
    globalThis.fetch = original;
  }
}

/* ── Text helpers ─────────────────────────────────────────────────────── */

test('utf16Len counts surrogate pairs like Telegram does', () => {
  assert.equal(utf16Len('hello'), 5);
  assert.equal(utf16Len('🦁'), 2);
  assert.equal(utf16Len('🔔'), 2);
});

test('escapeAndTruncate escapes HTML and respects the budget', () => {
  const text = 'Hello <world> & friends'.repeat(20);
  const result = escapeAndTruncate(text, 50);
  assert.ok(utf16Len(result) <= 50, 'result exceeds budget');
  assert.ok(result.endsWith('…'));
  assert.ok(result.includes('&lt;world&gt;'));
  assert.ok(result.includes('&amp;'));
});

test('long captions shorten original and translation, tags stay balanced', () => {
  const content = {
    username: 'user1',
    title: 'Alpha '.repeat(150),
    translation: 'بتا '.repeat(150),
    img_url: 'https://pbs.twimg.com/media/pic.jpg',
    link: 'https://x.com/i/status/999',
  };
  const caption = buildMessage(content, TELEGRAM_CAPTION_LIMIT);
  assert.ok(utf16Len(caption) <= TELEGRAM_CAPTION_LIMIT);
  assert.ok(caption.includes('Alpha'));
  assert.ok(caption.includes('بتا'));
  assert.equal(caption.split('…').length - 1, 2);
  assert.equal(caption.split('<b>').length, caption.split('</b>').length);
  assert.equal(caption.split('<i>').length, caption.split('</i>').length);
  assert.equal(
    caption.split('<blockquote expandable>').length,
    caption.split('</blockquote>').length
  );
});

test('a tweet without translation renders the original only', () => {
  const message = buildMessage(
    {
      username: 'vitalikbuterin',
      title: 'Ethereum upgrade is live',
      translation: '',
      img_url: null,
      link: 'https://x.com/i/status/456',
    },
    TELEGRAM_TEXT_LIMIT
  );
  assert.ok(message.includes('NEW UPDATE | @VITALIKBUTERIN'));
  assert.ok(message.includes('Original:'));
  assert.ok(!message.includes('ترجمه فارسی:'));
});

test('cleanTweetText strips markup and decodes entities', () => {
  // </p> and <br/> each become a newline, exactly like clean_tweet_text().
  assert.equal(cleanTweetText('<p>Hello &amp; bye</p><br/>line2'), 'Hello & bye\n\nline2');
});

test('chunkText keeps every chunk under the limit', () => {
  const text = 'Sentence one. '.repeat(200);
  const chunks = chunkText(text, 450);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 450);
});

test('trimTranslation removes provider prefixes and quotes', () => {
  assert.equal(trimTranslation('ترجمه: "سلام دنیا"'), 'سلام دنیا');
  assert.equal(trimTranslation('Translation: "hello"'), 'hello');
});

test('hasTextToTranslate ignores emoji/link-only bodies', () => {
  assert.equal(hasTextToTranslate('🦁🔥'), false);
  assert.equal(hasTextToTranslate('سلاام'), true);
});

/* ── Usernames and ids ────────────────────────────────────────────────── */

test('cleanUsername normalises handles and URLs', () => {
  assert.equal(cleanUsername('@ElonMusk'), 'elonmusk');
  assert.equal(cleanUsername('https://x.com/ElonMusk/status/1'), 'elonmusk');
  assert.equal(cleanUsername('twitter.com/NASA'), 'nasa');
  assert.equal(cleanUsername(' ElonMusk?ref=1 '), 'elonmusk');
  assert.equal(isValidTwitter('elonmusk'), true);
  assert.equal(isValidTwitter('elon musk'), false);
  assert.equal(isValidTwitter('a'.repeat(16)), false);
});

test('extractId reads status ids from link, guid or id', () => {
  assert.equal(extractId({ link: 'https://nitter.cz/nasa/status/123456789012345678' }), '123456789012345678');
  assert.equal(extractId({ id: 'https://x.com/nasa/status/9999' }), '9999');
  assert.equal(extractId({}), null);
});

test('isNewerTweetId compares numerically, not lexicographically', () => {
  assert.equal(isNewerTweetId('1000000000000000000', '999999999999999999'), true);
  assert.equal(isNewerTweetId('10', '10'), false);
  assert.equal(isNewerTweetId('10', ''), true);
});

/* ── Retweet filter ───────────────────────────────────────────────────── */

test('quoted tweet whose link matches the account is not filtered', () => {
  const entry = {
    title: 'Check out this amazing launch https://x.com/nasa/status/999',
    link: 'https://nitter.cz/elonmusk/status/1111',
    description: 'Check out this amazing launch',
  };
  assert.equal(isRetweet(entry, 'elonmusk'), false);
});

test('all retweet/repost variants are filtered', () => {
  const cases = [
    { title: 'RT by @elonmusk: NASA Artemis launch' },
    { title: 'RT by elonmusk: NASA Artemis launch' },
    { title: 'RT @nasa: Launching now' },
    { title: 'RT: @nasa Launching now' },
    { title: '[RT] Launching now' },
    { title: 'Retweeted by @elonmusk: Launching' },
    { title: 'Reposted by @elonmusk: Launching' },
    { title: 'Some tweet', description: '<div class="retweet-header">Retweeted</div>' },
    { title: 'Some tweet', tags: [{ term: 'retweet' }] },
    { title: 'Great news', link: 'https://nitter.cz/nasa/status/98765' },
    { title: 'Great news', author: '@nasa' },
  ];
  for (const entry of cases) {
    assert.equal(isRetweet(entry, 'elonmusk'), true, `not filtered: ${JSON.stringify(entry)}`);
  }
});

test('ordinary tweets are kept', () => {
  assert.equal(
    isRetweet({ title: 'Working on Falcon Heavy today', link: 'https://nitter.cz/elonmusk/status/123' }, 'elonmusk'),
    false
  );
  assert.equal(
    isRetweet({ title: 'I will start at noon', link: 'https://nitter.cz/elonmusk/status/123' }, 'elonmusk'),
    false
  );
});

test('a display name is never mistaken for a handle', () => {
  assert.deepEqual(extractAuthorUsername({ author: 'RippleX' }), ['ripplex', false]);
  const entry = {
    title: 'X Money support is live',
    link: 'https://nitter.cz/RippleSupport/status/1234',
    author: 'RippleX',
  };
  assert.equal(isRetweet(entry, 'ripplesupport'), false);
  assert.equal(isRetweet({ title: 'Hello', author: 'RippleX' }, 'ripplesupport'), false);
  assert.deepEqual(extractAuthorUsername({ author: 'Ripple Support' }), ['', false]);
});

test('an author email is the handle, never the mirror domain', () => {
  const entry = { title: 'Perseverance update', author: 'nasa@nitter.net (NASA)' };
  assert.deepEqual(extractAuthorUsername(entry), ['nasa', true]);
  assert.equal(isRetweet(entry, 'nasa'), false);
  assert.equal(isRetweet(entry, 'elonmusk'), true);
});

test('own status link wins over a conflicting author field', () => {
  const entry = {
    title: 'Interesting thread',
    link: 'https://nitter.cz/elonmusk/status/7',
    author: 'Elon (@nasa)',
  };
  assert.equal(isRetweet(entry, 'elonmusk'), false);
});

test('an explicit foreign handle still filters', () => {
  const entry = { title: 'Great launch', link: 'https://nitter.cz/i/status/8', author: '@nasa' };
  assert.equal(isRetweet(entry, 'elonmusk'), true);
});

test('quoted blocks cannot leak retweet markers', () => {
  const entry = {
    title: 'This take aged badly',
    link: 'https://nitter.cz/elonmusk/status/9',
    description:
      'This take aged badly<hr/>\n<blockquote>\n' +
      '<div class="retweet-header">nasa retweeted</div>\n<p>old</p>\n</blockquote>',
  };
  assert.equal(isRetweet(entry, 'elonmusk'), false);
});

test('a tweet talking about retweets is kept', () => {
  const entry = {
    title: 'I was retweeted by @nasa today',
    description: 'I was retweeted by @nasa today. RT by @nasa got 3k likes.',
    link: 'https://nitter.cz/elonmusk/status/10',
  };
  assert.equal(isRetweet(entry, 'elonmusk'), false);

  const banner = {
    title: 'RT by @nasa: Great launch',
    description: 'RT by @nasa: Great launch',
    link: 'https://nitter.cz/nasa/status/11',
  };
  assert.equal(isRetweet(banner, 'elonmusk'), true);
});

test('retweetReason explains why an entry was dropped', () => {
  const reason = retweetReason({ title: 'RT by @nasa: hi', link: 'https://nitter.cz/nasa/status/5' }, 'elonmusk');
  assert.match(reason, /retweet/);
});

/* ── Feed parsing ─────────────────────────────────────────────────────── */

test('parseFeed reads Nitter RSS fields', () => {
  const xml = rss(
    nitterItem({
      title: 'Hello <b>world</b> &amp; friends',
      link: 'https://nitter.cz/nasa/status/123456789012345678',
      creator: '@nasa',
      description:
        '<p>Hello world</p><img src="/pic/media%2FABC123.jpg?name=small"><img src="/pic/profile_images%2Fxyz.jpg">',
    })
  );
  const [entry] = parseFeed(xml, 'https://nitter.cz/nasa/rss');
  assert.equal(entry.link, 'https://nitter.cz/nasa/status/123456789012345678');
  assert.equal(entry.dc_creator, '@nasa');
  assert.equal(extractId(entry), '123456789012345678');
  assert.equal(extractTweetText(entry), 'Hello world & friends');
  assert.equal(
    extractImageUrl(entry),
    'https://pbs.twimg.com/media/ABC123.jpg?format=jpg&name=large'
  );
  assert.equal(isRetweet(entry, 'nasa'), false);
});

test('parsed feed entries classify reposts and originals', () => {
  const repostXml = rss(
    nitterItem({
      title: 'RT by @ripplesupport: Hello world',
      link: 'https://nitter.cz/nasa/status/123',
      creator: '@nasa',
    })
  );
  const originalXml = rss(
    nitterItem({
      title: 'My own news',
      link: 'https://nitter.cz/ripplesupport/status/124',
      creator: 'RippleX',
    })
  );
  const [repost] = parseFeed(repostXml);
  const [original] = parseFeed(originalXml);
  assert.equal(isRetweet(repost, 'ripplesupport'), true);
  assert.equal(isRetweet(original, 'ripplesupport'), false);
});

/* ── Feed fetching (parallel mirror race) ─────────────────────────────── */

test('fetchFeed drops reposts and keeps originals', async () => {
  const xml = rss(
    nitterItem({
      title: 'RT by @ripplesupport: NASA news',
      link: 'https://nitter.cz/nasa/status/1',
      creator: '@nasa',
    }) +
      nitterItem({
        title: 'My own news',
        link: 'https://nitter.cz/ripplesupport/status/2',
        creator: 'RippleX',
      })
  );
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    },
    async () => {
      const entries = await fetchFeed({ FEED_MIRRORS: '6', FEED_BATCH: '3' }, 'ripplesupport', createBudget(40));
      assert.deepEqual(
        entries.map((entry) => entry.title),
        ['My own news']
      );
      // Mirrors are raced in batches of three, so only the first batch is hit.
      assert.equal(calls, 3);
    }
  );
});

test('an all-reposts feed is a definitive answer, not a reason to hit every mirror', async () => {
  const xml = rss(
    nitterItem({
      title: 'RT by @ripplesupport: Someone else',
      link: 'https://nitter.cz/nasa/status/3',
      creator: '@nasa',
    })
  );
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response(xml, { status: 200 });
    },
    async () => {
      const entries = await fetchFeed({ FEED_MIRRORS: '6', FEED_BATCH: '3' }, 'ripplesupport', createBudget(40));
      assert.deepEqual(entries, []);
      assert.equal(calls, 3);
    }
  );
});

test('fetchFeed moves to the next batch when every mirror fails', async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      throw new Error('network down');
    },
    async () => {
      const entries = await fetchFeed({ FEED_MIRRORS: '6', FEED_BATCH: '3' }, 'nasa', createBudget(40));
      assert.deepEqual(entries, []);
      assert.equal(calls, 6);
    }
  );
});

test('fetchFeed respects an exhausted budget', async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return new Response('', { status: 200 });
    },
    async () => {
      const budget = createBudget(1);
      budget.take(1);
      const entries = await fetchFeed({}, 'nasa', budget);
      assert.deepEqual(entries, []);
      assert.equal(calls, 0);
    }
  );
});

/* ── Translation ──────────────────────────────────────────────────────── */

function aiResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('empty translation results are never cached', async () => {
  clearTranslationCache();
  const env = { GEMINI_API_KEY: 'test-key', TRANSLATE_FA: 'true' };
  await withMockFetch(
    async (url) => {
      const target = String(url);
      if (target.includes('generativelanguage')) return aiResponse('');
      if (target.includes('translate.googleapis')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ responseStatus: 403 }), { status: 200 });
    },
    async () => {
      const result = await translateText(env, 'Some text that cannot be translated', createBudget(20));
      assert.equal(result, '');
      assert.equal(translationCacheSize(), 0);
    }
  );
});

test('a successful translation is cached and reused', async () => {
  clearTranslationCache();
  const env = { GEMINI_API_KEY: 'test-key', TRANSLATE_FA: 'true' };
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return aiResponse('ترجمه تستی');
    },
    async () => {
      const first = await translateText(env, 'A test tweet', createBudget(20));
      assert.equal(first, 'ترجمه تستی');
      assert.ok(translationCacheSize() > 0);
      const second = await translateText(env, 'A test tweet', createBudget(20));
      assert.equal(second, 'ترجمه تستی');
      assert.equal(calls, 1);
    }
  );
});

test('translation is skipped entirely when TRANSLATE_FA is false', async () => {
  clearTranslationCache();
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      return aiResponse('x');
    },
    async () => {
      const result = await translateText({ TRANSLATE_FA: 'false' }, 'Hello there', createBudget(20));
      assert.equal(result, '');
      assert.equal(calls, 0);
    }
  );
});

test('MyMemory is used when the AI provider and Google fail', async () => {
  clearTranslationCache();
  const env = { MYMEMORY_SOURCE_LANG: 'en' };
  await withMockFetch(
    async (url) => {
      const target = String(url);
      if (target.includes('translate.googleapis')) return new Response('oops', { status: 500 });
      if (target.includes('mymemory')) {
        return new Response(
          JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'سلام' } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url ${target}`);
    },
    async () => {
      const result = await translateText(env, 'Hello', createBudget(20));
      assert.equal(result, 'سلام');
    }
  );
});


/* ── Workers AI language handling ─────────────────────────────────────── */

test('workersAiLanguage maps ISO codes to the names m2m100 expects', () => {
  // Sending "en"/"fa" made the model throw, so Workers AI silently fell
  // through to Google every single time.
  assert.equal(workersAiLanguage('en'), 'english');
  assert.equal(workersAiLanguage('fa'), 'persian');
  assert.equal(workersAiLanguage('EN'), 'english');
  assert.equal(workersAiLanguage('fa-IR'), 'fa-ir');
  assert.equal(workersAiLanguage('', 'fallback'), 'fallback');
  assert.equal(workersAiLanguage(undefined, 'fallback'), 'fallback');
});

test('Workers AI is called with full language names', async () => {
  clearTranslationCache();
  const calls = [];
  const env = {
    TRANSLATE_FA: 'true',
    AI: {
      run: async (model, params) => {
        calls.push({ model, params });
        return { translated_text: 'سلام دنیا' };
      },
    },
  };
  const result = await translateText(env, 'Hello world', createBudget(20));
  assert.equal(result, 'سلام دنیا');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.source_lang, 'english');
  assert.equal(calls[0].params.target_lang, 'persian');
  assert.equal(calls[0].model, '@cf/meta/m2m100-1.2b');
});

test('Workers AI failure is reported instead of being swallowed', async () => {
  clearTranslationCache();
  const env = {
    TRANSLATE_FA: 'true',
    AI: {
      run: async () => {
        throw new Error('invalid language code');
      },
    },
  };
  await withMockFetch(
    async (url) => {
      const target = String(url);
      if (target.includes('translate.googleapis')) return new Response('nope', { status: 429 });
      return new Response(JSON.stringify({ responseStatus: 429, responseDetails: 'quota' }), { status: 200 });
    },
    async () => {
      const detail = await translateDetailed(env, 'Hello world', createBudget(20));
      assert.equal(detail.translation, '');
      const providers = detail.failures.map((failure) => failure.provider);
      assert.ok(providers.includes('workers-ai'));
      const workers = detail.failures.find((failure) => failure.provider === 'workers-ai');
      assert.match(workers.reason, /invalid language code/);
      assert.ok(providers.includes('google-endpoint'));
      assert.ok(providers.includes('mymemory'));
    }
  );
});

test('translateDetailed reports which provider produced the translation', async () => {
  clearTranslationCache();
  const env = { TRANSLATE_FA: 'true', AI: { run: async () => ({ translated_text: 'ترجمه' }) } };
  const detail = await translateDetailed(env, 'Something to translate', createBudget(20));
  assert.equal(detail.translation, 'ترجمه');
  assert.equal(detail.provider, 'workers-ai');
  assert.deepEqual(detail.failures, []);
});

test('translateDetailed explains why translation was skipped', async () => {
  clearTranslationCache();
  const off = await translateDetailed({ TRANSLATE_FA: 'false' }, 'Hello', createBudget(20));
  assert.equal(off.translation, '');
  assert.match(off.skipped, /TRANSLATE_FA/);

  const emoji = await translateDetailed({ TRANSLATE_FA: 'true' }, '🦁🔥', createBudget(20));
  assert.equal(emoji.translation, '');
  assert.match(emoji.skipped, /nothing to translate/);
});

/* ── translation status reporting ─────────────────────────────────────── */

test('translationStatus reports the real configuration', () => {
  const none = translationStatus({});
  assert.equal(none.primary, 'google-endpoint');
  assert.equal(none.providers.find((p) => p.name === 'ai').enabled, false);
  assert.equal(none.providers.find((p) => p.name === 'workers-ai').enabled, false);

  const withAi = translationStatus({ GEMINI_API_KEY: 'abc' });
  assert.equal(withAi.primary, 'ai');
  // A Gemini key must pick the Gemini model, not the generic default.
  assert.equal(withAi.providers.find((p) => p.name === 'ai').model, 'gemini-2.0-flash');

  const withWorkersAi = translationStatus({ AI: { run: () => {} } });
  assert.equal(withWorkersAi.primary, 'workers-ai');

  const placeholder = translationStatus({ GEMINI_API_KEY: 'your_gemini_api_key' });
  assert.equal(placeholder.primary, 'google-endpoint');
});

/* ── webhook secret validation ────────────────────────────────────────── */

test('validateWebhookSecret accepts only characters Telegram allows', () => {
  assert.equal(validateWebhookSecret(''), null);
  assert.equal(validateWebhookSecret(undefined), null);
  assert.equal(validateWebhookSecret('xrelaya_wh-2024'), null);

  // These all made setWebhook fail with an opaque 400 before.
  assert.match(validateWebhookSecret('my secret!'), /whitespace|rejects/);
  assert.match(validateWebhookSecret('secret!'), /rejects/);
  assert.match(validateWebhookSecret('secret.token'), /rejects/);
  assert.match(validateWebhookSecret('محرمانه'), /rejects/);
  assert.match(validateWebhookSecret('a'.repeat(257)), /256/);
});


/* ── provider inference from the key itself ───────────────────────────── */

test('a Gemini key pasted into REQUESTY_API_KEY still reaches Gemini', () => {
  // This exact mistake sent real requests to a third-party default endpoint
  // (or to api.openai.com) and every translation failed with 401/404.
  const config = translationConfig({ REQUESTY_API_KEY: 'AIzaSyD-abcdefghijklmnop' });
  assert.equal(config.provider, 'gemini');
  assert.equal(config.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(config.model, 'gemini-2.0-flash');
  assert.equal(config.keySource, 'REQUESTY_API_KEY');
});

test('an OpenAI key is routed to OpenAI', () => {
  const config = translationConfig({ GEMINI_API_KEY: 'sk-proj-abcdefghijklmnop' });
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.model, 'gpt-4o-mini');
});

test('explicit configuration still wins over key sniffing', () => {
  const config = translationConfig({
    GEMINI_API_KEY: 'AIzaSyD-abcdefghijklmnop',
    REQUESTY_BASE_URL: 'https://example.test/v1',
    REQUESTY_MODEL: 'my-model',
  });
  assert.equal(config.provider, 'custom');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.model, 'my-model');
});

test('inferProvider reports the variable that supplied the key', () => {
  assert.equal(inferProvider({}, ''), 'custom');
  assert.equal(inferProvider({ GEMINI_API_KEY: 'AIzaSyD-abcdefghijklmnop' }, ''), 'gemini');
  assert.equal(inferProvider({ OPENAI_API_KEY: 'sk-abcdefghijklmnop' }, ''), 'openai');
  assert.equal(inferProvider({}, 'sk-abcdefghijklmnop'), 'openai');
});

test('translationStatus exposes the endpoint and key source', () => {
  const status = translationStatus({ GEMINI_API_KEY: 'AIzaSyD-abcdefghijklmnop' });
  assert.equal(status.primary, 'ai');
  assert.equal(status.ai.keySource, 'GEMINI_API_KEY');
  assert.equal(status.ai.provider, 'gemini');
  assert.equal(status.ai.model, 'gemini-2.0-flash');
});

test('an exhausted budget skips fetch providers but keeps the reasons', async () => {
  clearTranslationCache();
  const budget = createBudget(1);
  budget.take(1);

  await withMockFetch(
    async () => {
      throw new Error('should not be called');
    },
    async () => {
      const detail = await translateDetailed({ TRANSLATE_FA: 'true' }, 'Hello world', budget);
      assert.equal(detail.translation, '');
      const providers = detail.failures.map((failure) => failure.provider);
      assert.ok(providers.includes('google-endpoint'));
      assert.match(
        detail.failures.find((failure) => failure.provider === 'google-endpoint').reason,
        /budget/
      );
    }
  );
});
