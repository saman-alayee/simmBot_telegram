import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayJalali, formatPhoneDisplay, money } from '../domain/format.js';
import { isValidCustomerFullName, normalizeCustomerFullName } from '../domain/logic.js';

const templateDir = fileURLToPath(new URL('../../assets/invoice-template/', import.meta.url));
const htmlPath = path.join(templateDir, 'invoice-template.html');

/** آدرس پیش‌فرض فروشنده روی فاکتور (قابل override با setting store_address) */
export const DEFAULT_STORE_ADDRESS =
  'تهرانپارس پایین تر از میدان شاهد(پروین) روبروی پمپ بنزین نبش کوچه پینه فروشگاه سامی';

export const DEFAULT_STORE_WEB = 'Www.Samiito.com';

export const DEFAULT_STORE_PHONES = '021 77 78 37 57  ·  0912 102 5221  ·  0912 157 37 58';

/** جلوگیری از برعکس شدن اعداد/لatin در متن RTL (PDF و HTML) */
export function formatLtrRun(text) {
  const clean = String(text ?? '').replace(/[\u2066\u2067\u2068\u2069\u200E\u200F]/g, '');
  return `\u2066${clean}\u2069`;
}

/** آدرس «آدرس ما» روی فاکتور — مقدار ذخیره‌شدهٔ قدیمی/تست نادیده گرفته می‌شود. */
export function resolveStoreAddressForInvoice(stored) {
  const s = String(stored ?? '').trim();
  if (!s) return DEFAULT_STORE_ADDRESS;
  if (/محیط تست|تهران\s*[–\-—]\s*تهران/i.test(s)) return DEFAULT_STORE_ADDRESS;
  if (s.length < 20) return DEFAULT_STORE_ADDRESS;
  return s;
}

/** نام فایل PDF ارسالی — تاریخ شمسی + شماره فاکتور */
export function invoicePdfFilename(invoice) {
  const created = invoice?.created_at ? new Date(invoice.created_at) : new Date();
  const datePart = displayJalali(created).replace(/\//g, '-');
  const num = String(invoice?.invoice_number || 'invoice').replace(/[^\w\-./]+/g, '_');
  return `${datePart}_${num}.pdf`;
}

export function invoiceTemplatePaths() {
  return {
    dir: templateDir,
    html: htmlPath,
    logo: path.join(templateDir, 'samiito-logo.png')
  };
}

function formatInvoiceTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '-';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function productName(invoice) {
  const phone = formatPhoneDisplay(invoice.phone_number, invoice.phone_display);
  const cond = invoice.condition_text || 'سیم‌کارت';
  return `سیم‌کارت ${phone} — ${cond}`;
}

function paymentMethod(invoice) {
  if (invoice.sale_type !== 'installment') return 'نقدی';
  const parts = [
    'اقساطی',
    invoice.months ? `${invoice.months} ماه` : null,
    invoice.cash_amount_toman ? `پیش‌پرداخت ${money(invoice.cash_amount_toman)} تومان` : null,
    invoice.monthly_installment_toman ? `هر قسط ${money(invoice.monthly_installment_toman)} تومان` : null
  ].filter(Boolean);
  return parts.join(' · ');
}

function descriptionBlock(invoice) {
  const lines = [];
  if (invoice.sale_type === 'installment') {
    lines.push(`پیش‌پرداخت: ${money(invoice.cash_amount_toman)} تومان`);
    lines.push(`مدت: ${invoice.months || '-'} ماه`);
    lines.push(`هر قسط: ${money(invoice.monthly_installment_toman)} تومان`);
    lines.push(`جمع اقساط: ${money(invoice.total_installment_toman)} تومان`);
  }
  if (Number(invoice.discount_toman) > 0) {
    lines.push(`تخفیف: ${money(invoice.discount_toman)} تومان`);
  }
  lines.push(`قیمت خط: ${money(invoice.price_toman)} تومان`);
  return lines.join('\n') || '-';
}

function totalWords(invoice) {
  const final = Number(invoice.final_toman || 0);
  return `${money(final)} تومان`;
}

/** متغیرهای {{placeholder}} در invoice-template.html */
export function invoiceTemplateContext(invoice) {
  const created = invoice.created_at ? new Date(invoice.created_at) : new Date();
  const storeTitle = String(invoice.store_name || 'سامی')
    .replace(/\s*\(?\s*تست\s*محلی\s*\)?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'سامی';
  const storeAddress = resolveStoreAddressForInvoice(invoice.store_address);
  const storePhonesRaw = (invoice.store_phone || '').trim() || DEFAULT_STORE_PHONES;
  const storePhones = formatLtrRun(storePhonesRaw);
  return {
    store_title: storeTitle,
    store_address: storeAddress,
    store_phones: storePhones,
    store_phones_plain: storePhonesRaw,
    store_web: formatLtrRun(DEFAULT_STORE_WEB),
    store_web_plain: DEFAULT_STORE_WEB,
    store_telegram: formatLtrRun('t.me/samisim0912'),
    store_telegram_plain: 't.me/samisim0912',
    invoice_date: displayJalali(created),
    invoice_time: formatInvoiceTime(created),
    invoice_number: invoice.invoice_number || '-',
    customer_name: (() => {
      const n = normalizeCustomerFullName(invoice.customer_name);
      return isValidCustomerFullName(n) ? n : '-';
    })(),
    national_id: invoice.national_id || '-',
    customer_phone: formatPhoneDisplay(invoice.customer_phone) || invoice.customer_phone || '-',
    birth_date: displayJalali(invoice.birth_date),
    customer_address: invoice.address || '-',
    product_name: productName(invoice),
    quantity: '۱',
    unit_price: `${money(invoice.final_toman)} تومان`,
    total_quantity: '۱',
    total_words: totalWords(invoice),
    total_amount: `${money(invoice.final_toman)} تومان`,
    account_balance: '۰',
    salesperson: invoice.salesperson || '-',
    payment_method: paymentMethod(invoice),
    description: descriptionBlock(invoice)
  };
}
