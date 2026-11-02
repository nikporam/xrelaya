<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/f/fd/State_flag_of_Iran_%281964%E2%80%931980%29.svg" width="110" alt="Lion and Sun Flag of Iran">
</p>

# 🐦 ربات تلگرام فالوور توییتر / X

> بدون نیاز به API پولی توییتر — با RSS کار میکنه، روی **Cloudflare Workers** رایگان اجرا میشه.
> هر وقت اکانت‌هایی که اضافه کردی توییت جدید بزنن، مستقیم داخل تلگرام برات میفرسته. با متن + عکس + ترجمه فارسی.

---

### ✨ امکانات

- 🔔 ارسال خودکار توییت‌ها به تلگرام با عکس
- 🦁 ترجمه فارسی خودکار (AI یا Workers AI رایگان یا Google/MyMemory)
- 🚫 فیلتر خودکار ریتوییت‌ها / repostها (بدون افتادن اکانت‌هایی که نام نمایشی‌شان شبیه یوزرنیم است، مثل RippleX)
- 📊 داشبورد وب زنده (PWA) روی همان Worker
- ⚡ پشتیبانی از چندین اکانت با بررسی گردشی و بودجه‌ی درخواست کنترل‌شده
- 🔄 بررسی خودکار هر ۵ دقیقه با Cron کلودفلر
- 💾 دیتابیس D1 کلودفلر — بدون سرور و بدون PostgreSQL

---

### ۱. ساخت ربات تلگرام

1. برو به [@BotFather](https://t.me/BotFather) در تلگرام
2. بزن `/newbot` و اسم و یوزرنیم بده
3. توکنی که بهت میده رو کپی کن (چیزی مثل: `123456:ABC-DEF...`)

---

### ۲. پیش‌نیازها

- **Node.js 20+**
- یک اکانت **Cloudflare** (پلن رایگان کافی است)
- ابزار `wrangler` که با `npm install` نصب می‌شود

```bash
git clone https://github.com/nikporam/xrelaya.git
cd xrelaya
npm install
npx wrangler login
```

---

### ۳. ساخت دیتابیس D1

```bash
npx wrangler d1 create xrelaya-db
```

خروجی این دستور یک `database_id` می‌دهد؛ آن را در `wrangler.toml` جایگزین کن:

```toml
[[d1_databases]]
binding = "DB"
database_name = "xrelaya-db"
database_id = "اینجا-مقدار-واقعی-را-بگذار"
```

بعد جدول‌ها را بساز:

```bash
npx wrangler d1 execute xrelaya-db --remote --file=./schema.sql
```

---

### ۴. توکن‌ها و کلیدهای امنیتی

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # توکن BotFather (الزامی)
npx wrangler secret put SETUP_KEY                 # محافظ آدرس /setup (الزامی)
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # اختیاری ولی توصیه می‌شود
npx wrangler secret put GEMINI_API_KEY            # اختیاری، ترجمه باکیفیت‌تر
```

> کلیدهای AI اختیاری‌اند: `GEMINI_API_KEY` یا `OPENAI_API_KEY` یا `REQUESTY_API_KEY`.

---

### ۵. انتشار

```bash
npx wrangler deploy
```

بعد از deploy **فقط یک‌بار** این آدرس را باز کن تا وبهوک تلگرام و منوی دستورات ثبت شود:

```
https://xrelaya-bot.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>
```

خروجی JSON نشان می‌دهد هر مرحله (`database`, `getMe`, `setMyCommands`, `setWebhook`) موفق بوده یا نه.
داشبورد هم روی همان دامنه (`/`) بالا می‌آید و `/health` وضعیت کلی را برمی‌گرداند.

بعد از این مرحله، در تلگرام به ربات `/start` بفرست.

---

### ۶. تست لوکال

```bash
cp dev.vars.example .dev.vars     # توکن و کلیدها را داخلش بگذار
npx wrangler dev                  # http://localhost:8787
```

برای تست منطق بدون Cloudflare:

```bash
npm test
```

---

### 📱 دستورات تلگرام

| دستور | توضیح |
|-------|-------|
| `/start` | راهنما |
| `/add vitalikbuterin` | اضافه کردن اکانت |
| `/add user1 user2` | اضافه چند اکانت همزمان |
| `/del vitalikbuterin` | حذف اکانت |
| `/list` | لیست اکانت‌های دنبال‌شده |
| `/test` | تست سریع با @ElonMusk |
| `/search متن` | جستجو در توییت‌های ذخیره‌شده |
| `/status` | وضعیت ربات |

---

### ⚙️ تنظیمات

| متغیر | پیش‌فرض | توضیح |
|-------|---------|-------|
| `CHECK_INTERVAL` | `300` | فاصله بررسی (فقط برای نمایش در `/status`) |
| `ACCOUNTS_PER_CRON` | `5` | تعداد اکانتی که در هر اجرای کرون بررسی می‌شود |
| `MAX_TWEETS_PER_CHECK` | `3` | تعداد توییت جدید پردازش‌شده برای هر اکانت در هر اجرا |
| `SUBREQUEST_BUDGET` | `42` | سقف درخواست خروجی در هر اجرا؛ کمتر از سقف ۵۰ پلن رایگان |
| `WEBHOOK_BUDGET` | `20` | سقف درخواست خروجی در هر آپدیت تلگرام |
| `RSS_MIRRORS` | خالی | لیست میرورهای Nitter جدا شده با کاما، با پلیس‌هولدر `{username}` |
| `FEED_MIRRORS` / `FEED_BATCH` | `6` / `3` | تعداد میرورهای هر اکانت و تعداد درخواست موازی |
| `TRANSLATE_FA` | `true` | فعال بودن ترجمه فارسی |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `REQUESTY_API_KEY` | خالی | کلید سرویس AI برای ترجمه باکیفیت‌تر |
| `TRANSLATION_TIMEOUT` | `20` | تایم‌اوت هر تلاش ترجمه (ثانیه) |
| `TRANSLATION_RETRIES` | `2` | تعداد تلاش دوباره برای هر سرویس ترجمه |
| `TRANSLATION_BACKFILL_LIMIT` | `5` | تعداد توییت بدون ترجمه که در هر اجرا ترمیم می‌شود |
| `MYMEMORY_SOURCE_LANG` | `en` | زبان مبدأ برای fallback غیرگوگلی |
| `MYMEMORY_EMAIL` | خالی | ایمیل اختیاری برای سقف رایگان بالاتر MyMemory |
| `SETUP_KEY` | خالی | کلید محافظ آدرس `/setup` |
| `TELEGRAM_WEBHOOK_SECRET` | خالی | توکن تأیید هدر تلگرام؛ فقط `A-Z a-z 0-9 _ -` مجاز است |
| `WORKERS_AI_MODE` | `auto` | بک‌اند Workers AI: `auto` (اول مدل چت، بعد m2m100)، `chat`، `translate` |
| `WORKERS_AI_CHAT_MODEL` | `@cf/zai-org/glm-4.7-flash` | مدل چت برای ترجمه (برای فارسی `@cf/google/gemma-4-26b-a4b-it` بهتر است، مصرف بیشتری دارد) |
| `WORKERS_AI_MODEL` | `@cf/meta/m2m100-1.2b` | مدل ترجمه‌ی پشتیبان Workers AI (`nllb-200-distilled-600M` هم کار می‌کند) |
| `DASHBOARD_URL` | دامنه Worker | آدرس داشبورد برای دکمه‌ی «🌐 داشبورد» |

### ترجمه‌ی رایگان بدون هیچ کلید API

بخش `[ai]` در `wrangler.toml` به‌طور پیش‌فرض روشن است، پس ربات روی خود کلودفلر ترجمه می‌کند:
یک مدل چت (`@cf/zai-org/glm-4.7-flash`) فارسیِ طبیعی می‌نویسد و `m2m100` پشتیبان ارزان است.
بدون کلید، بدون کارت اعتباری، و چون درخواست‌ها از Worker بیرون نمی‌روند از بودجه‌ی ۵۰ subrequest چیزی کم نمی‌شود.
`/status` می‌گوید کدام بک‌اند و کدام مدل فعال است.

**دیدن وضعیت واقعی:**
```bash
# تست زنده‌ی ترجمه — دقیقاً می‌گوید کدام سرویس چرا شکست خورد
curl "https://<worker>/translate?key=<SETUP_KEY>"

# وضعیت کلی + آخرین خطای ترجمه
curl "https://<worker>/health"
```
در تلگرام هم `/status` وضعیت هر سرویس و آخرین خطا را نشان می‌دهد و `/test nasa` دلیل دقیق شکست را می‌فرستد.

**کلید در هر متغیری:** اگر کلید Gemini را اشتباهی در `REQUESTY_API_KEY` بگذاری، ربات از روی شکل کلید (`AIza…`) آن را تشخیص می‌دهد و به endpoint درست Gemini می‌فرستد. کلیدهای `sk-…` به OpenAI می‌روند.

---

### 📝 نکات

- اکانت‌های **خصوصی / Private** کار نمیکنن (محدودیت RSS)
- اگر یک Nitter فیلتر بود، ربات خودش از بقیه امتحان میکنه
- ریتوییت‌ها/repostها فیلتر میشن و ارسال نمیشن؛ فیلتر فقط به یوزرنیم واقعی (یعنی لینک استاتوس یا `@handle` موجود در فید) نگاه می‌کنه و نام نمایشی هرگز جای یوزرنیم حساب نمیشه
- هر توییت به صورت یک کارت تکی در تلگرام ارسال می‌شود؛ در صورت طولانی شدن کپشن، متن و ترجمه به صورت خودکار خلاصه می‌شوند
- ترجمه با چند بار تلاش دوباره انجام میشه و اگر AI خطا بده، از Workers AI / Google / MyMemory استفاده میشه
- Workers AI نام کامل زبان می‌خواهد (`english` / `persian`) نه کد کوتاه (`en` / `fa`) — این تبدیل در کد انجام می‌شود
- `SETUP_KEY` و `TELEGRAM_WEBHOOK_SECRET` هنگام مقایسه `trim` می‌شوند، پس فاصله‌ی اضافه دیگر باعث خطا نمی‌شود
- `secret_token` قبل از ارسال به تلگرام اعتبارسنجی می‌شود و کاراکتر غیرمجاز با پیام روشن گزارش می‌شود
- توییت‌های ذخیره‌شده‌ای که ترجمه خالی دارند، در اجراهای بعدی برای داشبورد بک‌فیل می‌شوند (بدون پیام تکراری در تلگرام)
- توییت‌ها با عکس ارسال میشن؛ عکس قبل از ارسال دانلود می‌شود تا تلگرام به pbs.twimg.com وابسته نباشد
- تصاویر با lazy loading در داشبورد بارگذاری میشن و Service Worker برای حالت آفلاین فعاله
- داده‌های قدیمی هر روز ساعت ۳ بامداد UTC پاک‌سازی میشن (۳۰ روز برای `sent_ids`، نگه‌داشتن ۳۰۰ توییت آخر)

---

### 🛠 ساختار پروژه

```
xrelaya/
├── worker.js                 # ⚡ ربات کامل: وبهوک، کرون، داشبورد، /setup
├── dashboard.html            # داشبورد وب (PWA)
├── lib/
│   ├── rss.js                #   پارس فید + فیلتر ریتوییت
│   ├── text.js               #   ساخت کارت پیام و ابزارهای متن
│   ├── translate.js          #   ترجمه با AI / Workers AI / Google / MyMemory
│   ├── db.js                 #   لایه Cloudflare D1
│   ├── telegram.js           #   کلاینت Bot API
│   └── budget.js             #   بودجه‌ی درخواست‌های خروجی
├── schema.sql                # جدول‌های D1
├── wrangler.toml             # تنظیمات Cloudflare
├── package.json              # اسکریپت‌های deploy/test
├── dev.vars.example          # نمونه متغیرهای اجرای لوکال
├── test/worker_logic.test.mjs
├── README_FA.md              # 🇮🇷 همین فایل
└── README.md                 # 🇬🇧 مستندات انگلیسی
```
