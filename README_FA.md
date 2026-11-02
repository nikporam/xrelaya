<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/f/fd/State_flag_of_Iran_%281964%E2%80%931980%29.svg" width="110" alt="Lion and Sun Flag of Iran">
</p>

# 🐦 ربات تلگرام فالوور توییتر / X

> بدون نیاز به API پولی توییتر — با RSS کار میکنه.
> هر وقت اکانت‌هایی که اضافه کردی توییت جدید بزنن، مستقیم داخل تلگرام برات میفرسته. با متن + عکس + ترجمه فارسی.

---

### ✨ امکانات

- 🔔 ارسال خودکار توییت‌ها به تلگرام با عکس
- 🦁 ترجمه فارسی خودکار (با هوش مصنوعی یا Google Translate)
- 🚫 فیلتر خودکار ریتوییت‌ها / repostها (بدون افتادن اکانت‌هایی که نام نمایشی‌شان شبیه یوزرنیم است، مثل RippleX)
- 📊 داشبورد وب زنده (PWA)
- ⚡ پشتیبانی از چندین اکانت با دریافت و ترجمه کنترل‌شده برای جلوگیری از محدودیت سرویس‌ها
- 🔄 بررسی خودکار هر ۵ دقیقه

---

### ۱. ساخت ربات تلگرام

1. برو به [@BotFather](https://t.me/BotFather) در تلگرام
2. بزن `/newbot` و اسم و یوزرنیم بده
3. توکنی که بهت میده رو کپی کن (چیزی مثل: `123456:ABC-DEF...`)

---

### ۲. نصب و راه‌اندازی

```bash
# کلون کردن پروژه
git clone https://github.com/YOUR_USER/twitter-telegram-bot.git
cd twitter-telegram-bot

# نصب وابستگی‌ها
pip install -r requirements.txt
```

یک فایل `.env` بساز و این داخلش بزار:

```env
TELEGRAM_BOT_TOKEN=توکنی که از BotFather گرفتی
ADMIN_CHAT_ID=چت آیدی خودت (اختیاری)

# ترجمه فارسی (اختیاری)
TRANSLATE_FA=true
# می‌تونی REQUESTY_API_KEY یا GEMINI_API_KEY استفاده کنی
REQUESTY_API_KEY=your_requesty_or_gemini_key
REQUESTY_BASE_URL=https://api.openai.com/v1
REQUESTY_MODEL=gpt-4o-mini
```

---

### ۳. تست لوکال

```bash
# اجرای مستقیم
python twitter_telegram_bot.py
```

ربات روشن میشه. یه پیام `/start` بفرست به رباتت توی تلگرام.

**دستورات تلگرام:**

| دستور | توضیح |
|-------|-------|
| `/start` | راهنما |
| `/add vitalikbuterin` | اضافه کردن اکانت |
| `/add user1 user2` | اضافه چند اکانت همزمان |
| `/del vitalikbuterin` | حذف اکانت |
| `/list` | لیست اکانت‌های دنبال‌شده |
| `/test` | تست سریع با @ElonMusk |

---

### ۴. دیتابیس (PostgreSQL)

برای استفاده از Railway رایگان:

1. Railway.app → یه پروژه بساز
2. PostgreSQL دیتابیس اضافه کن
3. متغیر `DATABASE_URL` خودکار ست میشه

---

### ۵. اجرای رایگان روی Cloudflare Workers (بدون سرور)

همین ربات + داشبورد + دیتابیس، بدون هیچ سرور و VPS، روی **پلن رایگان Cloudflare** هم اجرا می‌شود.
فایل‌های مربوطه: `worker.js` (منطق ربات) و پوشه `lib/` (فیلتر ریتوییت، ترجمه، RSS، D1، تلگرام) و `dashboard.html` (داشبورد).

| نسخه پایتون (Railway/VPS) | نسخه Cloudflare |
|---|---|
| `python-telegram-bot` + Long Polling | **Webhook** تلگرام (`POST /telegram`) |
| `job_queue` هر ۵ دقیقه | **Cron Trigger** کلودفلر |
| PostgreSQL + `psycopg2` | **Cloudflare D1** (SQLite) |
| FastAPI + Jinja | خود Worker + `dashboard.html` |

**پیش‌نیاز:** Node.js 20+ و یک اکانت Cloudflare (پلن رایگان کافی است).

```bash
npm install

# ۱) ساخت دیتابیس D1 — مقدار database_id خروجی را در wrangler.toml بگذار
npx wrangler d1 create xrelaya-db

# ۲) ساخت جدول‌ها
npx wrangler d1 execute xrelaya-db --remote --file=./schema.sql

# ۳) توکن‌ها و کلیدهای امنیتی
npx wrangler secret put TELEGRAM_BOT_TOKEN     # از BotFather
npx wrangler secret put SETUP_KEY              # محافظ آدرس /setup
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # اختیاری ولی توصیه می‌شود
npx wrangler secret put GEMINI_API_KEY         # اختیاری، ترجمه باکیفیت‌تر

# ۴) انتشار
npx wrangler deploy
```

بعد از deploy فقط یک‌بار این آدرس را باز کن تا وب‌هوک تلگرام و منوی دستورات ثبت شود:

```
https://xrelaya-bot.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>
```

خروجی JSON نشان می‌دهد هر مرحله (`database`, `getMe`, `setMyCommands`, `setWebhook`) موفق بوده یا نه.
داشبورد هم روی همان دامنه (`/`) بالا می‌آید.

**نکته‌های مهم Cloudflare:**

- **کرون هر ۵ دقیقه** اجرا می‌شود (`triggers.crons` در `wrangler.toml`) و در هر اجرا به‌صورت گردشی (`ACCOUNTS_PER_CRON`) چند اکانت را چک می‌کند؛ پس با هر تعداد اکانت، همه‌شان به‌ترتیب بررسی می‌شوند.
- **سقف ۵۰ درخواست خروجی در هر اجرا (پلن رایگان):** ربات خودش بودجه‌ی `SUBREQUEST_BUDGET` را رعایت می‌کند و اگر کم بیاید، بقیه توییت‌ها را به اجرای بعدی موکول می‌کند (هیچ توییتی از دست نمی‌رود و ارسال تکراری هم نداریم).
- **ترجمه رایگان بدون API Key:** اگر در `wrangler.toml` بخش `[ai]` را از کامنت خارج کنی، ترجمه با مدل رایگان Workers AI (`@cf/meta/m2m100-1.2b`) انجام می‌شود؛ در غیر این صورت همان Google/MyMemory fallback کار می‌کند.
- **تغییر میرورهای Nitter بدون deploy:** متغیر `RSS_MIRRORS` را با لیست دلخواه (جدا شده با کاما و حاوی `{username}`) ست کن.
- **اجرای لوکال:** `cp dev.vars.example .dev.vars` و بعد `npx wrangler dev`.
- **تست منطق بدون Cloudflare:** `npm test` (تست‌های فیلتر ریتوییت، ساخت کارت پیام، پارس RSS و ترجمه).

### ۶. هاست ۲۴ ساعته رایگان

برای اینکه همیشه روشن باشه، روی یکی از اینها رایگان دیپلوی کن:

- **Railway.app** — ساده‌ترین (۵$ credit رایگان ماهانه)
- **Render.com** — plan رایگان
- یا روی یک سرور VPS خودت

فقط کافیه فایل‌ها رو آپلود کنی و متغیرهای محیطی رو ست کنی.

---

### ⚙️ تنظیمات

| متغیر | پیش‌فرض | توضیح |
|-------|---------|-------|
| `CHECK_INTERVAL` | `300` | فاصله بررسی (ثانیه) |
| `REQUESTY_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | خالی | کلید سرویس AI برای ترجمه باکیفیت‌تر |
| `CONCURRENT_LIMIT` | `3` | تعداد درخواست همزمان برای دریافت فید |
| `TRANSLATION_TIMEOUT` | `20` | تایم‌اوت هر تلاش ترجمه (ثانیه) |
| `TRANSLATION_RETRIES` | `2` | تعداد تلاش دوباره برای تلاش‌های اصلی AI/Google |
| `TRANSLATION_CONCURRENT_LIMIT` | `1` | تعداد ترجمه همزمان (برای جلوگیری از محدودیت گوگل کم نگه دار) |
| `TRANSLATION_BACKFILL_LIMIT` | `15` | تعداد توییت‌های بدون ترجمه که در هر نوبت ترمیم می‌شوند |
| `MAX_TWEETS_PER_CHECK` | `10` | تعداد توییت جدید پردازش‌شده برای هر اکانت در هر بررسی |
| `MYMEMORY_SOURCE_LANG` | `en` | زبان مبدأ برای fallback غیرگوگلی ترجمه |
| `MYMEMORY_EMAIL` | خالی | ایمیل اختیاری برای سقف رایگان بالاتر MyMemory |
| `LOG_LEVEL` | `INFO` | روی `DEBUG` بگذار تا دلیل نگه‌داشتن یا حذف هر آیتم فید لاگ شود |
| `ACCOUNTS_PER_CRON` | `5` | (Cloudflare) تعداد اکانتی که در هر اجرای کرون بررسی می‌شود |
| `MAX_TWEETS_PER_CHECK` | `3` | (Cloudflare) تعداد توییت جدید پردازش‌شده برای هر اکانت در هر اجرا |
| `SUBREQUEST_BUDGET` | `42` | (Cloudflare) سقف درخواست خروجی در هر اجرا؛ کمتر از سقف ۵۰ پلن رایگان |
| `RSS_MIRRORS` | خالی | (Cloudflare) لیست میرورهای Nitter جدا شده با کاما، با پلیس‌هولدر `{username}` |
| `FEED_MIRRORS` / `FEED_BATCH` | `6` / `3` | (Cloudflare) تعداد میرورهای هر اکانت و تعداد درخواست موازی |
| `SETUP_KEY` | خالی | (Cloudflare) کلید محافظ آدرس `/setup` |
| `TELEGRAM_WEBHOOK_SECRET` | خالی | (Cloudflare) توکن تأیید هدر تلگرام برای وبهوک |

---

### 📝 نکات

- اکانت‌های **خصوصی / Private** کار نمیکنن
- اگر یک Nitter فیلتر بود، ربات خودش از بقیه امتحان میکنه
- ریتوییت‌ها/repostها فیلتر میشن و ارسال نمیشن؛ فیلتر فقط به یوزرنیم واقعی (یعنی لینک استاتوس یا `@handle` موجود در فید) نگاه می‌کنه و نام نمایشی هرگز جای یوزرنیم حساب نمیشه
- با `LOG_LEVEL=DEBUG` دلیل حذف هر توییت لاگ میشه (مثلاً `Skip @nasa 123: status link is @nasa`)
- هر توییت به صورت یک کارت تکی در تلگرام ارسال می‌شود؛ در صورت طولانی شدن کپشن، متن و ترجمه به صورت خودکار خلاصه می‌شوند و هرگز پیام جداگانه‌ای ارسال نمی‌شود
- ترجمه با چند بار تلاش دوباره انجام میشه و اگر AI خطا بده، از Google/MyMemory fallback استفاده میشه
- توییت‌های ذخیره‌شده‌ای که ترجمه خالی دارند، به صورت خودکار در پس‌زمینه برای دیتابیس و داشبورد بک‌فیل می‌شوند و پیام جداگانه به تلگرام فرستاده نمی‌شود
- توییت‌ها با عکس هم ارسال میشن
- تصاویر با lazy loading در وب داشبورد بارگذاری میشن
- Service Worker برای حالت آفلاین فعاله

---

### 🛠 ساختار پروژه

```
twitter-telegram-bot/
├── twitter_telegram_bot.py   # ربات اصلی + وب سرور (نسخه پایتون)
├── database.py               # مدیریت PostgreSQL (نسخه پایتون)
├── web_server.py             # سرور وب (اختیاری)
├── templates/index.html      # قالب داشبورد وب (نسخه پایتون)
├── sw.js                     # Service Worker
├── manifest.json             # PWA Manifest
├── requirements.txt          # وابستگی‌ها
├── Procfile                  # فایل هاست
│
├── worker.js                 # ⚡ ربات کامل برای Cloudflare Workers
├── dashboard.html            # داشبورد نسخه Cloudflare
├── lib/                      # ماژول‌های Worker
│   ├── rss.js                #   پارس فید + فیلتر ریتوییت
│   ├── text.js               #   ساخت کارت پیام/ترجمه متن
│   ├── translate.js          #   ترجمه با AI/Google/MyMemory/Workers AI
│   ├── db.js                 #   لایه Cloudflare D1
│   ├── telegram.js           #   کلاینت Bot API
│   └── budget.js             #   محدودکننده درخواست‌های خروجی
├── schema.sql                # جدول‌های D1
├── wrangler.toml             # تنظیمات Cloudflare
├── package.json              # اسکریپت‌های deploy/test
└── dev.vars.example          # نمونه متغیرهای اجرای لوکال
```
