<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/f/fd/State_flag_of_Iran_%281964%E2%80%931980%29.svg" width="110" alt="Lion and Sun Flag of Iran">
</p>

<h1 align="center">🐦 Twitter/X → Telegram Bot</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare D1">
  <img src="https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white" alt="Telegram">
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript">
</p>

<p align="center">
  <b>Forward tweets to Telegram — no paid API, no server, no database to host.</b><br>
  RSS based, with AI-powered Persian translation.<br>
  Runs entirely on Cloudflare's free plan: Workers + D1 + Cron.
</p>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Auto Forward** | Tweets delivered to Telegram automatically |
| 🦁 **AI Translation** | Gemini / OpenAI / Workers AI, with Google + MyMemory fallback |
| 🚫 **Retweet Filter** | Skips retweets/reposts, without misreading display names as handles |
| 🖼️ **Media Support** | Photos downloaded and uploaded with the tweet |
| 📊 **Live Dashboard** | PWA served by the same Worker |
| 🔍 **Inline Search** | Search saved tweets from any chat |
| ⌨️ **Keyboard Menu** | Quick buttons for easy use |
| ⏰ **Cron Polling** | Checks accounts every 5 minutes, round-robin |
| 🧠 **Smart Caching** | In-memory translation cache |
| 🛡️ **Budget Guard** | Stays under Cloudflare's free subrequest limit |
| 📱 **Mobile Friendly** | Responsive dark UI |

---

## 🚀 Quick Start

### 1. Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot` and choose a name & username
3. Copy the token (looks like: `123456:ABC-DEF...`)

### 2. Install

```bash
git clone https://github.com/nikporam/xrelaya.git
cd xrelaya
npm install
npx wrangler login
```

Requires **Node.js 20+** and a free Cloudflare account.

### 3. Create the D1 database

```bash
npx wrangler d1 create xrelaya-db
```

Paste the printed `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "xrelaya-db"
database_id = "your-real-database-id"
```

Then create the tables:

```bash
npx wrangler d1 execute xrelaya-db --remote --file=./schema.sql
```

### 4. Set the secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # required
npx wrangler secret put SETUP_KEY                 # required, protects /setup
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # optional, recommended
npx wrangler secret put GEMINI_API_KEY            # optional, better translation
```

### 5. Deploy

```bash
npx wrangler deploy
```

Open this once to register the Telegram webhook and the command menu:

```
https://xrelaya-bot.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>
```

It returns JSON showing whether `database`, `getMe`, `setMyCommands` and `setWebhook` succeeded.
The dashboard is served at `/` on the same domain, and `/health` reports the overall status.

Then send `/start` to your bot in Telegram.

---

## 📱 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + keyboard |
| `/add username` | Add Twitter account(s) |
| `/del username` | Remove account |
| `/list` | View tracked accounts |
| `/test` | Test with @ElonMusk |
| `/search text` | Search saved tweets |
| `/status` | Bot health check |

---

## ⌨️ Keyboard Buttons

| Button | Action |
|--------|--------|
| ➕ اضافه کردن | Add account |
| 📋 لیست اکانت‌ها | View list |
| 🔍 جستجو | Search tweets |
| 🌐 داشبورد | Open web dashboard |
| 📊 وضعیت | Bot status |
| ℹ️ راهنما | Help |

---

## 🔍 Inline Mode

From **any** Telegram chat, type:

```
@your_bot_name elonmusk
```

Searches saved tweets and shares them inline.

---

## 🧪 Local Development

```bash
cp dev.vars.example .dev.vars   # fill in the token and keys
npx wrangler dev                # http://localhost:8787
```

Logic tests (no Cloudflare account needed):

```bash
npm test
```

---

## 🏗️ How it works

| Concern | Implementation |
|---------|----------------|
| Telegram updates | Webhook → `POST /telegram` |
| Polling schedule | Cloudflare Cron Trigger (`*/5 * * * *`) |
| Storage | Cloudflare D1 (SQLite) |
| Dashboard | `dashboard.html` served by the Worker |
| Translations | AI provider → Workers AI → Google → MyMemory |

---

## 📁 Project Structure

```
xrelaya/
├── worker.js                 # ⚡ Bot: webhook, cron engine, dashboard, /setup
├── dashboard.html            # Dashboard UI (PWA)
├── lib/
│   ├── rss.js                #   feed parser + retweet filter
│   ├── text.js               #   message cards / text helpers
│   ├── translate.js          #   AI / Workers AI / Google / MyMemory
│   ├── db.js                 #   Cloudflare D1 layer
│   ├── telegram.js           #   Bot API client
│   └── budget.js             #   subrequest budget guard
├── schema.sql                # D1 tables
├── wrangler.toml             # Cloudflare config
├── package.json              # deploy/test scripts
├── dev.vars.example          # local dev variables
├── test/worker_logic.test.mjs
├── README_FA.md              # 🇮🇷 Persian docs
└── README.md                 # 🇬🇧 English docs
```

---

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL` | `300` | Displayed in `/status`; the real schedule is in `wrangler.toml` `[triggers]` |
| `ACCOUNTS_PER_CRON` | `5` | Accounts checked per cron run (round-robin) |
| `MAX_TWEETS_PER_CHECK` | `3` | New tweets processed per account per run |
| `SUBREQUEST_BUDGET` | `42` | Outbound calls per run; keep below the free-plan limit of 50 |
| `WEBHOOK_BUDGET` | `20` | Outbound calls per Telegram update |
| `RSS_MIRRORS` | empty | Comma-separated Nitter mirrors with a `{username}` placeholder |
| `FEED_MIRRORS` / `FEED_BATCH` | `6` / `3` | Mirrors per account and parallel requests |
| `TRANSLATE_FA` | `true` | Enable Persian translation |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `REQUESTY_API_KEY` | empty | AI provider key for higher quality translation |
| `TRANSLATION_TIMEOUT` | `20` | Timeout per translation attempt (seconds) |
| `TRANSLATION_RETRIES` | `2` | Attempts per translation provider |
| `TRANSLATION_BACKFILL_LIMIT` | `5` | Saved untranslated tweets repaired per run |
| `MYMEMORY_SOURCE_LANG` | `en` | Source language for the non-Google fallback |
| `MYMEMORY_EMAIL` | empty | Optional MyMemory contact email for higher free limits |
| `SETUP_KEY` | empty | Protects the `/setup` endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | empty | Validates Telegram's webhook header; only `A-Z a-z 0-9 _ -` |
| `WORKERS_AI_MODE` | `auto` | Workers AI backend: `auto` (chat model, then m2m100), `chat`, `translate` |
| `WORKERS_AI_CHAT_MODEL` | `@cf/zai-org/glm-4.7-flash` | Chat model used for translation (`@cf/google/gemma-4-26b-a4b-it` reads Persian better, costs more) |
| `WORKERS_AI_MODEL` | `@cf/meta/m2m100-1.2b` | Workers AI seq2seq backup (`nllb-200-distilled-600M` also works) |
| `DASHBOARD_URL` | Worker origin | Dashboard URL used by the “🌐 داشبورد” button |

Non-secret values live in the `[vars]` block of `wrangler.toml`; secrets go through `wrangler secret put`.

### Free translation without any API key

The `[ai]` binding in `wrangler.toml` is on by default, so the bot translates on
Cloudflare itself: a chat model (`@cf/zai-org/glm-4.7-flash`) writes the Persian,
and `m2m100` stays as a cheap backup if the chat model is unavailable. No key, no
card, and the calls do not consume the 50-subrequest budget because they never
leave the Worker. `/status` prints which backend is live and with which model.

---

## 📝 Notes

- ❌ Private accounts won't work (RSS limitation)
- ✅ Multiple Nitter instances are raced in parallel; the first usable feed wins
- ✅ Retweets/reposts are filtered out; a display name (e.g. `RippleX`) is never mistaken for a handle
- ✅ One Telegram card per tweet: long captions are auto-truncated, never split
- ✅ Translation falls back through Workers AI → Google → MyMemory, and empty results are never cached
- ✅ Workers AI receives full language names (`english`/`persian`); the short ISO codes it rejects are never sent
- ✅ `/health` reports `translation.providers`, `lastTranslationFailure` and the real `webhook` state; `/test <user>` explains each failure in Telegram
- ✅ `/translate?key=<SETUP_KEY>` runs the real provider chain on a sample sentence and returns the per-provider reasons
- ✅ A key pasted into the wrong variable is routed by its shape (`AIza…` → Gemini, `sk-…` → OpenAI)
- ✅ `SETUP_KEY` and `TELEGRAM_WEBHOOK_SECRET` are compared trimmed, so a stray space no longer breaks setup
- ✅ `secret_token` is validated locally before Telegram sees it, with a readable reason instead of an opaque 400
- ✅ Saved tweets with empty translations are backfilled for the dashboard (no duplicate Telegram messages)
- ✅ Tweet media is downloaded locally before upload, so Telegram never has to reach `pbs.twimg.com`
- ✅ Old data is cleaned daily (30 days of `sent_ids`, newest 300 tweets kept)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Misagh95">Misagh95</a>
</p>
