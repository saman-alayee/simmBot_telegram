import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { buildListingsExcelTemplateBuffer } from '../../src/import/excel-import.js';

const outDir = path.join(process.cwd(), 'templates');
const outFile = path.join(outDir, 'listings-import-template.xlsx');
const sampleFile = path.join(outDir, 'sample-listings-demo.xlsx');

const header = ['سیم‌کارت', 'قیمت', 'وضعیت', 'توضیحات', 'مالک', 'انبار', 'تاریخ سند'];

/** چند خط نمونه برای تست لوکال (مالک تست / انبار تست از اسکیمای محلی) */
const demoRows = [
  header,
  ['0912 111 22 33', 420000000, 'کارکرده', 'نمونه ۱', 'مالک تست', 'انبار تست', '1405/08/01'],
  ['0912 222 33 44', 510000000, 'خوش‌شماره', 'نمونه ۲', 'مالک تست', 'انبار تست', '1405/08/05'],
  ['0912 333 44 55', 390000000, 'زیرقیمت', '-', 'مالک تست', 'انبار تست', ''],
  ['0912 444 55 66', 650000000, 'کارکرده', 'رند', 'مالک تست', 'انبار تست', '1405/08/10'],
  ['0912 555 66 77', 280000000, 'کارکرده', 'اقتصادی', 'مالک تست', 'انبار تست', '1405/08/15']
];

const guide = [
  ['راهنمای ورود دسته‌ای خطوط'],
  [''],
  ['ستون', 'توضیح'],
  ['سیم‌کارت', 'الزامی — 0912 با ۱۱ رقم'],
  ['قیمت', 'الزامی — مبلغ به تومان (مثلاً 580000000)'],
  ['وضعیت', 'اختیاری — در توضیح آگهی می‌آید (وضعیت سیستم: موجود)'],
  ['توضیحات', 'اختیاری — توضیح تکمیلی'],
  ['مالک', 'اختیاری — باید دقیقاً با نام مالک فعال در ربات یکی باشد؛ خالی = بدون مالک'],
  ['انبار', 'اختیاری — باید دقیقاً با نام انبار فعال یکی باشد؛ خالی = بدون انبار'],
  ['تاریخ سند', 'اختیاری — شمسی 1405/07/25 یا میلادی'],
  [''],
  ['بعد از آپلود: هر خط موفق در دیتابیس ثبت و در کانال (CHANNEL_ID) منتشر/به‌روز می‌شود.'],
  ['فایل را در تلگرام برای ربات بفرستید (فرمت .xlsx).'],
  ['دستور دریافت قالب: /excel'],
  ['نمونه پر شده (لوکال): templates/sample-listings-demo.xlsx']
];

function writeWorkbook(filePath, linesSheet) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linesSheet), 'خطوط');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), 'راهنما');
  XLSX.writeFile(wb, filePath);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buildListingsExcelTemplateBuffer());
writeWorkbook(sampleFile, demoRows);
console.log('نوشته شد:', outFile);
console.log('نوشته شد:', sampleFile);
