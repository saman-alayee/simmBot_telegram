import * as XLSX from 'xlsx';
import { parseDateInput } from '../domain/format.js';
import { parseExcelAd } from '../domain/logic.js';

export const LISTINGS_EXCEL_TEMPLATE = 'templates/listings-import-template.xlsx';

const TEMPLATE_HEADER = ['سیم‌کارت', 'قیمت', 'وضعیت', 'توضیحات', 'مالک', 'انبار', 'تاریخ سند'];

const TEMPLATE_LINES = [
  TEMPLATE_HEADER,
  ['0912 157 27 58', 580000000, 'کارکرده', 'نمونه — رند', 'نام دقیق مالک در سیستم', 'نام دقیق انبار', '1405/07/25'],
  ['09124561595', 350000000, 'زیرقیمت', '-', '', '', '']
];

const TEMPLATE_GUIDE = [
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
  ['دستور دریافت قالب: /excel']
];

/** بافر قالب .xlsx برای ارسال در تلگرام (بدون وابستگی به فایل روی دیسک — مناسب Vercel). */
export function buildListingsExcelTemplateBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TEMPLATE_LINES), 'خطوط');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TEMPLATE_GUIDE), 'راهنما');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function invalidExcelRowReason(row) {
  const source = row || {};
  const phoneRaw = source['سیم‌کارت'] ?? source['سیم کارت'] ?? source['شماره'];
  const digits = String(phoneRaw ?? '').replace(/\D/g, '');
  if (!digits) return 'شماره خالی';
  if (!/^0912\d{7}$/.test(digits)) return 'شماره باید 0912 با ۱۱ رقم باشد';
  const price = Number(String(source['قیمت'] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return 'قیمت نامعتبر';
  const dateRaw = source['تاریخ سند'] ?? source['تاریخ آماده سند'] ?? '';
  const dateText = String(dateRaw ?? '').trim();
  if (dateText && !parseDateInput(dateText)) return 'تاریخ سند نامعتبر';
  return 'ردیف نامعتبر';
}

/** @returns {{ ads: import('../domain/logic.js').parseExcelAd extends (...args: any) => infer R ? R[] : never, invalidRows: { row: number, reason: string }[], duplicatePhones: { phone: string, count: number, rows: number[] }[], sheetRowCount: number }} */
export function analyzeExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames.find((name) => name === 'خطوط') || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true });
  const invalidRows = [];
  const byPhone = new Map();
  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const excelRow = i + 2;
    const ad = parseExcelAd(rows[i]);
    if (!ad) {
      if (Object.values(rows[i] || {}).some((v) => String(v ?? '').trim() !== '')) {
        invalidRows.push({ row: excelRow, reason: invalidExcelRowReason(rows[i]) });
      }
      continue;
    }
    parsed.push({ ...ad, excelRow });
    const bucket = byPhone.get(ad.phone) || { phone: ad.phone, count: 0, rows: [] };
    bucket.count += 1;
    bucket.rows.push(excelRow);
    byPhone.set(ad.phone, bucket);
  }
  const duplicatePhones = [...byPhone.values()].filter((item) => item.count > 1);
  const ads = [...new Map(parsed.map((ad) => [ad.phone, ad])).values()];
  return { ads, invalidRows, duplicatePhones, sheetRowCount: rows.length };
}

export function listingAdsFromExcelBuffer(buffer) {
  return analyzeExcelBuffer(buffer).ads;
}
