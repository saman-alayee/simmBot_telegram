import { calcInstallment } from '../database/sql.js';
import { formatPhoneDigits, parseDateInput, toLatinDigits } from './format.js';
import { DEFAULT_INSTALLMENT } from './installment-config.js';

export const OPEN_STATUSES = ['active', 'reserved', 'ready_transfer', 'inactive'];
export { DEFAULT_INSTALLMENT } from './installment-config.js';
export const RESERVE_MS = 60 * 60 * 1000;
export const SOLD_CLEANUP_MS = 48 * 60 * 60 * 1000;
export const SPECIAL_SALE_MS = 60 * 24 * 60 * 60 * 1000;
export const SPECIAL_SALE_RATE = 0.04;

export const PRICE_INCREASE_SCOPES = {
  active: 'فقط موجود (آگهی کانال)',
  open: 'موجود + رزرو + آماده انتقال',
  all_open: 'همه خطوط باز (شامل غیرفعال)'
};

/** افزایش درصدی؛ گرد به نزدیک‌ترین ۱ میلیون تومان */
export function priceAfterPercentIncrease(priceToman, percent) {
  const base = Number(priceToman);
  const pct = Number(percent);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  const raw = base * (1 + pct / 100);
  return Math.max(1_000_000, Math.round(raw / 1_000_000) * 1_000_000);
}

export function encodePriceUpPercent(percent) {
  return String(Math.round(Number(percent) * 10));
}

export function decodePriceUpPercent(token) {
  return Number(token) / 10;
}

/** قیمت جدید به تومان؛ عدد کوچک‌تر از ۱۰۰۰۰ یعنی میلیون. */
/** نام واقعی خریدار برای فاکتور — نه @username تلگرام */
export function isValidCustomerFullName(text, { username } = {}) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (t.length < 5 || !/\s/.test(t)) return false;
  if (/^@\w{3,}$/i.test(t)) return false;
  const un = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (un) {
    const compact = t.replace(/\s+/g, '').toLowerCase();
    if (compact === un || t.toLowerCase() === `@${un}`) return false;
  }
  return true;
}

export function normalizeCustomerFullName(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export function parseListingPriceInput(raw) {
  const text = toLatinDigits(String(raw ?? '').trim()).replace(/,/g, '').replace(/\s+/g, '');
  if (!text) return null;
  const n = Number(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  let toman = n < 10_000 ? Math.round(n * 1_000_000) : Math.round(n);
  toman = Math.max(1_000_000, Math.round(toman / 1_000_000) * 1_000_000);
  return toman;
}

export const PRICE_CHANGE_STATUSES = ['active', 'reserved', 'ready_transfer', 'inactive'];

export function canChangeListingPrice(actor) {
  return canManualDiscount(actor);
}

export const PERMISSIONS = {
  add_listing: 'ثبت سیم‌کارت',
  lookup: 'استعلام خط',
  owners: 'مالکین',
  warehouses: 'انبارها',
  lines: 'لیست خطوط',
  reports: 'گزارش‌ها',
  history: 'تاریخچه',
  invoices: 'فاکتور',
  partners: 'همکاران',
  settings: 'تنظیمات',
  admin_management: 'مدیریت ادمین‌ها'
};

export const ALL_PERMISSIONS = Object.fromEntries(Object.keys(PERMISSIONS).map((key) => [key, true]));

export const FIELD_LABELS = {
  created: 'ثبت اولیه',
  status: 'تغییر وضعیت',
  reserve: 'رزرو',
  reserve_release: 'آزادسازی رزرو',
  reserve_expire: 'انقضای خودکار رزرو',
  sale: 'فروش',
  owner_id: 'تغییر مالک',
  warehouse_id: 'تغییر انبار',
  document_ready_date: 'تغییر تاریخ سند',
  sale_document_status: 'تکمیل سند',
  sale_document_due_date: 'موعد سند فروش',
  reregister: 'ثبت مجدد',
  special_sale: 'فروش ویژه',
  manual_discount: 'تخفیف دستی',
  price_toman: 'تغییر قیمت',
  condition_text: 'تغییر توضیحات'
};

export function isOwner(uid, ownerId) {
  return String(uid) === String(ownerId);
}

/** مالک، مالک مشترک، و ادمین‌های فعال — برای یادآوری سند و اعلان‌های مشابه. */
/** ادمین اولویت ۱ برای واگذاری درخواست خرید؛ اگر ادمین نبود مالک ربات. */
export function primaryPurchaseAssignee(admins = [], env = process.env) {
  const first = admins.find((a) => Number(a.priority) === 1) || admins[0] || null;
  if (first?.telegram_user_id != null && first.telegram_user_id !== '') {
    return {
      telegram_user_id: String(first.telegram_user_id),
      priority: Number(first.priority) || 1,
      display_name: first.display_name || null
    };
  }
  const owner = String(env.OWNER_TELEGRAM_ID || '').trim();
  if (owner && owner.toLowerCase() !== 'auto' && /^\d+$/.test(owner)) {
    return { telegram_user_id: owner, priority: 1, display_name: 'مالک ربات' };
  }
  return null;
}

export function purchaseResponsibleLabel(assignee, adminLabels = {}) {
  if (assignee?.display_name) return assignee.display_name;
  const priority = Number(assignee?.priority);
  if (adminLabels[priority]) return adminLabels[priority];
  return assignee?.telegram_user_id ? `ادمین ${assignee.telegram_user_id}` : 'ادمین';
}

/** واگذاری درخواست خرید به ادمین دیگر: دستی → نه خودِ کلیک‌کننده؛ cron → نه مسئول فعلی. */
export function purchaseHandoffTarget(admins = [], { actorUid, assignedAdminUid } = {}) {
  const list = admins.filter((a) => a && a.active !== false && a.telegram_user_id != null && a.telegram_user_id !== '');
  const exclude = new Set();
  const actor = String(actorUid ?? '').trim();
  const assignedUid = String(assignedAdminUid ?? '').trim();
  if (actor) exclude.add(actor);
  else if (assignedUid) exclude.add(assignedUid);
  const candidates = list.filter((a) => !exclude.has(String(a.telegram_user_id)));
  if (!candidates.length) return null;
  const assigneeRow = list.find((a) => String(a.telegram_user_id) === assignedUid);
  const assignedPriority = Number(assigneeRow?.priority);
  if (Number.isFinite(assignedPriority)) {
    const otherPriority = candidates.find((a) => Number(a.priority) !== assignedPriority);
    if (otherPriority) return otherPriority;
  }
  candidates.sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
  return candidates[0];
}

export function staffNotifyChatIds(env = process.env, admins = []) {
  const ids = [];
  const add = (id) => {
    const value = String(id || '').trim();
    if (!value || value.toLowerCase() === 'auto') return;
    if (!/^\d+$/.test(value)) return;
    if (!ids.includes(value)) ids.push(value);
  };
  add(env.OWNER_TELEGRAM_ID);
  for (const part of String(env.CO_OWNER_TELEGRAM_IDS || '').split(/[\s,;]+/)) add(part);
  const sorted = [...admins].sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
  for (const admin of sorted) add(admin.telegram_user_id);
  return ids;
}

export function allow(uid, ownerId, permissions, key) {
  if (permissions?.bot_owner === true) return true;
  if (isOwner(uid, ownerId)) return true;
  return permissions?.[key] === true;
}

export function isOpenStatus(status) {
  return OPEN_STATUSES.includes(String(status || ''));
}

export function registrationPlan(openListing) {
  return openListing ? 'update' : 'create';
}

export function canAssignOwner({ used, max, alreadyOnThisOwner }) {
  if (alreadyOnThisOwner) return true;
  const cap = Number(max ?? 10);
  return Number(used) < cap;
}

export function capacityLabel(used, max = 10) {
  return `${Number(used)}/${Number(max ?? 10)}`;
}

export function reserveAllowed(status) {
  return String(status) === 'active';
}

/** فقط رزروکننده یا مالک اصلی ربات می‌تواند رزرو را آزاد کند. */
export function canReleaseReservation(listing, uid, isOwner = false) {
  if (!listing || String(listing.status) !== 'reserved') return false;
  if (isOwner) return true;
  if (uid == null || listing.reserved_by == null) return false;
  return Number(listing.reserved_by) === Number(uid);
}

export function saleAllowed(status) {
  return ['active', 'reserved', 'ready_transfer'].includes(String(status));
}

export function reservationDeadline(now = new Date()) {
  return new Date(now.getTime() + RESERVE_MS);
}

export function isReservationExpired(until, now = new Date()) {
  if (!until) return false;
  return new Date(until).getTime() <= now.getTime();
}

export function shouldCleanupSoldChannel(row, now = new Date()) {
  if (!row || row.status !== 'sold' || !row.sold_at || row.channel_cleaned_at) return false;
  if (!row.channel_message_id && !row.sold_reply_message_id) return false;
  return now.getTime() - new Date(row.sold_at).getTime() >= SOLD_CLEANUP_MS;
}

export function shouldApplySpecialSale(row, now = new Date()) {
  if (!row || row.status !== 'active' || row.special_sale_applied_at || !row.period_started_at) return false;
  return now.getTime() - new Date(row.period_started_at).getTime() >= SPECIAL_SALE_MS;
}

export function specialPrice(price) {
  return Math.round(Number(price) * (1 - SPECIAL_SALE_RATE));
}

export function prefixRank(code) {
  const n = Number(code);
  if (n >= 1 && n <= 9) return n;
  if (n === 0) return 10;
  return 11;
}

export function sortListings(rows) {
  return [...rows].sort((a, b) => {
    const byPrefix = prefixRank(a.prefix_code) - prefixRank(b.prefix_code);
    if (byPrefix) return byPrefix;
    return Number(b.id) - Number(a.id);
  });
}

export function parseStartPayload(text, installmentConfig = null) {
  const cfg = installmentConfig || DEFAULT_INSTALLMENT;
  let raw = String(text || '').trim();
  raw = raw.replace(/^\/start(?:@[A-Za-z0-9_]+)?/i, '').trim();
  const token = raw.replace(/@[A-Za-z0-9_]+$/i, '').trim();
  if (!token) return { kind: 'bare' };
  const parts = token.split('_');
  if (parts[0] === 'buy' && (parts.length === 3 || parts.length === 4)) {
    const listingId = Number(parts[1]);
    const months = Number(parts[2]);
    const percent = parts.length === 4 ? Number(parts[3]) : cfg.defaultPercent;
    if (!Number.isInteger(listingId) || listingId <= 0) return null;
    if (!Number.isInteger(months) || months < 2 || months > 8) return null;
    if (!Number.isInteger(percent) || percent < 1 || percent > 99) return null;
    return { kind: 'installment', listingId, months, percent };
  }
  if (parts[0] === 'cash' && parts.length === 2) {
    const listingId = Number(parts[1]);
    if (!Number.isInteger(listingId) || listingId <= 0) return null;
    return { kind: 'cash', listingId };
  }
  return null;
}

export function parseOwnerSlot(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts[0] !== '/setownerslot' || parts.length !== 3) return null;
  const id = Number(parts[1]);
  const slots = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(slots) || slots < 0 || slots > 100000) return null;
  return { id, slots };
}

/** عدد سقف خط مالک از پیام متنی (فارسی/انگلیسی). */
export function parseOwnerCapSlots(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.startsWith('/')) return null;
  const slots = Number(toLatinDigits(raw).replace(/\s/g, ''));
  if (!Number.isInteger(slots)) return null;
  return slots;
}

/** قیمت مبنا قبل از تخفیف (برای فاکتور و تخفیف دستی) */
export function listingListPriceToman(row) {
  const current = Math.round(Number(row?.price_toman) || 0);
  const original = row?.original_price_toman == null ? 0 : Math.round(Number(row.original_price_toman));
  return Math.max(original, current);
}

/**
 * تخفیف دستی از استعلام:
 * — درصد: 5 یا 5%
 * — کسر میلیون: -20
 * — قیمت نهایی میلیون: 550
 */
export function parseManualDiscountInput(raw, basePriceToman) {
  const base = Math.round(Number(basePriceToman) || 0);
  if (base <= 0) return null;
  const text = toLatinDigits(String(raw ?? '').trim()).replace(/,/g, '.').replace(/\s+/g, ' ');
  if (!text) return null;

  const pctMatch = text.match(/^(\d+(?:\.\d+)?)\s*(%|٪)?$/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    const explicitPct = Boolean(pctMatch[2]);
    if (!explicitPct && pct > 100) {
      // e.g. 550 → final price 550 million, not 550%
    } else if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      if (!explicitPct) {
        /* fall through to final-price parsing */
      } else return null;
    } else {
      const rawPrice = base * (1 - pct / 100);
      const final = Math.max(1_000_000, Math.round(rawPrice / 1_000_000) * 1_000_000);
      if (final >= base) return null;
      return { final, discount: base - final, original: base, mode: 'percent', label: `${pct}٪` };
    }
  }

  const offMatch = text.match(/^-\s*(\d+(?:\.\d+)?)(?:\s*(?:m|mil|million|میلیون))?$/i);
  if (offMatch) {
    let off = Number(offMatch[1]);
    if (!Number.isFinite(off) || off <= 0) return null;
    if (off < 10_000) off *= 1_000_000;
    off = Math.round(off);
    const final = base - off;
    if (final <= 0 || final >= base) return null;
    return { final, discount: off, original: base, mode: 'amount', label: `${off.toLocaleString('en-US')} تومان` };
  }

  const digits = text.replace(/[^\d.]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  let final = n;
  if (final < 10_000) final = Math.round(final * 1_000_000);
  else final = Math.round(final);
  if (final >= base) return null;
  return { final, discount: base - final, original: base, mode: 'final', label: `${final.toLocaleString('en-US')} تومان` };
}

export function canManualDiscount(actor) {
  return Boolean(actor?.isOwner || actor?.allow?.('settings'));
}

export function invoiceDiscount(row) {
  const current = Math.round(Number(row?.price_toman) || 0);
  const original = row?.original_price_toman == null ? current : Math.round(Number(row.original_price_toman));
  const price = Math.max(original, current);
  const discount = Math.max(0, price - current);
  return { price, discount, final: price - discount };
}

export function invoiceMath({ price, discount = 0, saleType, months, percent, interest = 5, roundToman = 50_000 }) {
  const priceN = Math.max(0, Math.round(Number(price) || 0));
  const discountN = Math.min(priceN, Math.max(0, Math.round(Number(discount) || 0)));
  const final = priceN - discountN;
  if (saleType !== 'installment') {
    return { price: priceN, discount: discountN, final, cash: final, months: null, monthly: null, totalInstallment: null, balance: 0 };
  }
  const cash = Math.floor(final * Number(percent) / 100);
  const installment = calcInstallment(final, cash, months, interest, roundToman);
  return {
    price: priceN,
    discount: discountN,
    final,
    cash,
    months: Number(months),
    monthly: installment.monthly,
    totalInstallment: installment.monthly * Number(months),
    balance: installment.balance
  };
}

export function nextInvoiceNumber(lastNumber, jalaliYear, nowSequenceStart = 1) {
  const year = String(jalaliYear);
  const match = String(lastNumber || '').match(/^S(\d{4})-(\d+)$/);
  const sequence = match && match[1] === year ? Number(match[2]) + 1 : nowSequenceStart;
  return `S${year}-${String(sequence).padStart(5, '0')}`;
}

export function validNationalId(value) {
  const digits = String(value ?? '').replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0)).replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits) || /^(\d)\1{9}$/.test(digits)) return null;
  const check = Number(digits[9]);
  const sum = digits.slice(0, 9).split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  const ok = remainder < 2 ? check === remainder : check === 11 - remainder;
  return ok ? digits : null;
}

function excelLookupName(value) {
  const name = String(value || '').trim();
  if (!name || name === '-') return null;
  // متن‌های نمونه قالب را به‌عنوان «خالی» بگیر تا کل ردیف به‌خاطر مالک/انبار ساختگی fail نشود
  if (/نام دقیق (مالک|انبار)|افزودن مالک|مثال|نمونه/i.test(name)) return null;
  return name;
}

export function parseExcelAd(row) {
  const source = row || {};
  const phoneRaw = source['سیم‌کارت'] ?? source['سیم کارت'] ?? source['شماره'];
  const digits = String(phoneRaw ?? '').replace(/\D/g, '');
  if (!/^0912\d{7}$/.test(digits)) return null;
  const price = Number(String(source['قیمت'] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return null;
  const status = String(source['وضعیت'] || '').trim();
  const note = String(source['توضیحات'] || '').trim();
  const condition = [status, note && note !== '-' ? note : ''].filter(Boolean).join(' / ') || 'کارکرده';
  const dateRaw = source['تاریخ سند'] ?? source['تاریخ آماده سند'] ?? '';
  const dateText = String(dateRaw ?? '').trim();
  let documentDate = null;
  if (dateText) {
    documentDate = parseDateInput(dateText);
    if (!documentDate) return null;
  }
  return {
    phone: digits,
    displayPhone: formatPhoneDigits(digits) || String(phoneRaw).trim(),
    price: Math.round(price),
    condition,
    ownerName: excelLookupName(source['مالک']),
    warehouseName: excelLookupName(source['انبار']),
    documentDate
  };
}

export function excelTarget(openListing) {
  return openListing ? { action: 'update', listingId: openListing.id } : { action: 'create', listingId: null };
}
