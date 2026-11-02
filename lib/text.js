// Text helpers shared by the Worker: HTML cleaning/escaping, Telegram message
// rendering and translation chunking. This is a direct port of the helpers in
// twitter_telegram_bot.py so the Cloudflare build renders exactly the same cards.

export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_TEXT_LIMIT = 4096;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

// Decode the HTML entities that show up in RSS titles/descriptions.
export function htmlUnescape(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Same escaping as Python's html.escape(..., quote=True), which the Telegram
// cards rely on for parse_mode=HTML.
export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Turn Nitter/RSS HTML-ish text into plain text before sending/translating.
export function cleanTweetText(text) {
  if (!text) return '';
  let value = htmlUnescape(String(text));
  value = value.replace(/<br\s*\/?>/gi, '\n');
  value = value.replace(/<\/p\s*>/gi, '\n');
  value = value.replace(/<[^>]+>/g, '');
  value = value.replace(/\r\n?/g, '\n');
  value = value.replace(/[ \t]+/g, ' ');
  value = value.replace(/\n{3,}/g, '\n\n');
  return value.trim();
}

// JavaScript strings are already counted in UTF-16 code units, which is the
// unit Telegram uses for its 1024/4096 limits.
export function utf16Len(text) {
  return String(text ?? '').length;
}

export function escapeAndTruncate(text, budget) {
  if (budget <= 0) return '';
  const source = String(text ?? '').trim();
  const escaped = escapeHtml(source);
  if (utf16Len(escaped) <= budget) return escaped;
  if (budget <= 1) return '…';
  let cut = source;
  while (cut && utf16Len(escapeHtml(cut) + '…') > budget) {
    const overflow = utf16Len(escapeHtml(cut) + '…') - budget;
    const step = Math.max(1, Math.floor(overflow / 4));
    cut = cut.slice(0, Math.max(0, cut.length - step)).trim();
  }
  return cut ? escapeHtml(cut) + '…' : '…';
}

// Render one tweet card, never exceeding `maxLen` UTF-16 units.
export function buildMessage(content, maxLen = TELEGRAM_TEXT_LIMIT) {
  const username = String(content?.username ?? '');
  const title = String(content?.title ?? '').trim();
  const translation = String(content?.translation ?? '').trim();

  const header = `🔔 <b>NEW UPDATE | @${escapeHtml(username.toUpperCase())}</b>`;
  const hasTitle = Boolean(title);
  const hasTrans = Boolean(translation);

  if (!hasTitle && !hasTrans) return header;

  const origPrefix = '\n📝 <b>Original:</b>\n<blockquote expandable>';
  const origSuffix = '</blockquote>';
  const transPrefix = `\n${'━'.repeat(10)}\n🦁 <b>ترجمه فارسی:</b>\n<blockquote expandable><i>`;
  const transSuffix = '</i></blockquote>';

  if (hasTitle && hasTrans) {
    const fixedLen =
      utf16Len(header) +
      utf16Len(origPrefix) +
      utf16Len(origSuffix) +
      utf16Len(transPrefix) +
      utf16Len(transSuffix);
    const budget = Math.max(0, maxLen - fixedLen);
    const origFull = escapeHtml(title);
    const transFull = escapeHtml(translation);

    let bodyOrig;
    let bodyTrans;
    if (utf16Len(origFull) + utf16Len(transFull) <= budget) {
      bodyOrig = origFull;
      bodyTrans = transFull;
    } else {
      const half = Math.floor(budget / 2);
      const origLen = utf16Len(origFull);
      const transLen = utf16Len(transFull);
      let origBudget;
      let transBudget;
      if (origLen < half) {
        origBudget = origLen;
        transBudget = budget - origBudget;
      } else if (transLen < half) {
        transBudget = transLen;
        origBudget = budget - transBudget;
      } else {
        origBudget = half;
        transBudget = budget - half;
      }
      bodyOrig = escapeAndTruncate(title, origBudget);
      bodyTrans = escapeAndTruncate(translation, transBudget);
    }
    return `${header}${origPrefix}${bodyOrig}${origSuffix}${transPrefix}${bodyTrans}${transSuffix}`;
  }

  if (hasTitle) {
    const fixedLen = utf16Len(header) + utf16Len(origPrefix) + utf16Len(origSuffix);
    return `${header}${origPrefix}${escapeAndTruncate(title, Math.max(0, maxLen - fixedLen))}${origSuffix}`;
  }

  const fixedLen = utf16Len(header) + utf16Len(transPrefix) + utf16Len(transSuffix);
  return `${header}${transPrefix}${escapeAndTruncate(translation, Math.max(0, maxLen - fixedLen))}${transSuffix}`;
}

const TRIM_CHARS = ' "“”\n\r\t';

function stripChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function trimTranslation(result) {
  let value = cleanTweetText(result);
  value = value.replace(/^(ترجمه(?:\s*فارسی)?|translation)\s*[:：-]\s*/i, '');
  return stripChars(value, TRIM_CHARS);
}

// Avoid spending provider quota on empty/media-only tweets, links or emoji.
export function hasTextToTranslate(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''));
}

// Split long text so each translation request stays under provider limits.
export function chunkText(text, maxChars = 450) {
  const parts = String(text ?? '').split(/(?<=[.!?؟؛])\s+|\n+/);
  const chunks = [];
  let current = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < part.length; i += maxChars) chunks.push(part.slice(i, i + maxChars));
      continue;
    }
    const candidate = `${current} ${part}`.trim();
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [String(text ?? '').slice(0, maxChars)];
}

// JSON helper: D1 rows sometimes arrive as strings, dashboards must not crash.
export function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (text.includes('T')) return text;
  const parsed = new Date(text.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}
