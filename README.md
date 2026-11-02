<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/f/fd/State_flag_of_Iran_%281964%E2%80%931980%29.svg" width="110" alt="Lion and Sun Flag of Iran">
</p>

<h1 align="center">🐦 Twitter/X → Telegram Bot</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white" alt="Telegram">
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white" alt="FastAPI">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Gemini-AI-8B5CF6?logo=google&logoColor=white" alt="Gemini AI">
</p>

<p align="center">
  <b>Forward tweets to Telegram — no paid API needed.</b><br>
  Uses RSS feeds. Supports AI-powered Persian translation.<br>
  Includes a live web dashboard + PWA.
</p>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Auto Forward** | Tweets delivered to Telegram automatically |
| 🦁 **AI Translation** | Gemini / Google Translate to Persian |
| 🚫 **Retweet Filter** | Skips retweets/reposts, without misreading display names as handles |
| 🖼️ **Media Support** | Photos included with tweets |
| 📊 **Live Dashboard** | Web UI to view all tweets |
| 🔍 **Inline Search** | Search tweets from any chat |
| ⌨️ **Keyboard Menu** | Quick buttons for easy use |
| 🌐 **PWA Support** | Installable web app |
| ⚡ **Parallel Fetching** | Feed checks are throttled for reliability |
| 🧠 **Smart Caching** | Translation cache (500 entries) |
| 🛡️ **Auto Recovery** | DB reconnect + API fallback |
| 📱 **Mobile Friendly** | Responsive dark UI |

---

## 🚀 Quick Start

### 1. Create Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot` and choose a name & username
3. Copy the token (looks like: `123456:ABC-DEF...`)

### 2. Install

```bash
git clone https://github.com/Misagh95/twitter-telegram-bot.git
cd twitter-telegram-bot
pip install -r requirements.txt
```

### 3. Configure

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# AI Translation (optional)
TRANSLATE_FA=true
# You can use REQUESTY_API_KEY or GEMINI_API_KEY
REQUESTY_API_KEY=your_gemini_api_key
REQUESTY_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
REQUESTY_MODEL=gemini-2.0-flash
```

### 4. Run

```bash
python twitter_telegram_bot.py
```

Open `http://localhost:8080` for the live dashboard.

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

## ⚡ Deploy to Cloudflare Workers (free, no server)

The whole bot also runs on Cloudflare's free plan — no VPS, no long polling, no Postgres.
Files: `worker.js` + `lib/` (RSS/filter, translation, D1, Telegram) + `dashboard.html`.

| Python version (Railway/VPS) | Cloudflare version |
|---|---|
| `python-telegram-bot` long polling | Telegram **webhook** (`POST /telegram`) |
| `job_queue` every 5 minutes | **Cron Trigger** |
| PostgreSQL + `psycopg2` | **Cloudflare D1** (SQLite) |
| FastAPI + Jinja | the Worker itself + `dashboard.html` |

```bash
npm install

# 1) Create the D1 database — put the printed database_id into wrangler.toml
npx wrangler d1 create xrelaya-db

# 2) Create the tables
npx wrangler d1 execute xrelaya-db --remote --file=./schema.sql

# 3) Secrets
npx wrangler secret put TELEGRAM_BOT_TOKEN      # from @BotFather
npx wrangler secret put SETUP_KEY               # protects /setup
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # optional, recommended
npx wrangler secret put GEMINI_API_KEY          # optional, better translation

# 4) Deploy
npx wrangler deploy
```

Then open this once to register the webhook and the bot menu:

```
https://xrelaya-bot.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>
```

It returns JSON showing whether `database`, `getMe`, `setMyCommands` and `setWebhook` succeeded.
The dashboard is served at `/` on the same domain.

**Cloudflare notes**

- The cron runs every 5 minutes and checks `ACCOUNTS_PER_CRON` accounts per run, round-robin, so any number of tracked accounts keeps working.
- The free plan allows 50 outbound `fetch()` calls per invocation. The bot budgets itself (`SUBREQUEST_BUDGET`, default 42) and postpones the rest to the next run — no tweet is lost and nothing is sent twice.
- **Free translation without an API key:** uncomment the `[ai]` block in `wrangler.toml` and the bot uses Workers AI (`@cf/meta/m2m100-1.2b`); otherwise it falls back to Google/MyMemory.
- Change Nitter mirrors without redeploying: set `RSS_MIRRORS` (comma separated, `{username}` placeholder).
- Local run: `cp dev.vars.example .dev.vars` then `npx wrangler dev`. Tests: `npm test`.

---

## 🌐 Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. **New Project** → **Deploy from GitHub Repo**
4. Select your repo
5. Add **PostgreSQL** database
6. Set environment variables:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token |
| `DATABASE_URL` | Auto-set by Railway |
| `REQUESTY_API_KEY` | Your Gemini key |
| `REQUESTY_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `REQUESTY_MODEL` | `gemini-2.0-flash` |
| `TRANSLATE_FA` | `true` |

7. Deploy! 🎉

---

## 📁 Project Structure

```
twitter-telegram-bot/
├── twitter_telegram_bot.py   # Main bot + web server (Python version)
├── database.py               # PostgreSQL manager (Python version)
├── templates/
│   └── index.html            # Dashboard UI (PWA, Python version)
├── sw.js                     # Service Worker
├── manifest.json             # PWA manifest
├── requirements.txt          # Dependencies
├── Procfile                  # Railway config
├── README_FA.md              # 🇮🇷 Persian docs
├── README.md                 # 🇬🇧 English docs
│
├── worker.js                 # ⚡ Full bot for Cloudflare Workers
├── dashboard.html            # Cloudflare dashboard
├── lib/
│   ├── rss.js                #   feed parser + retweet filter
│   ├── text.js               #   message cards / text helpers
│   ├── translate.js          #   AI / Google / MyMemory / Workers AI
│   ├── db.js                 #   Cloudflare D1 layer
│   ├── telegram.js           #   Bot API client
│   └── budget.js             #   subrequest budget guard
├── schema.sql                # D1 tables
├── wrangler.toml             # Cloudflare config
├── package.json              # deploy/test scripts
├── test/worker_logic.test.mjs
└── dev.vars.example          # local dev variables
```

---

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL` | `300` | Check interval (seconds) |
| `TRANSLATE_FA` | `true` | Enable Persian translation |
| `REQUESTY_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | empty | AI provider key for higher quality translation |
| `DASHBOARD_URL` | `http://localhost:8080` | Dashboard URL |
| `CONCURRENT_LIMIT` | `3` | Parallel feed fetch limit |
| `TRANSLATION_TIMEOUT` | `20` | Timeout per translation attempt (seconds) |
| `TRANSLATION_RETRIES` | `2` | Retries for the primary AI/Google translation attempts |
| `TRANSLATION_CONCURRENT_LIMIT` | `1` | Parallel translation calls (keep low to avoid Google rate limits) |
| `TRANSLATION_BACKFILL_LIMIT` | `15` | Saved untranslated tweets repaired per backfill run |
| `MAX_TWEETS_PER_CHECK` | `10` | New tweets processed per account each check |
| `MYMEMORY_SOURCE_LANG` | `en` | Source language for the non-Google fallback translator |
| `MYMEMORY_EMAIL` | empty | Optional MyMemory contact email for higher free limits |
| `LOG_LEVEL` | `INFO` | Set to `DEBUG` to log why each feed entry was kept or skipped |
| `ACCOUNTS_PER_CRON` | `5` | (Cloudflare) accounts checked per cron run |
| `MAX_TWEETS_PER_CHECK` | `3` | (Cloudflare) new tweets processed per account per run |
| `SUBREQUEST_BUDGET` | `42` | (Cloudflare) outbound calls per run; keep below the free-plan limit of 50 |
| `RSS_MIRRORS` | empty | (Cloudflare) comma-separated Nitter mirrors with a `{username}` placeholder |
| `FEED_MIRRORS` / `FEED_BATCH` | `6` / `3` | (Cloudflare) mirrors per account and parallel requests |
| `SETUP_KEY` | empty | (Cloudflare) protects the `/setup` endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | empty | (Cloudflare) validates Telegram's webhook header |

---

## 📝 Notes

- ❌ Private accounts won't work (RSS limitation)
- ✅ Multiple Nitter instances for reliability
- ✅ Bot auto-switches if one instance is down
- ✅ Retweets/reposts are filtered out; a display name (e.g. `RippleX`) is never mistaken for a handle, so accounts stay visible
- ✅ With `LOG_LEVEL=DEBUG` every skipped entry is logged with its reason (e.g. `Skip @nasa 123: status link is @nasa`)
- ✅ Single Telegram card per tweet: long captions are auto-truncated without splitting into separate messages
- ✅ Translation retries + Google/MyMemory fallback when the AI provider fails
- ✅ Saved tweets with empty translations are backfilled automatically for database & dashboard (no duplicate Telegram messages)
- ✅ Deduplication prevents duplicate messages
- ✅ Old data auto-cleaned (30 days)

---

## 🛠️ Tech Stack

- **Backend:** Python 3.10+, python-telegram-bot v22
- **Web:** FastAPI + Jinja2 + Tailwind CSS
- **Database:** PostgreSQL (psycopg2)
- **AI:** Google Gemini API
- **RSS:** feedparser + httpx
- **PWA:** Service Worker + Manifest

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Misagh95">Misagh95</a>
</p>
