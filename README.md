# SamiSIM0912Bot

ربات تلگرام فروش سیم‌کارت ۰۹۱۲ — Vercel + PostgreSQL.

## اجرای محلی

```bash
npm install
npm run local:bootstrap   # اولین بار
npm run local             # polling + Postgres embedded
```

تنظیمات در `.env.local`.

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
