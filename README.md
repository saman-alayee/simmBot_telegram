# SamiSIM0912Bot

ربات تلگرام فروش سیم‌کارت ۰۹۱۲ — Vercel + PostgreSQL.

## اجرای محلی

```bash
npm install
npm run local:bootstrap   # اولین بار
npm run local             # polling + Postgres embedded
```

- **محلی:** `.env.local` (`npm run local`)
- **Vercel:** `vercel.env` (از `vercel.env.example` کپی کنید؛ commit نمی‌شود)

## Deploy روی Vercel (Hobby)

1. GitHub را Import کن؛ **Project Name** فقط حروف کوچک (مثلاً `simm-bot-telegram`).
2. **Environment Variables** → Production: محتوای `vercel.env` را paste کن (`DATABASE_URL` = Neon واقعی).
3. Deploy. Cron در `vercel.json` یک بار در روز است (`0 3 * * *`) — محدودیت Hobby.
4. بعد از deploy: `PUBLIC_BASE_URL` و `PUBLIC_CALC_BASE_URL` را با دامنه واقعی `.vercel.app` یکی کن → Redeploy.
5. Webhook (وقتی `npm run local` خاموش است):  
   `https://<domain>/api/setup?key=<SETUP_KEY>`

برای cron هر ۱۵ دقیقه → Pro یا cron خارجی به `/api/cron` با `Authorization: Bearer CRON_SECRET` (جزئیات در `docs/telegram-production-checklist.md`).

## اسکریپت‌ها

| npm | کار |
|-----|-----|
| `test` | تست واحد |
| `test:all` | bootstrap + spec + channel-e2e |
| `excel-template` | ساخت `templates/listings-import-template.xlsx` |
| `regenerate-invoices` | بازسازی PDF فاکتورها |

## ساختار پوشه‌ها

```
api/              ورود HTTP برای Vercel (telegram, calc, cron, setup)
src/
  database/       sql.js, schema.js
  bot/            router, data, jobs, commands
  domain/         logic, format, installment-config
  channel/        متن پست کانال
  telegram/       entity و parse_mode
  import/         اکسل
  invoice/        PDF و قالب فاکتور
  web/            صفحه HTML اقساط
scripts/
  dev/            bootstrap, Postgres محلی, local-server
  test/           spec-compliance, e2e
  ops/            admin، فاکتور، قالب اکسل
assets/           HTML قالب فاکتور
src/fonts/        فونت PDF (Vazirmatn)
templates/        فایل‌های xlsx (بعد از excel-template)
test/             تست Node
docs/             چک‌لیست production
```

Partner commands (legacy doc): `/partners`, `/addpartner`, `/removepartner`, `/togglepartner`.
