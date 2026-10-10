export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

/** Username for t.me links (no @ prefix). */
export function botLinkUsername(raw) {
  return String(raw || 'SamiSIM0912Bot').replace(/^@/, '');
}

export function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
}

/** یکسان‌سازی نام مالک/انبار برای تطبیق اکسل با دیتابیس (ی/ي، ک/ك و …). */
export function normalizeLookupName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\u200c/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[يىئ]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[أإآ]/g, 'ا');
}

export function formatPhoneDigits(digits) {
  const normalized = toLatinDigits(digits).replace(/\D/g, '');
  if (!/^0912\d{7}$/.test(normalized)) return null;
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 9)} ${normalized.slice(9, 11)}`;
}

/** نمایش LTR در تلگرام/فارسی تا رقم‌ها برعکس نشوند */
export function formatPhoneDisplay(phoneNumber, optionalDisplay) {
  const fromNumber = toLatinDigits(phoneNumber).replace(/\D/g, '');
  const fromDisplay = optionalDisplay != null && optionalDisplay !== ''
    ? toLatinDigits(optionalDisplay).replace(/\D/g, '')
    : '';
  const digits = /^0912\d{7}$/.test(fromNumber) ? fromNumber : fromDisplay;
  const formatted = formatPhoneDigits(digits)
    || (digits || toLatinDigits(String(phoneNumber ?? optionalDisplay ?? '').trim()).replace(/[^\d+]/g, '') || String(phoneNumber ?? optionalDisplay ?? '').trim());
  if (!formatted) return '-';
  const clean = String(formatted).replace(/[\u2066\u2067\u2068\u2069\u200E\u200F]/g, '');
  return `\u2066${clean}\u2069`;
}

/** قیمت LTR در متن فارسی */
export function formatMoneyDisplay(value) {
  return `\u2066${money(value)}\u2069`;
}

export function normalizePhone(raw) {
  const digits = toLatinDigits(raw).replace(/\D/g, '');
  if (!/^0912\d{7}$/.test(digits)) return null;
  return { digits, display: formatPhoneDigits(digits) };
}

export function customerPhone(raw) {
  if (raw == null || raw === '') return null;
  const digits = toLatinDigits(raw).replace(/[^\d+]/g, '');
  if (!/^\+?\d{8,15}$/.test(digits)) return null;
  return digits;
}

export function prefixCode(phone) {
  return Number(String(phone ?? '').match(/^0912(\d)/)?.[1] || 0);
}

export function money(value) {
  return Number(value || 0).toLocaleString('en-US');
}

/** قیمت خط با احتساب فروش ویژه / original_price_toman */
export function listingPriceBreakdown(row) {
  const current = Math.round(Number(row?.price_toman) || 0);
  const storedOriginal = row?.original_price_toman == null ? null : Math.round(Number(row.original_price_toman));
  const original = storedOriginal == null ? current : Math.max(storedOriginal, current);
  const discount = Math.max(0, original - current);
  return { original, final: current, discount, hasDiscount: discount > 0 };
}

export function formatListingPricePlain(row) {
  const b = listingPriceBreakdown(row);
  if (!b.hasDiscount) return `${money(b.final)} تومان`;
  return `قیمت: ${money(b.original)} تومان\nقیمت نهایی: ${money(b.final)} تومان (تخفیف ${money(b.discount)})`;
}

/** HTML کانال — خط خورده + قیمت نهایی */
export function formatListingPriceHtml(row) {
  const b = listingPriceBreakdown(row);
  if (!b.hasDiscount) return `<b>${money(b.final)} تومان</b>`;
  return `<s>${esc(money(b.original))} تومان</s> <b>${money(b.final)} تومان</b> <i>(تخفیف ${esc(money(b.discount))})</i>`;
}

export function jalaliParts(date) {
  const formatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = formatter.formatToParts(date);
  const read = (type) => Number(toLatinDigits(parts.find((part) => part.type === type)?.value));
  return { year: read('year'), month: read('month'), day: read('day') };
}

export function tehranYmd(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function documentReadyDateIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return parseDateInput(text);
}

/** تاریخ سند رسیده یا گذشته (بر اساس تقویم تهران، هم‌تراز cron و CURRENT_DATE). */
export function isDocumentReadyDue(documentReadyDate, now = new Date()) {
  const due = documentReadyDateIso(documentReadyDate);
  if (!due) return false;
  return due <= tehranYmd(now);
}

export function documentReadyLabel(documentReadyDate, { html = false, now = new Date() } = {}) {
  if (!documentReadyDate) return html ? 'تاریخ سند: -' : '-';
  if (isDocumentReadyDue(documentReadyDate, now)) return html ? '✅ <b>آماده سند</b>' : 'آماده سند';
  const jalali = displayJalali(documentReadyDate);
  return html ? `تاریخ سند: ${jalali}` : jalali;
}

export function channelDocumentReadyLine(documentReadyDate, now = new Date()) {
  return documentReadyLabel(documentReadyDate, { html: true, now });
}

export function displayJalali(value) {
  if (!value) return '-';
  let date;
  if (value instanceof Date) {
    date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12));
  } else {
    const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    date = match ? new Date(`${match[1]}T12:00:00Z`) : new Date(value);
  }
  if (Number.isNaN(date.getTime())) return '-';
  const parts = jalaliParts(date);
  return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}`;
}

export function displayDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = jalaliParts(date);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')} ${hh}:${mm}`;
}

export function plusDaysISO(days, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

export function parseDateInput(raw) {
  const normalized = toLatinDigits(raw).trim().replace(/-/g, '/').replace(/\./g, '/');
  const parts = normalized.split('/').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  if (parts[0] >= 1300 && parts[0] < 1500) {
    const [jy, jm, jd] = parts;
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
    const start = Date.UTC(jy + 621, 2, 18, 12);
    for (let offset = 0; offset < 380; offset += 1) {
      const date = new Date(start + offset * 86400000);
      const jalali = jalaliParts(date);
      if (jalali.year === jy && jalali.month === jm && jalali.day === jd) return date.toISOString().slice(0, 10);
    }
    return null;
  }
  if (parts[0] >= 1900 && parts[0] < 2200) {
    const [year, month, day] = parts;
    const out = new Date(Date.UTC(year, month - 1, day));
    if (out.getUTCFullYear() !== year || out.getUTCMonth() !== month - 1 || out.getUTCDate() !== day) return null;
    return out.toISOString().slice(0, 10);
  }
  return null;
}

export function parseListingText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 3) return null;
  const phone = normalizePhone(lines[0]);
  const priceMillion = Number(toLatinDigits(lines[1]).replace(/,/g, '.'));
  if (!phone || !Number.isFinite(priceMillion) || priceMillion <= 0) return null;
  return {
    phone: phone.digits,
    displayPhone: phone.display,
    price: Math.round(priceMillion * 1_000_000),
    condition: lines[2]
  };
}

export function statusLabel(status) {
  return {
    active: 'موجود',
    reserved: 'رزرو شده',
    sold: 'فروخته شده',
    inactive: 'غیرفعال',
    ready_transfer: 'آماده انتقال'
  }[String(status || '').toLowerCase()] || status || '-';
}
