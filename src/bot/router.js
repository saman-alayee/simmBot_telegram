import { calcInstallment } from '../database/sql.js';
import { channelText } from '../channel/channel.js';
import {
  CHANNEL_MSG_DEFAULTS, CHANNEL_MSG_EDIT_LABELS, canEditChannelMessages, channelMsgKeyFromAlias,
  clearChannelStatusMessage, loadChannelStatusMessages, saveChannelMessage
} from '../channel/channel-messages.js';
import {
  channelMsgBodyFromMessage, parseSetChannelMsg, parseSetChannelMsgMeta, sendMessagePayload, utf16Length
} from '../telegram/telegram-text.js';
import { syncBotCommandsForChat } from '../bot/commands.js';
import { buildListingsExcelTemplateBuffer, listingAdsFromExcelBuffer } from '../import/excel-import.js';
import {
  ALL_PERMISSIONS, PERMISSIONS, PRICE_INCREASE_SCOPES,
  canAssignOwner, canManualDiscount, capacityLabel, decodePriceUpPercent, encodePriceUpPercent,
  listingListPriceToman, parseManualDiscountInput, parseOwnerSlot, parseStartPayload, priceAfterPercentIncrease,
  reserveAllowed, saleAllowed, validNationalId
} from '../domain/logic.js';
import { formatInstallmentConfigSummary, parseNumberList } from '../domain/installment-config.js';
import {
  customerPhone, displayJalali, displayDateTime, esc, formatListingPricePlain, formatMoneyDisplay, formatPhoneDisplay,
  listingPriceBreakdown, money, normalizePhone, parseDateInput, parseListingText, plusDaysISO, statusLabel, toLatinDigits
} from '../domain/format.js';
import { invoicePdfFilename } from '../invoice/invoice-template.js';
import {
  activeOwnersWithUsage, announceSold, applyManualListingDiscount, applySpecialSale, buildInvoice, clearManualListingDiscount,
  clearReserveNotice, historyForPhone, historyLines,
  getInstallmentConfig, increaseListingPricesByPercent, invoiceDraftPriceSummary, listingById, logChange,
  lookupListingByPhone, lookupText,
  openListingByPhone, ownerIdByName, ownerUsage, postReserveNotice, previewPriceIncrease, publicOrigin, putSetting,
  releaseListing, warehouseIdByName,
  refreshInstallmentChannelPosts, reserveListing, saveListing, sellListing, settingValue, syncChannel
} from './data.js';

const ADMIN_LABELS = { 1: '@samiito0912', 2: '@Samisadeghirb' };

function ownerTelegramId() {
  const id = process.env.OWNER_TELEGRAM_ID;
  if (!id || String(id).toLowerCase() === 'auto') return null;
  return String(id);
}

function coOwnerTelegramIds() {
  const ids = [];
  for (const part of String(process.env.CO_OWNER_TELEGRAM_IDS || '').split(/[\s,;]+/)) {
    const id = part.trim();
    if (id) ids.push(id);
  }
  return ids;
}

function isCoOwnerUid(uid) {
  if (uid == null || uid === '') return false;
  return coOwnerTelegramIds().includes(String(uid));
}

function coOwnerButtonLabel(coId, rows) {
  const row = rows.find((item) => String(item.telegram_user_id) === String(coId));
  const name = row?.display_name ? ` — ${row.display_name}` : '';
  return `👑 مالک مشترک — ${coId}${name}`;
}

function canViewWarehouses(actor) {
  return actor.allow('warehouses') || actor.allow('add_listing') || actor.allow('lines') || actor.allow('reports');
}

async function warehousesWithStock(q) {
  return q`SELECT w.id, w.name, w.active,
    COUNT(l.id) FILTER (WHERE l.status IN ('active','reserved','ready_transfer','inactive'))::int AS open_lines,
    COUNT(l.id) FILTER (WHERE l.status = 'active')::int AS active_lines,
    COUNT(l.id) FILTER (WHERE l.status = 'reserved')::int AS reserved_lines,
    COUNT(l.id) FILTER (WHERE l.status = 'ready_transfer')::int AS ready_lines,
    COUNT(l.id) FILTER (WHERE l.status = 'inactive')::int AS inactive_lines
  FROM warehouses w
  LEFT JOIN listings l ON l.warehouse_id = w.id
  GROUP BY w.id, w.name, w.active
  ORDER BY w.active DESC, w.name`;
}

function warehouseStockLine(row, index) {
  const status = row.active ? 'فعال' : 'غیرفعال';
  const open = Number(row.open_lines || 0);
  const parts = [
    Number(row.active_lines) ? `موجود ${row.active_lines}` : null,
    Number(row.reserved_lines) ? `رزرو ${row.reserved_lines}` : null,
    Number(row.ready_lines) ? `آماده انتقال ${row.ready_lines}` : null,
    Number(row.inactive_lines) ? `غیرفعال ${row.inactive_lines}` : null
  ].filter(Boolean);
  const detail = parts.length ? parts.join(' · ') : 'بدون خط باز';
  return `${index + 1}. ${row.name} — ${status} — ${open} خط (${detail})`;
}

function adminSlotLabel(priority, row) {
  if (!row || row.active === false) return `${priority}. خالی — هنوز ثبت نشده`;
  const name = row.display_name || row.telegram_user_id;
  return `${priority}. ${name} — فعال`;
}

function adminListLines(rows) {
  const ownerId = ownerTelegramId();
  const lines = [];
  if (ownerId) lines.push(`👑 مالک ربات — ${ownerId} — دسترسی کامل`);
  for (const coId of coOwnerTelegramIds()) {
    if (coId === ownerId) continue;
    lines.push(`👑 مالک مشترک — ${coId} — دسترسی کامل`);
  }
  for (const priority of [1, 2]) {
    const row = rows.find((item) => Number(item.priority) === priority);
    lines.push(adminSlotLabel(priority, row));
  }
  return lines;
}

function manageAdminKeyboard(rows) {
  const buttons = [];
  const ownerId = ownerTelegramId();
  if (ownerId) {
    buttons.push([{ text: `👑 مالک ربات — ${ownerId}`, callback_data: 'admin_owner_info' }]);
  }
  const seenIds = new Set(ownerId ? [ownerId] : []);
  for (const coId of coOwnerTelegramIds()) {
    if (coId === ownerId) continue;
    buttons.push([{ text: coOwnerButtonLabel(coId, rows), callback_data: 'admin_coowner_info' }]);
    seenIds.add(coId);
  }
  for (const priority of [1, 2]) {
    const row = rows.find((item) => Number(item.priority) === priority);
    const uid = row?.telegram_user_id != null ? String(row.telegram_user_id) : '';
    if (uid && seenIds.has(uid)) {
      const dupLabel = isCoOwnerUid(uid)
        ? `${priority}. خالی — (${row?.display_name || uid} مالک مشترک است)`
        : `${priority}. (همان ادمین در اسلات دیگر) — خالی`;
      buttons.push([{ text: dupLabel, callback_data: 'admin_add' }]);
      continue;
    }
    if (uid) seenIds.add(uid);
    buttons.push([{
      text: adminSlotLabel(priority, row),
      callback_data: row?.active !== false && row ? `perm_admin_${priority}` : 'admin_add'
    }]);
  }
  buttons.push(
    [{ text: 'افزودن / تغییر ادمین', callback_data: 'admin_add' }],
    [{ text: 'غیرفعال کردن ادمین', callback_data: 'admin_remove' }],
    [{ text: '↩️ بازگشت', callback_data: 'manage_back' }]
  );
  return buttons;
}

const MENU = {
  add: 'ثبت سیم‌کارت ➕',
  lookup: 'استعلام خط 🔍',
  openLines: 'خطوط موجود 💼',
  owners: 'مالکین 👤',
  warehouses: 'انبارها 📦',
  lines: 'لیست خطوط 📋',
  reports: 'گزارش‌ها 📊',
  invoice: 'فاکتور 🧾',
  history: 'تاریخچه 🕒',
  manage: 'مدیریت ⚙️',
  guide: 'راهنمای کار 📖',
  close: 'بستن منو ❌'
};

const PERM_MENU_EMOJI = {
  add_listing: '➕',
  lookup: '🔍',
  owners: '👤',
  warehouses: '📦',
  lines: '📋',
  reports: '📊',
  history: '🕒',
  invoices: '🧾',
  partners: '🤝',
  settings: '⚙️',
  admin_management: '👥'
};
const STATUS_BY_TOKEN = { a: 'active', r: 'reserved', s: 'sold', i: 'inactive', t: 'ready_transfer' };
const TOKEN_BY_STATUS = { active: 'a', reserved: 'r', sold: 's', inactive: 'i', ready_transfer: 't' };

export async function tg(method, body) {
  const payload = body?.reply_markup && typeof body.reply_markup === 'string'
    ? { ...body, reply_markup: JSON.parse(body.reply_markup) }
    : body;
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return response.json();
}

export async function sendPdf(chatId, filename, base64, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([Buffer.from(base64, 'base64')], { type: 'application/pdf' }), filename);
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  return response.json();
}

function invoiceActorUid(callback, actor) {
  const id = callback?.from?.id ?? actor?.uid;
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

async function fetchInvoiceDraft(q, actorUid, listingIdHint) {
  if (actorUid == null) return null;
  let draft = (await q`SELECT * FROM invoice_drafts WHERE telegram_user_id = ${actorUid} LIMIT 1`)[0];
  if (!draft && listingIdHint) {
    draft = (await q`SELECT * FROM invoice_drafts WHERE listing_id = ${listingIdHint} AND telegram_user_id = ${actorUid} LIMIT 1`)[0];
  }
  if (!draft && listingIdHint) {
    const rows = await q`SELECT * FROM invoice_drafts WHERE listing_id = ${listingIdHint} ORDER BY updated_at DESC LIMIT 5`;
    draft = rows.find((row) => String(row.telegram_user_id) === String(actorUid)) || null;
  }
  return draft || null;
}

function envOwnerIds() {
  const ids = new Set();
  const primary = String(process.env.OWNER_TELEGRAM_ID || '').trim();
  if (primary && primary.toLowerCase() !== 'auto') ids.add(primary);
  for (const part of String(process.env.CO_OWNER_TELEGRAM_IDS || '').split(/[\s,;]+/)) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  if (!ids.size) ids.add('186174121');
  return ids;
}

async function actorOf(q, uid) {
  const ownerIds = envOwnerIds();
  let isOwner = ownerIds.has(String(uid));
  let admin = isOwner ? null : (await q`SELECT * FROM admins WHERE telegram_user_id = ${uid} AND active = true LIMIT 1`)[0] || null;
  if (!isOwner && admin?.permissions?.bot_owner === true) isOwner = true;
  const permissions = admin?.permissions || {};
  return {
    uid,
    isOwner,
    admin,
    permissions,
    isStaff: isOwner || Boolean(admin),
    allow(key) { return isOwner || permissions[key] === true; }
  };
}

function staffRoleLabel(actor) {
  if (actor.isOwner) return 'مالک ربات';
  const name = actor.admin?.display_name;
  const priority = actor.admin?.priority;
  if (priority) return `ادمین ${priority}${name ? ` (${name})` : ''}`;
  return 'ادمین';
}

function staffPermissionSummary(actor) {
  if (actor.isOwner) return 'همه بخش‌ها';
  const labels = Object.entries(PERMISSIONS).filter(([key]) => actor.allow(key)).map(([, label]) => label);
  return labels.length ? labels.join(' · ') : 'دسترسی فعال ثبت نشده — با مالک هماهنگ کنید.';
}

function staffGuideFull(actor) {
  const lines = [
    `راهنمای کار — ${staffRoleLabel(actor)}`,
    '',
    `دسترسی: ${staffPermissionSummary(actor)}`,
    '',
    '▸ ثبت خط جدید',
    '۱) «ثبت سیم‌کارت» یا یک پیام ۳خطی:',
    '   شماره 0912…',
    '   قیمت به میلیون (مثلاً 580)',
    '   وضعیت / توضیح',
    '۲) مالک → انبار → تاریخ سند (یا دکمه «۲۰ روز بعد»)',
    '۳) اگر خط باز همان شماره باشد، ثبت = به‌روزرسانی قیمت/وضعیت',
    '',
    '▸ استعلام و کار روی خط',
    '• «استعلام خط» یا فقط شماره را بفرستید (بدون /)',
    '• دکمه‌ها: رزرو ۱ساعته · آزاد کردن · فروش نهایی',
    '• «خطوط موجود»: لیست خطوط باز با وضعیت + رزرو / تحویل / فروش',
    '• تغییر وضعیت / مالک / انبار / تاریخ سند',
    actor.allow('history') ? '• تاریخچه: «تاریخچه» یا /history 0912…' : null,
    actor.allow('invoices') ? '• فاکتور: بعد از «فروش نهایی» → «صدور فاکتور» در همان استعلام' : null,
    '',
    '▸ درخواست خرید مشتری (از کانال)',
    '• روی پیام درخواست: «پیگیری شد» یا «واگذاری به ادمین ۲»',
    '• رزرو خط در کانال برای مشتری دیده می‌شود',
    '',
    '▸ میانبرها',
    '/start منو · /guide همین راهنما · /cancel لغو کار ناتمام · /close بستن منوی پایین'
  ];
  if (actor.allow('lines') || actor.allow('reports') || actor.allow('owners') || actor.allow('warehouses')) {
    lines.push('', '▸ لیست و گزارش');
    if (actor.allow('lines')) lines.push('• «لیست خطوط»: فیلتر وضعیت/مالک/انبار و PDF');
    if (actor.allow('reports')) lines.push('• «گزارش‌ها»: موجودی، آمار فروش (تعداد و مبلغ)، مالک‌ها، ادمین‌ها');
    if (actor.allow('owners')) lines.push('• «مالکین»: ظرفیت خط هر مالک');
    if (canViewWarehouses(actor)) lines.push('• «انبارها»: موجودی خطوط هر انبار (+ مشاهده جزئیات)');
  }
  if (actor.isOwner || actor.allow('settings') || actor.allow('admin_management')) {
    lines.push('', '▸ مدیریت');
    lines.push('• منو «مدیریت»: تنظیمات اقساط، افزایش قیمت درصدی، کانال، اینستاگرام');
    lines.push('/priceup 5 — افزایش ۵٪ روی خطوط موجود');
    lines.push('تخفیف دستی: استعلام خط → «تخفیف دستی» یا /setdiscount 0912… 5%');
  }
  if (actor.allow('add_listing') || actor.isOwner) {
    lines.push('', '▸ ثبت دسته‌ای');
    lines.push('• /excel — دریافت قالب اکسل');
    lines.push('• ارسال فایل .xlsx پر شده برای ثبت/به‌روزرسانی خطوط');
  }
  if (actor.isOwner) {
    lines.push('', '▸ فقط مالک ربات');
    lines.push('• مالکین: /addowner نام · غیرفعال /removeowner ID · سقف /setownerslot ID تعداد');
    lines.push('• انبار: /addwarehouse نام · /removewarehouse ID');
    lines.push('• فاکتور: /setstorename /setstorephone /setstoreaddress');
    lines.push('• همکاران: /partners · /addpartner ID نام');
  }
  if (actor.allow('settings') || actor.isOwner) {
    lines.push('تنظیمات اقساط: منو مدیریت → تنظیمات سیم‌کارت');
    lines.push('/setinterest · /setinstallmentmonths · /setinstallmentpercents · /setinstallmentround');
  }
  if (actor.allow('admin_management') || actor.isOwner) {
    lines.push('/admins — /setadmin 1|2 TELEGRAM_ID @name');
  }
  if (actor.allow('lookup')) {
    lines.push('/lookup 0912… — استعلام با دستور');
    lines.push('/openlines — لیست خطوط موجود (موجود · رزرو · آماده انتقال)');
  }
  return lines.filter((line) => line !== null).join('\n');
}

function staffWelcomeBrief(actor) {
  return [
    `پنل سامی — ${staffRoleLabel(actor)}`,
    `دسترسی: ${staffPermissionSummary(actor)}`,
    '',
    'کارهای سریع:',
    actor.allow('add_listing') ? '• ثبت خط: «ثبت سیم‌کارت»' : null,
    actor.allow('lookup') ? '• استعلام: شماره 0912 را بفرستید' : null,
    actor.allow('lines') ? '• مرور موجودی: «لیست خطوط»' : null,
    '',
    'راهنمای گام‌به‌گام: «راهنمای کار» یا /guide',
    '/help خلاصه · /cancel لغو · /close بستن منو'
  ].filter((line) => line !== null).join('\n');
}

function staffUnknownHint(actor) {
  const tips = [];
  if (actor.allow('lookup')) tips.push('شماره 0912 برای استعلام (بدون دستور)');
  if (actor.allow('add_listing')) tips.push('۳ خط پشت‌سرهم: شماره / قیمت میلیون / وضعیت');
  tips.push('«راهنمای کار» یا /guide');
  tips.push('/start برای باز کردن منو');
  return `متوجه پیام نشدم.\n\n${tips.map((tip) => `• ${tip}`).join('\n')}`;
}

async function sendStaffGuide(chatId, actor) {
  const text = staffGuideFull(actor);
  if (text.length <= 4000) {
    await say(chatId, text);
    return;
  }
  const splitAt = text.lastIndexOf('\n', 3900);
  await say(chatId, text.slice(0, splitAt));
  await say(chatId, text.slice(splitAt + 1));
}

function welcomeGuide(actor) {
  const common = [
    'راهنمای کوتاه',
    '',
    '/start — شروع و نمایش منو',
    '/help — همین راهنما',
    '/id — نمایش شناسه تلگرام شما',
    '/cancel — لغو کار ناتمام (مثلاً وسط ثبت درخواست خرید)'
  ];
  if (actor.isStaff) {
    return [
      staffWelcomeBrief(actor),
      '',
      '---',
      ...common,
      '/guide — راهنمای کامل ادمین',
      '/close — بستن منوی پایین'
    ].join('\n');
  }
  return [
    ...common,
    '',
    'مشتری:',
    customerChannelJoinText(),
    '',
    'بعد از عضویت، روی «خرید نقدی» یا «خرید اقساطی» همان پست در کانال بزنید.',
    'سپس شماره تماس خود را بفرستید یا /skip را بزنید.'
  ].join('\n');
}

function menuFor(actor) {
  const rows = [];
  const rowPair = (left, right) => {
    const buttons = [left, right].filter(Boolean).map((text) => ({ text }));
    if (buttons.length) rows.push(buttons);
  };
  rowPair(actor.allow('lookup') && MENU.lookup, actor.allow('add_listing') && MENU.add);
  rowPair(canViewWarehouses(actor) && MENU.warehouses, actor.allow('owners') && MENU.owners);
  rowPair(actor.allow('reports') && MENU.reports, actor.allow('lines') && MENU.lines);
  rowPair(actor.allow('history') && MENU.history, (actor.isOwner || actor.allow('settings') || actor.allow('admin_management')) && MENU.manage);
  rowPair(actor.allow('lookup') && MENU.openLines, actor.allow('invoices') && MENU.invoice);
  if (MENU.guide) rows.push([{ text: MENU.guide }]);
  rows.push([{ text: MENU.close }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: false };
}

async function say(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

function markup(extra) {
  return extra ? { reply_markup: JSON.stringify(extra) } : {};
}

function channelInviteUrl() {
  const raw = process.env.CHANNEL_USERNAME || process.env.CHANNEL_INVITE || '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://t.me/${raw.replace(/^@/, '')}`;
}

function channelJoinLabel() {
  const url = channelInviteUrl();
  if (!url) return 'کانال آگهی‌ها';
  const handle = url.replace(/^https:\/\/t\.me\//i, '@');
  return handle.startsWith('@') ? handle : `@${handle}`;
}

function channelJoinMarkup() {
  const url = channelInviteUrl();
  if (!url) return {};
  return markup({ inline_keyboard: [[{ text: '📢 عضویت در کانال', url }]] });
}

function customerChannelJoinText() {
  const label = channelJoinLabel();
  return [
    'عضویت در کانال',
    '',
    `برای دیدن آگهی‌ها و درخواست خرید، ابتدا در ${label} عضو شوید.`,
    'بعد از Join، از دکمه «خرید نقدی» یا «خرید اقساطی» روی همان پست در کانال استفاده کنید.'
  ].join('\n');
}

async function isChannelMember(uid) {
  const chatId = process.env.CHANNEL_ID;
  if (!chatId || chatId === '-1000000000000') return true;
  const result = await tg('getChatMember', { chat_id: chatId, user_id: uid });
  if (!result?.ok) return true;
  return ['creator', 'administrator', 'member', 'restricted'].includes(result.result?.status);
}

/** @returns {boolean} true if user was blocked (must join channel first) */
async function requireChannelMembership(chatId, uid) {
  if (await isChannelMember(uid)) return false;
  await say(chatId, customerChannelJoinText(), channelJoinMarkup());
  return true;
}

async function deny(chatId, callback) {
  if (callback) await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'دسترسی ندارید.' });
  else await say(chatId, 'دسترسی ندارید.');
}

export async function handleUpdate({ q, request, update }) {
  if (update.callback_query) return handleCallback(q, request, update.callback_query);
  const message = update.message;
  if (isExcelDocument(message?.document)) {
    const actor = await actorOf(q, message.from?.id);
    if (!(actor.isOwner || actor.allow('add_listing'))) {
      await say(message.chat.id, 'ورود اکسل فقط برای کسانی است که دسترسی «ثبت خط» دارند.');
      return;
    }
    try {
      await syncExcel(q, request, message, actor);
    } catch (error) {
      console.error(error);
      await say(message.chat.id, 'ورود اکسل ناتمام ماند. چند لحظه بعد همین فایل را دوباره بفرستید تا از همان‌جا ادامه پیدا کند.');
    }
    return;
  }
  if (!message?.text && !message?.contact?.phone_number) return;
  const chatId = message.chat.id;
  const uid = message.from?.id;
  const text = message.text?.trim() || '';
  const actor = await actorOf(q, uid);
  if (text === '/id') {
    if (process.env.LOCAL_DEV === '1' && String(process.env.OWNER_TELEGRAM_ID || '').toLowerCase() === 'auto') {
      process.env.OWNER_TELEGRAM_ID = String(uid);
      await say(chatId, `شناسه تلگرام شما:\n${uid}\n\nحالت تست: تا وقتی این برنامه باز است، شما مالک ربات هستید.\nحالا /start بزنید.`);
      return;
    }
    await say(chatId, `شناسه تلگرام شما:\n${uid}`);
    return;
  }
  if (text === '/cancel') { await clearPending(q, uid); await say(chatId, 'عملیات ناتمام لغو شد.'); return; }
  if (text === '/start' || text === '/help' || text.startsWith('/start ')) {
    await clearPending(q, uid);
    await syncBotCommandsForChat(tg, chatId, actor).catch(() => {});
    if (text.startsWith('/start ')) {
      const started = await handleDeepLink(q, message, text);
      if (started) return;
    }
    const guide = welcomeGuide(actor);
    if (actor.isStaff) {
      await say(chatId, `${staffWelcomeBrief(actor)}\n\nیکی از گزینه‌های منوی پایین را انتخاب کنید.\nبرای لیست دستورات، / را بزنید.`, markup(menuFor(actor)));
    } else {
      await say(chatId, guide, channelJoinMarkup());
    }
    return;
  }
  if (await handlePurchaseReply(q, message, actor, text)) return;
  if (!actor.isStaff) {
    await say(chatId, `${welcomeGuide(actor)}\n\nبرای شروع، /start را بزنید یا از کانال وارد شوید.`, channelJoinMarkup());
    return;
  }
  if (text === MENU.close || text === '/menu' || text === '/close') {
    await say(chatId, 'منوی مدیریت بسته شد.\nبرای باز کردن دوباره /start بزنید.', markup({ remove_keyboard: true }));
    return;
  }
  if (!text.startsWith('/') && await handlePendingText(q, request, message, actor, text)) return;
  if (await handleMenu(q, request, message, actor, text)) return;
  if (await handleCommand(q, request, message, actor, text)) return;
  const phone = normalizePhone(text);
  if (phone && actor.allow('lookup')) { await sendLookup(q, chatId, actor, phone.digits, phone.display); return; }
  if (actor.allow('add_listing')) {
    const parsed = parseListingText(text);
    if (!parsed) {
      await say(chatId, [
        'برای ثبت، دقیقاً ۳ خط (بدون خط خالی اضافه):',
        '',
        '0912 157 27 58',
        '580',
        'کارکرده / خوش‌شماره',
        '',
        'بعد از ارسال: مالک → انبار → تاریخ سند را از دکمه‌ها انتخاب کنید.',
        '/cancel برای لغو ثبت ناتمام'
      ].join('\n'));
      return;
    }
    await beginRegistration(q, chatId, uid, parsed, actor);
    return;
  }
  await say(chatId, staffUnknownHint(actor));
}

async function clearPending(q, uid) {
  await Promise.all([
    q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`,
    q`DELETE FROM invoice_drafts WHERE telegram_user_id = ${uid}`,
    q`DELETE FROM listing_edit_sessions WHERE telegram_user_id = ${uid}`,
    q`DELETE FROM listing_registration_sessions WHERE telegram_user_id = ${uid}`,
    q`DELETE FROM purchase_contact_sessions WHERE telegram_user_id = ${uid}`
  ]);
}

async function syncListingChannel(q, request, id) {
  const fresh = await listingById(q, id);
  if (fresh) await syncChannel(q, tg, fresh, publicOrigin(request));
  return fresh;
}

async function presentLookup(q, chatId, actor, listing, { suffix = '', withFooter = true } = {}) {
  if (!listing) return null;
  const footer = withFooter ? '\n\nعملیات: از دکمه‌های زیر استفاده کنید.' : '';
  await say(chatId, `${lookupText(listing)}${suffix}${footer}`, markup(lookupKeyboard(listing, actor)));
  return listing;
}

async function handleDeepLink(q, message, text) {
  const inst = await getInstallmentConfig(q);
  const payload = parseStartPayload(text, inst);
  if (!payload || payload.kind === 'bare') return false;
  const chatId = message.chat.id;
  const uid = message.from.id;
  if (await requireChannelMembership(chatId, uid)) return true;
  if (payload.kind === 'installment' && !inst.salesEnabled) {
    await say(chatId, 'فروش اقساطی فعلاً غیرفعال است. فقط «خرید نقدی» از کانال در دسترس است.');
    return true;
  }
  const listing = (await q`SELECT id, phone_display, phone_number, price_toman FROM listings WHERE id = ${payload.listingId} AND status = 'active' LIMIT 1`)[0];
  if (!listing) { await say(chatId, 'این آگهی دیگر موجود نیست.'); return true; }
  await q`INSERT INTO purchase_contact_sessions(telegram_user_id, listing_id, request_type, months, cash_percent, created_at)
    VALUES(${uid}, ${listing.id}, ${payload.kind}, ${payload.months || null}, ${payload.percent || null}, NOW())
    ON CONFLICT(telegram_user_id) DO UPDATE SET listing_id = EXCLUDED.listing_id, request_type = EXCLUDED.request_type,
      months = EXCLUDED.months, cash_percent = EXCLUDED.cash_percent, created_at = NOW()`;
  await say(chatId, `شماره ${formatPhoneDisplay(listing.phone_number, listing.phone_display)}\nشماره تماس خود را بفرستید، دکمه زیر را بزنید، یا /skip را انتخاب کنید.`, markup({
    keyboard: [[{ text: 'ارسال شماره من', request_contact: true }], [{ text: '/skip' }]],
    resize_keyboard: true,
    one_time_keyboard: true
  }));
  return true;
}

async function handlePurchaseReply(q, message, actor, text) {
  const inst = await getInstallmentConfig(q);
  const session = (await q`SELECT * FROM purchase_contact_sessions WHERE telegram_user_id = ${message.from.id}
    AND created_at > NOW() - (${inst.requestExpireMinutes}::int * INTERVAL '1 minute') LIMIT 1`)[0];
  if (!session) return false;
  if (text.startsWith('/') && text !== '/skip') return false;
  if (!message.contact?.phone_number && text.startsWith('/') && text !== '/skip') return false;
  if (!message.contact && text.startsWith('/') && text !== '/skip') return false;
  const rawPhone = message.contact?.phone_number || (text === '/skip' ? null : text);
  const phone = rawPhone ? customerPhone(rawPhone) : null;
  if (text !== '/skip' && !phone) { await say(message.chat.id, 'شماره تماس معتبر وارد کنید یا /skip را بزنید.'); return true; }
  const listing = (await q`SELECT * FROM listings WHERE id = ${session.listing_id} AND status = 'active' LIMIT 1`)[0];
  if (!listing) {
    await q`DELETE FROM purchase_contact_sessions WHERE telegram_user_id = ${message.from.id}`;
    await say(message.chat.id, 'این سیم‌کارت دیگر موجود نیست.');
    return true;
  }
  const admins = await q`SELECT * FROM admins WHERE active = true ORDER BY priority ASC LIMIT 2`;
  const first = admins.find((admin) => Number(admin.priority) === 1) || admins[0]
    || (ownerTelegramId() ? { telegram_user_id: ownerTelegramId(), priority: 1 } : null);
  if (!first) { await say(message.chat.id, 'در حال حاضر ادمینی برای دریافت درخواست فعال نیست.'); return true; }
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null;
  let inserted;
  if (session.request_type === 'installment') {
    const months = Number(session.months);
    const percent = Number(session.cash_percent || inst.defaultPercent);
    const cash = Math.floor(Number(listing.price_toman) * percent / 100);
    const installment = calcInstallment(listing.price_toman, cash, months, inst.interestPercentMonthly, inst.roundToman);
    inserted = (await q`INSERT INTO purchase_requests(
        listing_id, customer_telegram_id, customer_username, customer_name, customer_phone, months,
        base_price_toman, cash_amount_toman, balance_toman, monthly_installment_toman, total_installment_toman,
        status, assigned_admin, assigned_priority, expires_at, request_type, cash_percent
      ) VALUES(
        ${listing.id}, ${message.from.id}, ${message.from?.username || null}, ${name}, ${phone}, ${months},
        ${listing.price_toman}, ${cash}, ${installment.balance}, ${installment.monthly}, ${installment.monthly * months},
        'pending', ${first.telegram_user_id}, 1, NOW() + (${inst.requestExpireMinutes}::int * INTERVAL '1 minute'), 'installment', ${percent}
      ) RETURNING id`)[0];
    await say(message.chat.id, `درخواست خرید اقساطی ثبت شد.\nپیش‌پرداخت ${percent}٪: ${money(cash)} تومان\n${months} قسط × ${money(installment.monthly)} تومان`, actor.isStaff ? markup(menuFor(actor)) : markup({ remove_keyboard: true }));
  } else {
    inserted = (await q`INSERT INTO purchase_requests(
        listing_id, customer_telegram_id, customer_username, customer_name, customer_phone, months,
        base_price_toman, cash_amount_toman, balance_toman, monthly_installment_toman, total_installment_toman,
        status, assigned_admin, assigned_priority, expires_at, request_type, cash_percent
      ) VALUES(
        ${listing.id}, ${message.from.id}, ${message.from?.username || null}, ${name}, ${phone}, NULL,
        ${listing.price_toman}, ${listing.price_toman}, 0, NULL, NULL,
        'pending', ${first.telegram_user_id}, 1, NOW() + (${inst.requestExpireMinutes}::int * INTERVAL '1 minute'), 'cash', NULL
      ) RETURNING id`)[0];
    await say(message.chat.id, 'درخواست خرید نقدی ثبت شد. ادمین برای هماهنگی با شما تماس می‌گیرد.', actor.isStaff ? markup(menuFor(actor)) : markup({ remove_keyboard: true }));
  }
  const full = (await q`SELECT pr.*, l.phone_number, l.phone_display, l.condition_text FROM purchase_requests pr JOIN listings l ON l.id = pr.listing_id WHERE pr.id = ${inserted.id}`)[0];
  const notifyIds = [];
  const addNotify = (id) => {
    const value = String(id || '').trim();
    if (value && !notifyIds.includes(value)) notifyIds.push(value);
  };
  addNotify(first.telegram_user_id);
  addNotify(ownerTelegramId());
  for (const coId of coOwnerTelegramIds()) addNotify(coId);
  const payload = { text: adminText(full, ADMIN_LABELS[1]), reply_markup: adminKeyboard(inserted.id) };
  for (const chat of notifyIds) {
    await tg('sendMessage', { chat_id: chat, ...payload });
  }
  await q`DELETE FROM purchase_contact_sessions WHERE telegram_user_id = ${message.from.id}`;
  return true;
}

function adminText(row, label) {
  const lines = [
    `درخواست خرید ${row.request_type === 'cash' ? 'نقدی' : 'اقساطی'} #${row.id}`,
    '',
    `شماره: ${formatPhoneDisplay(row.phone_number, row.phone_display)}`,
    `وضعیت: ${row.condition_text || '-'}`,
    `قیمت: ${money(row.base_price_toman)} تومان`,
    '',
    `شناسه تلگرام: ${row.customer_telegram_id}`,
    `شماره تماس مشتری: ${row.customer_phone || 'ثبت نشده'}`
  ];
  if (row.request_type === 'installment') {
    lines.push('', `پیش‌پرداخت: ${money(row.cash_amount_toman)} تومان (${row.cash_percent || 30}٪)`, `مدت: ${row.months} ماه`, `هر قسط: ${money(row.monthly_installment_toman)} تومان`, `جمع اقساط: ${money(row.total_installment_toman)} تومان`);
  }
  lines.push('', `مسئول فعلی: ${label}`, `ادمین ۱: ${ADMIN_LABELS[1]}`, `ادمین ۲: ${ADMIN_LABELS[2]}`, '', '«پیگیری شد» = قبول پیگیری · «واگذاری به ادمین ۲» = ارجاع', 'میانبر: استعلام · رزرو+فروش · فاکتور با اطلاعات مشتری');
  return lines.join('\n');
}

function purchaseShortcutKeyboard(id) {
  return [
    [{ text: 'استعلام خط', callback_data: `pr_lookup_${id}` }, { text: 'رزرو و فروش', callback_data: `pr_sell_${id}` }],
    [{ text: 'فاکتور با اطلاعات مشتری', callback_data: `pr_invoice_${id}` }]
  ];
}

function adminKeyboard(id) {
  return { inline_keyboard: [[{ text: 'پیگیری شد', callback_data: `claim_${id}` }, { text: 'واگذاری به ادمین ۲', callback_data: `handoff_${id}` }], ...purchaseShortcutKeyboard(id)] };
}

function purchaseClaimedKeyboard(id) {
  return { inline_keyboard: [...purchaseShortcutKeyboard(id)] };
}

async function purchaseRequestFull(q, id) {
  return (await q`SELECT pr.*, l.phone_number, l.phone_display, l.condition_text, l.status AS listing_status, l.reserved_by
    FROM purchase_requests pr JOIN listings l ON l.id = pr.listing_id WHERE pr.id = ${id} LIMIT 1`)[0];
}

async function handlePurchaseRequestAction(q, request, callback, actor, action, id) {
  const chatId = callback.message.chat.id;
  const pr = await purchaseRequestFull(q, id);
  if (!pr) {
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'درخواست پیدا نشد.' });
    return;
  }
  if (action === 'lookup') {
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'استعلام خط…' });
    await sendLookup(q, chatId, actor, pr.phone_number, pr.phone_display);
    return;
  }
  if (action === 'invoice') {
    if (!actor.allow('invoices')) { await deny(chatId, callback); return; }
    const started = await startInvoiceFromPurchaseRequest(q, chatId, actor, pr);
    if (started) await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ادامه فاکتور…' });
    else await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (action === 'sell') {
    const listing = await listingById(q, pr.listing_id);
    if (!listing) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'خط پیدا نشد.' });
      return;
    }
    if (listing.status === 'sold') {
      await q`UPDATE purchase_requests SET status = 'completed' WHERE id = ${id} AND status <> 'completed'`;
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این خط قبلاً فروخته شده.' });
      await say(chatId, `خط ${formatPhoneDisplay(listing.phone_number, listing.phone_display)} قبلاً فروخته شده.\nبرای فاکتور «فاکتور با اطلاعات مشتری» را بزنید.`);
      return;
    }
    if (!saleAllowed(listing.status)) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این خط قابل فروش نیست.' });
      return;
    }
    if (listing.status === 'reserved' && Number(listing.reserved_by) !== Number(actor.uid) && !actor.isOwner) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'خط برای ادمین دیگری رزرو است.' });
      return;
    }
    let current = listing;
    if (listing.status === 'active') {
      const reserved = await reserveListing(q, listing.id, actor.uid);
      if (!reserved) {
        await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'رزرو انجام نشد (شاید دیگر موجود نباشد).' });
        return;
      }
      current = reserved;
      let fresh = await syncListingChannel(q, request, listing.id);
      fresh = await postReserveNotice(q, tg, fresh);
      current = fresh || current;
    }
    const sold = await sellListing(q, listing.id, actor.uid);
    if (!sold) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فروش ثبت نشد.' });
      return;
    }
    if (current?.status === 'reserved') await clearReserveNotice(q, tg, current);
    await syncListingChannel(q, request, listing.id);
    const freshSold = await listingById(q, listing.id);
    await announceSold(q, tg, { ...(freshSold || sold), channel_chat_id: current.channel_chat_id, channel_message_id: current.channel_message_id });
    await q`UPDATE purchase_requests SET status = 'completed', assigned_admin = COALESCE(assigned_admin, ${actor.uid}) WHERE id = ${id}`;
    const phoneLabel = formatPhoneDisplay(sold.phone_number, sold.phone_display);
    await say(pr.customer_telegram_id, `خط ${phoneLabel} برای درخواست خرید شما ثبت فروش شد.\nادمین برای تحویل و هماهنگی با شما تماس می‌گیرد.`);
    await say(chatId, `فروش انجام شد.\n${phoneLabel}\nمشتری: ${pr.customer_name || pr.customer_telegram_id}\n\nبرای صدور فاکتور با نام و شمارهٔ ثبت‌شده در درخواست، «فاکتور با اطلاعات مشتری» را بزنید.`, markup({ inline_keyboard: purchaseShortcutKeyboard(id) }));
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'رزرو (در صورت نیاز) و فروش ثبت شد.' });
  }
}

async function startInvoiceFromPurchaseRequest(q, chatId, actor, pr) {
  const listing = await listingById(q, pr.listing_id);
  if (!listing || listing.status !== 'sold') {
    await say(chatId, 'فاکتور فقط بعد از فروش ممکن است.\nابتدا «رزرو و فروش» را بزنید.');
    return false;
  }
  const existing = (await q`SELECT * FROM invoices WHERE listing_id = ${listing.id} LIMIT 1`)[0];
  if (existing?.pdf_base64) {
    await sendPdf(chatId, invoicePdfFilename(existing), existing.pdf_base64, `فاکتور ${existing.invoice_number}`);
    return true;
  }
  const saleType = pr.request_type === 'cash' ? 'cash' : 'installment';
  const step = pr.customer_name?.trim() ? 'nid' : 'name';
  await q`INSERT INTO invoice_drafts(telegram_user_id, listing_id, step, customer_name, customer_phone, sale_type, months, cash_percent)
    VALUES(${actor.uid}, ${listing.id}, ${step}, ${pr.customer_name?.trim() || null}, ${pr.customer_phone || null}, ${saleType}, ${pr.months}, ${pr.cash_percent})
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      listing_id = EXCLUDED.listing_id, step = EXCLUDED.step,
      customer_name = EXCLUDED.customer_name, customer_phone = EXCLUDED.customer_phone,
      national_id = NULL, address = NULL, birth_date = NULL,
      sale_type = EXCLUDED.sale_type, months = EXCLUDED.months, cash_percent = EXCLUDED.cash_percent,
      updated_at = NOW()`;
  if (step === 'name') await say(chatId, 'نام و نام خانوادگی خریدار را وارد کنید.');
  else await say(chatId, 'کد ملی ۱۰ رقمی خریدار را وارد کنید.');
  return true;
}

async function handleMenu(q, request, message, actor, text) {
  const chatId = message.chat.id;
  if (text === MENU.guide) { await sendStaffGuide(chatId, actor); return true; }
  if (text === MENU.add && actor.allow('add_listing')) {
    await say(chatId, [
      'ثبت سیم‌کارت — مرحله ۱ از ۴',
      '',
      'این ۳ خط را در یک پیام بفرستید:',
      '۱) شماره 0912…',
      '۲) قیمت به میلیون تومان (مثلاً 580 یعنی ۵۸۰ میلیون)',
      '۳) وضعیت یا توضیح',
      '',
      'مثال:',
      '0912 157 27 58',
      '580',
      'کارکرده',
      '',
      'مراحل بعد: مالک → انبار → تاریخ سند',
      '',
      'ثبت دسته‌ای: /excel برای قالب، سپس فایل .xlsx را همین‌جا بفرستید.',
      '/cancel = لغو'
    ].join('\n'));
    return true;
  }
  if ((text === '/excel' || text === '/exceltemplate' || text === 'قالب اکسل') && (actor.isOwner || actor.allow('add_listing'))) {
    await sendListingsExcelTemplate(chatId);
    return true;
  }
  if (text === MENU.openLines && actor.allow('lookup')) {
    await sendOpenLinesPanel(q, chatId, actor, 1, 'all', null);
    return true;
  }
  if (text === MENU.lookup && actor.allow('lookup')) {
    await say(chatId, [
      'استعلام خط',
      '',
      'شماره 0912 را بفرستید (با یا بدون فاصله).',
      'یا: /lookup 09121572758',
      '',
      'بعد از نمایش جزئیات، از دکمه‌های زیر پیام عمل کنید:',
      'رزرو · فروش · تغییر مالک/انبار · تاریخ سند'
    ].join('\n'));
    return true;
  }
  if (text === MENU.owners && actor.allow('owners')) { await sendOwners(q, chatId, actor); return true; }
  if (text === MENU.warehouses && canViewWarehouses(actor)) { await sendWarehouses(q, chatId, actor); return true; }
  if (text === MENU.reports && actor.allow('reports')) { await sendReports(q, chatId); return true; }
  if (text === MENU.invoice && actor.allow('invoices')) {
    await say(chatId, [
      'فاکتور',
      '',
      '۱) خط را استعلام کنید (باید وضعیت «فروخته شده» باشد)',
      '۲) «صدور / دریافت فاکتور» را بزنید',
      '۳) نام، کد ملی، موبایل، آدرس و … را مرحله‌به‌مرحله وارد کنید',
      '',
      'جستجوی فاکتور صادرشده:',
      '/invoice شماره فاکتور یا کد ملی یا موبایل',
      '/customer کد ملی یا موبایل — سوابق خرید مشتری',
      '/invoices — آخرین فاکتورها'
    ].join('\n'));
    return true;
  }
  if (text === MENU.history && actor.allow('history')) {
    await say(chatId, 'تاریخچه تغییرات یک خط:\n/history 09121572758\n\nیا از استعلام خط → «مشاهده تاریخچه»');
    return true;
  }
  if (text === MENU.lines && actor.allow('lines')) {
    await q`DELETE FROM line_list_sessions WHERE telegram_user_id = ${actor.uid}`;
    await sendLines(q, chatId, actor, 1, {}, null, true);
    return true;
  }
  if (text === MENU.manage && (actor.isOwner || actor.allow('settings') || actor.allow('admin_management'))) {
    await say(chatId, 'مدیریت سیستم\n\nتنظیمات اقساط، کانال، اینستاگرام، ادمین‌ها و اطلاعات فروشگاه:', markup(manageKeyboard(actor)));
    return true;
  }
  return false;
}

function isSettingsManageCallback(data) {
  return data === 'manage_sim' || data === 'manage_inst_toggle' || data === 'manage_channel'
    || data === 'manage_instagram' || data === 'manage_bot' || data === 'manage_back' || data === 'manage_price_up';
}

function manageKeyboard(actor) {
  const rows = [];
  if (actor.isOwner || actor.allow('settings')) {
    rows.push([{ text: '💳 تنظیمات سیم‌کارت', callback_data: 'manage_sim' }]);
  }
  if (actor.allow('admin_management')) {
    rows.push([{ text: '👥 مدیریت ادمین‌ها', callback_data: 'manage_admins' }]);
  }
  if (actor.allow('settings') || actor.isOwner) {
    rows.push([
      { text: '📢 تنظیمات کانال', callback_data: 'manage_channel' },
      { text: '📷 تنظیمات اینستاگرام', callback_data: 'manage_instagram' }
    ]);
    rows.push([{ text: '📈 افزایش قیمت درصدی', callback_data: 'manage_price_up' }]);
  }
  rows.push([{ text: '🤖 تنظیمات ربات', callback_data: 'manage_bot' }]);
  rows.push([{ text: '↩️ بازگشت', callback_data: 'manage_back' }]);
  return { inline_keyboard: rows };
}

async function handleCommand(q, request, message, actor, text) {
  const chatId = message.chat.id;
  const uid = actor.uid;
  if (text === '/owners' && actor.allow('owners')) { await sendOwners(q, chatId, actor); return true; }
  if (text.startsWith('/addowner ') && actor.isOwner) {
    const name = text.slice(10).trim();
    if (!name) { await say(chatId, 'نام مالک را وارد کنید.'); return true; }
    await q`INSERT INTO owners(name, active, max_line_slots) VALUES(${name}, true, 10)`;
    await say(chatId, `مالک «${name}» اضافه شد. سقف پیش‌فرض: 10 خط`);
    return true;
  }
  if (text.startsWith('/removeowner ') && actor.isOwner) {
    const id = Number(text.split(/\s+/)[1]);
    if (!id) { await say(chatId, 'فرمت: /removeowner ID'); return true; }
    await q`UPDATE owners SET active = false, updated_at = NOW() WHERE id = ${id}`;
    await say(chatId, 'مالک غیرفعال شد.');
    return true;
  }
  const slot = parseOwnerSlot(text);
  if (slot) {
    if (!actor.isOwner) { await deny(chatId); return true; }
    const owner = (await q`SELECT * FROM owners WHERE id = ${slot.id} LIMIT 1`)[0];
    if (!owner) { await say(chatId, 'مالک پیدا نشد.'); return true; }
    const applied = await applyOwnerCap(q, slot.id, slot.slots);
    if (!applied.ok) { await say(chatId, applied.error); return true; }
    await say(chatId, `سقف ${owner.name} روی ${capacityLabel(applied.owner.used, slot.slots)} تنظیم شد.`);
    return true;
  }
  if (text === '/warehouses' && canViewWarehouses(actor)) { await sendWarehouses(q, chatId, actor); return true; }
  if (text.startsWith('/addwarehouse ') && actor.isOwner) {
    const name = text.slice(14).trim();
    if (!name) { await say(chatId, 'نام انبار را وارد کنید.'); return true; }
    await q`INSERT INTO warehouses(name, active) VALUES(${name}, true)`;
    await say(chatId, `انبار «${name}» اضافه شد.`);
    return true;
  }
  if (text.startsWith('/removewarehouse ') && actor.isOwner) {
    const id = Number(text.split(/\s+/)[1]);
    if (!id) { await say(chatId, 'فرمت: /removewarehouse ID'); return true; }
    await q`UPDATE warehouses SET active = false, updated_at = NOW() WHERE id = ${id}`;
    await say(chatId, 'انبار غیرفعال شد.');
    return true;
  }
  if ((text.startsWith('/lookup ') || text.startsWith('/lookup@')) && actor.allow('lookup')) {
    const phone = normalizePhone(text.replace(/^\/lookup(?:@\w+)?\s*/, ''));
    if (!phone) { await say(chatId, 'فرمت: /lookup 0912XXXXXXX'); return true; }
    await sendLookup(q, chatId, actor, phone.digits, phone.display);
    return true;
  }
  if (text.startsWith('/lookup')) { await deny(chatId); return true; }
  if ((text === '/openlines' || text.startsWith('/openlines@') || text === '/reserved' || text.startsWith('/reserved@')) && actor.allow('lookup')) {
    await sendOpenLinesPanel(q, chatId, actor, 1, 'all', null);
    return true;
  }
  if (text.startsWith('/history ') && actor.allow('history')) { await sendHistory(q, chatId, text.slice(9).trim()); return true; }
  if (text.startsWith('/history')) { await deny(chatId); return true; }
  if (text.startsWith('/setinterest ') && (actor.isOwner || actor.allow('settings'))) {
    const value = Number(toLatinDigits(text.split(/\s+/)[1]));
    if (!Number.isFinite(value) || value < 0 || value > 100) { await say(chatId, 'سود باید عددی بین 0 تا 100 باشد.'); return true; }
    await putSetting(q, 'installment_interest_percent_monthly', value);
    await say(chatId, `سود اقساط ماهانه روی ${value}% تنظیم شد.`);
    return true;
  }
  if ((actor.isOwner || actor.allow('settings')) && text.startsWith('/setinstallmentmonths ')) {
    const months = parseNumberList(text.slice(22), { min: 1, max: 120 });
    if (!months.length) { await say(chatId, 'مثال: /setinstallmentmonths 2 3 4 5 6 7 8'); return true; }
    await putSetting(q, 'installment_month_options', months.join(','));
    await say(chatId, `مدت‌های مجاز اقساط:\n${months.join('، ')} ماه`);
    return true;
  }
  if ((actor.isOwner || actor.allow('settings')) && text.startsWith('/setinstallmentpercents ')) {
    const percents = parseNumberList(text.slice(24), { min: 1, max: 99 });
    if (!percents.length) { await say(chatId, 'مثال: /setinstallmentpercents 30 40 50 60 70 80 90'); return true; }
    await putSetting(q, 'installment_percent_options', percents.join(','));
    await say(chatId, `درصدهای پیش‌پرداخت:\n${percents.join('، ')}٪`);
    return true;
  }
  if ((actor.isOwner || actor.allow('settings')) && text.startsWith('/setinstallmentround ')) {
    const round = Number(toLatinDigits(text.split(/\s+/)[1]?.replace(/,/g, '')));
    if (!Number.isFinite(round) || round <= 0) { await say(chatId, 'مثال: /setinstallmentround 50000'); return true; }
    await putSetting(q, 'installment_round_toman', Math.round(round));
    await say(chatId, `گرد کردن قسط: ${money(round)} تومان`);
    return true;
  }
  if ((actor.isOwner || actor.allow('settings')) && text.startsWith('/setinstallmentdefault ')) {
    const pct = Number(toLatinDigits(text.split(/\s+/)[1]));
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) { await say(chatId, 'درصد بین 1 تا 99.'); return true; }
    await putSetting(q, 'installment_default_percent', Math.round(pct));
    await say(chatId, `پیش‌پرداخت پیش‌فرض: ${Math.round(pct)}٪`);
    return true;
  }
  if ((actor.isOwner || actor.allow('settings')) && text.startsWith('/setpurchaseexpire ')) {
    const minutes = Number(toLatinDigits(text.split(/\s+/)[1]));
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) { await say(chatId, 'مدت بین 5 تا 1440 دقیقه.'); return true; }
    await putSetting(q, 'purchase_request_expire_minutes', minutes);
    await say(chatId, `انقضای درخواست خرید: ${minutes} دقیقه`);
    return true;
  }
  if (text === '/toggleinstallment' && (actor.isOwner || actor.allow('settings'))) {
    const inst = await getInstallmentConfig(q);
    await putSetting(q, 'installment_sales_enabled', inst.salesEnabled ? 'false' : 'true');
    const next = await getInstallmentConfig(q);
    const channelUpdates = await refreshInstallmentChannelPosts(q, tg, request, next);
    await say(chatId, [
      `فروش اقساطی: ${inst.salesEnabled ? 'غیرفعال شد' : 'فعال شد'}.`,
      channelUpdates ? `${channelUpdates} آگهی کانال به‌روز شد.` : ''
    ].filter(Boolean).join('\n'));
    return true;
  }
  if (text.startsWith('/setinstagram ') && (actor.isOwner || actor.allow('settings'))) {
    const value = text.slice(14).trim();
    if (!value) { await say(chatId, 'فرمت: /setinstagram @username'); return true; }
    await putSetting(q, 'instagram_username', value);
    await say(chatId, `آیدی اینستاگرام روی ${value} تنظیم شد.`);
    return true;
  }
  if (text.startsWith('/setstorename ') && actor.isOwner) { await putSetting(q, 'store_name', text.slice(14).trim()); await say(chatId, 'نام فروشگاه ذخیره شد.'); return true; }
  if (text.startsWith('/setstorephone ') && actor.isOwner) { await putSetting(q, 'store_phone', text.slice(15).trim()); await say(chatId, 'تلفن فروشگاه ذخیره شد.'); return true; }
  if (text.startsWith('/setstoreaddress ') && actor.isOwner) { await putSetting(q, 'store_address', text.slice(17).trim()); await say(chatId, 'آدرس فروشگاه ذخیره شد.'); return true; }
  const setChannelMsg = parseSetChannelMsg(text);
  if (setChannelMsg && canEditChannelMessages(actor)) {
    const meta = parseSetChannelMsgMeta(message.text ?? text);
    const key = channelMsgKeyFromAlias(setChannelMsg.alias);
    const { text: body, entities: msgEntities } = channelMsgBodyFromMessage(message, meta);
    if (!key) {
      await say(chatId, 'نوع: reserved | sold | ready | special | specialreply | docready | docfuture | solddoc | installment | cash\nمثال: /setchannelmsg sold ❌ فروش رفت ❌');
      return true;
    }
    if (!body || body.length > 500) {
      await say(chatId, 'متن پیام باید بین ۱ تا ۵۰۰ کاراکتر باشد.');
      return true;
    }
    await saveChannelMessage(q, putSetting, key, body, msgEntities);
    const echo = sendMessagePayload(body, msgEntities);
    const prefix = `پیام «${CHANNEL_MSG_EDIT_LABELS[key]}» ذخیره شد:\n`;
    const shifted = (echo.entities || []).map((e) => ({ ...e, offset: e.offset + utf16Length(prefix) }));
    await tg('sendMessage', {
      chat_id: chatId,
      text: `${prefix}${echo.text}`,
      ...(shifted.length ? { entities: shifted } : {})
    });
    return true;
  }
  if (text === '/partners' && (actor.isOwner || actor.allow('partners'))) { await sendPartners(q, chatId); return true; }
  if (text.startsWith('/addpartner ') && actor.isOwner) {
    const parts = text.trim().split(/\s+/);
    if (!/^\d+$/.test(parts[1] || '')) { await say(chatId, 'شناسه تلگرام معتبر نیست.'); return true; }
    await q`INSERT INTO partners(telegram_user_id, display_name, active) VALUES(${parts[1]}, ${parts.slice(2).join(' ') || null}, true)
      ON CONFLICT(telegram_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, active = true, updated_at = NOW()`;
    await say(chatId, 'همکار اضافه و فعال شد.');
    return true;
  }
  if (text.startsWith('/removepartner ') && actor.isOwner) { await q`DELETE FROM partners WHERE telegram_user_id = ${text.split(/\s+/)[1]}`; await say(chatId, 'همکار حذف شد.'); return true; }
  if (text.startsWith('/togglepartner ') && actor.isOwner) { await q`UPDATE partners SET active = NOT active, updated_at = NOW() WHERE telegram_user_id = ${text.split(/\s+/)[1]}`; await say(chatId, 'وضعیت همکار تغییر کرد.'); return true; }
  if (text.startsWith('/setadmin ') && (actor.isOwner || actor.allow('admin_management'))) {
    const parts = text.trim().split(/\s+/);
    const priority = Number(parts[1]);
    const id = parts[2];
    const username = parts[3] || ADMIN_LABELS[priority];
    if (![1, 2].includes(priority) || !/^\d+$/.test(id || '')) { await say(chatId, 'فرمت: /setadmin 1 TELEGRAM_ID @username'); return true; }
    await q`DELETE FROM admins WHERE priority = ${priority} OR telegram_user_id = ${id}`;
    await q`INSERT INTO admins(telegram_user_id, display_name, role, priority, active, permissions) VALUES(${id}, ${username}, 'admin', ${priority}, true, ${JSON.stringify(ALL_PERMISSIONS)}::jsonb)`;
    await say(chatId, `ادمین ${priority} تنظیم شد: ${username}\nهمه دسترسی‌ها فعال است و از بخش مدیریت قابل محدود کردن است.`);
    return true;
  }
  if (text === '/admins' && (actor.isOwner || actor.allow('admin_management'))) {
    const rows = await q`SELECT telegram_user_id, display_name, priority, active FROM admins ORDER BY priority`;
    await say(chatId, `مالک و ادمین‌ها\n\n${adminListLines(rows).join('\n')}\n\nتنظیم ادمین: /setadmin 1 TELEGRAM_ID @username`);
    return true;
  }
  if (text.startsWith('/removeadmin ') && (actor.isOwner || actor.allow('admin_management'))) {
    await q`UPDATE admins SET active = false WHERE telegram_user_id = ${text.split(/\s+/)[1]}`;
    await say(chatId, 'ادمین غیرفعال شد.');
    return true;
  }
  if (text === '/invoices' && actor.allow('invoices')) { await sendInvoiceList(q, chatId, null); return true; }
  if (text.startsWith('/invoice ') && actor.allow('invoices')) { await sendInvoiceList(q, chatId, text.slice(9).trim()); return true; }
  if (text.startsWith('/customer ') && actor.allow('invoices')) { await sendCustomerPurchaseHistory(q, chatId, text.slice(10).trim()); return true; }
  if (text === '/customer' && actor.allow('invoices')) {
    await say(chatId, 'سوابق خرید مشتری:\n/customer کد_ملی\n/customer 0912…');
    return true;
  }
  if (text.startsWith('/invoice') || text.startsWith('/invoices') || text.startsWith('/customer')) { await deny(chatId); return true; }
  if (text === '/story' || text === 'استوری') { await say(chatId, 'چند خط استوری کنم و کدام کدها؟\nمثال: ۱۰ تلگرام و ۱۰ واتساپ — کد ۱ و ۲'); return true; }
  if (text === '/guide' && actor.isStaff) {
    await syncBotCommandsForChat(tg, chatId, actor).catch(() => {});
    await sendStaffGuide(chatId, actor);
    return true;
  }
  if (text.startsWith('/setdiscount ') && canManualDiscount(actor)) {
    const parts = text.trim().split(/\s+/);
    const phone = normalizePhone(parts[1] || '');
    const discountText = parts.slice(2).join(' ').trim();
    if (!phone || !discountText) {
      await say(chatId, 'فرمت: /setdiscount 0912xxxxxxx 5%\nیا: /setdiscount 0912… 550\nیا: /setdiscount 0912… -20');
      return true;
    }
    const listing = await lookupListingByPhone(q, phone.digits);
    if (!listing) { await say(chatId, 'خط پیدا نشد.'); return true; }
    const listPrice = listingListPriceToman(listing);
    const parsed = parseManualDiscountInput(discountText, listPrice);
    if (!parsed) {
      await say(chatId, `تخفیف نامعتبر.\nقیمت مبنا: ${money(listPrice)} تومان`);
      return true;
    }
    const result = await applyManualListingDiscount(q, listing.id, parsed, actor.uid);
    if (!result.ok) { await say(chatId, 'اعمال تخفیف ممکن نشد.'); return true; }
    const fresh = await syncListingChannel(q, request, listing.id);
    await say(chatId, `تخفیف دستی\n${formatPhoneDisplay(fresh.phone_number, fresh.phone_display)}\n${money(result.listPrice)} → ${money(result.newPrice)} ت (تخفیف ${money(result.discount)})`);
    return true;
  }
  if (text.startsWith('/priceup ') && (actor.isOwner || actor.allow('settings'))) {
    const parts = text.trim().split(/\s+/);
    const percent = Number(toLatinDigits(parts[1] || '').replace(',', '.'));
    let scope = 'active';
    if (parts[2] === 'open') scope = 'open';
    else if (parts[2] === 'all') scope = 'all_open';
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      await say(chatId, 'فرمت: /priceup درصد [active|open|all]\nمثال: /priceup 5\nمثال: /priceup 10 open');
      return true;
    }
    await sendPriceUpConfirm(q, chatId, message, actor, scope, percent);
    return true;
  }
  return false;
}

async function loadPendingSessions(q, actor, uid) {
  const [ownerSession, draft, edit, pending] = await Promise.all([
    (actor.isOwner || actor.allow('settings')) ? q`SELECT * FROM owner_action_sessions WHERE telegram_user_id = ${uid} LIMIT 1`.then((rows) => rows[0]) : null,
    actor.allow('invoices') ? q`SELECT * FROM invoice_drafts WHERE telegram_user_id = ${uid} LIMIT 1`.then((rows) => rows[0]) : null,
    actor.allow('lookup') ? q`SELECT * FROM listing_edit_sessions WHERE telegram_user_id = ${uid} LIMIT 1`.then((rows) => rows[0]) : null,
    actor.allow('add_listing') ? q`SELECT * FROM listing_registration_sessions WHERE telegram_user_id = ${uid} LIMIT 1`.then((rows) => rows[0]) : null
  ]);
  return { ownerSession, draft, edit, pending };
}

async function handlePendingText(q, request, message, actor, text) {
  const chatId = message.chat.id;
  const uid = actor.uid;
  const { ownerSession, draft, edit, pending } = await loadPendingSessions(q, actor, uid);
  const priceUpScope = ownerSession?.action?.match(/^price_up:(active|open|all_open)$/);
  if (priceUpScope && (actor.isOwner || actor.allow('settings'))) {
    const percent = Number(toLatinDigits(text.trim()).replace(',', '.'));
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      await say(chatId, 'درصد بین ۰.۱ تا ۱۰۰ وارد کنید.\nمثال: 7 یا 7.5');
      return true;
    }
    await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
    await sendPriceUpConfirm(q, chatId, message, actor, priceUpScope[1], percent);
    return true;
  }
  if (actor.isOwner) {
    if (ownerSession?.action === 'add') {
      await q`INSERT INTO owners(name, active, max_line_slots) VALUES(${text.trim()}, true, 10)`;
      await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
      await say(chatId, `مالک «${text.trim()}» اضافه شد.\nسقف پیش‌فرض: 10 خط`);
      return true;
    }
    if (ownerSession?.action === 'limit') {
      const slots = Number(toLatinDigits(text.trim()).replace(/\s/g, ''));
      const applied = await applyOwnerCap(q, ownerSession.owner_id, slots);
      await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
      if (!applied.ok) { await say(chatId, applied.error); return true; }
      await say(chatId, `سقف «${applied.owner.name}» شد ${applied.owner.used} از ${slots}.`);
      return true;
    }
    if (ownerSession?.action === 'warehouse_add') {
      const name = text.trim();
      if (!name) { await say(chatId, 'نام انبار را وارد کنید.'); return true; }
      const exists = (await q`SELECT id FROM warehouses WHERE lower(name) = lower(${name}) LIMIT 1`)[0];
      if (exists) {
        await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
        await say(chatId, `انبار «${name}» از قبل وجود دارد.`);
        return true;
      }
      await q`INSERT INTO warehouses(name, active) VALUES(${name}, true)`;
      await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
      await say(chatId, `انبار «${name}» اضافه شد.`);
      if (canViewWarehouses(actor)) await sendWarehouses(q, chatId, actor);
      return true;
    }
  }
  const chanmsgKey = ownerSession?.action?.match(/^chanmsg:(channel_msg_[a-z0-9_]+)$/);
  if (chanmsgKey && canEditChannelMessages(actor)) {
    const body = text.trim();
    if (!body || body.length > 500) {
      await say(chatId, 'متن پیام باید بین ۱ تا ۵۰۰ کاراکتر باشد.\nبرای انصراف /cancel بزنید.');
      return true;
    }
    const key = chanmsgKey[1];
    if (!CHANNEL_MSG_DEFAULTS[key]) {
      await say(chatId, 'کلید پیام نامعتبر است.');
      return true;
    }
    const { text: bodyNorm, entities: msgEntities } = channelMsgBodyFromMessage(message, { body });
    await saveChannelMessage(q, putSetting, key, bodyNorm, msgEntities);
    await q`DELETE FROM owner_action_sessions WHERE telegram_user_id = ${uid}`;
    const echo = sendMessagePayload(bodyNorm, msgEntities);
    const prefix = `پیام «${CHANNEL_MSG_EDIT_LABELS[key] || key}» ذخیره شد:\n`;
    const suffix = '\n\nبرای به‌روزرسانی آگهی‌های قبلی در کانال، همان خط را در استعلام «به‌روزرسانی» کنید.';
    const shifted = (echo.entities || []).map((e) => ({ ...e, offset: e.offset + utf16Length(prefix) }));
    await tg('sendMessage', {
      chat_id: chatId,
      text: `${prefix}${echo.text}${suffix}`,
      ...(shifted.length ? { entities: shifted } : {})
    });
    return true;
  }
  if (draft && actor.allow('invoices')) return continueInvoice(q, chatId, uid, draft, text);
  if (edit && actor.allow('lookup')) {
    const listing = (await q`SELECT * FROM listings WHERE id = ${edit.listing_id} LIMIT 1`)[0];
    if (!listing) {
      await q`DELETE FROM listing_edit_sessions WHERE telegram_user_id = ${uid}`;
      await say(chatId, 'سیم‌کارت پیدا نشد.');
      return true;
    }
    if (edit.action === 'date') {
      const date = parseDateInput(text);
      if (!date) { await say(chatId, 'تاریخ نامعتبر است. مثال: 1405/07/25'); return true; }
      await q`UPDATE listings SET document_ready_date = ${date}, updated_at = NOW() WHERE id = ${listing.id}`;
      await logChange(q, { listingId: listing.id, field: 'document_ready_date', from: listing.document_ready_date, to: date, by: uid });
      await q`DELETE FROM listing_edit_sessions WHERE telegram_user_id = ${uid}`;
      const fresh = await syncListingChannel(q, request, listing.id);
      await say(chatId, `تاریخ آماده سند تغییر کرد.\n${formatPhoneDisplay(fresh.phone_number, fresh.phone_display)}\n${displayJalali(date)}`);
      return true;
    }
    if (edit.action === 'discount' && canManualDiscount(actor)) {
      const listPrice = listingListPriceToman(listing);
      const parsed = parseManualDiscountInput(text, listPrice);
      if (!parsed) {
        await say(chatId, [
          'ورودی نامعتبر است.',
          '',
          `قیمت مبنا: ${money(listPrice)} تومان`,
          '• درصد: 5 یا 5%',
          '• کسر (میلیون): -20',
          '• قیمت نهایی (میلیون): 550',
          '',
          '/cancel برای انصراف'
        ].join('\n'));
        return true;
      }
      const result = await applyManualListingDiscount(q, listing.id, parsed, uid);
      if (!result.ok) {
        await say(chatId, 'اعمال تخفیف ممکن نشد. وضعیت خط یا مبلغ را بررسی کنید.');
        return true;
      }
      await q`DELETE FROM listing_edit_sessions WHERE telegram_user_id = ${uid}`;
      const fresh = await syncListingChannel(q, request, listing.id);
      await say(chatId, [
        'تخفیف دستی اعمال شد.',
        formatPhoneDisplay(fresh.phone_number, fresh.phone_display),
        `قیمت: ${money(result.listPrice)} → ${money(result.newPrice)} تومان`,
        `تخفیف: ${money(result.discount)} تومان`,
        '',
        'کانال و فاکتور از همین قیمت نهایی استفاده می‌کنند.'
      ].join('\n'), markup(lookupKeyboard(fresh, actor)));
      return true;
    }
  }
  if (pending && actor.allow('add_listing')) {
    if (!pending.owner_id || !pending.warehouse_id) {
      await say(chatId, 'ثبت ناتمام است.\nاز پیام قبلی (دکمه‌های مالک/انبار) ادامه دهید، یا /cancel و دوباره «ثبت سیم‌کارت».');
      return true;
    }
    const date = parseDateInput(text);
    if (!date) { await say(chatId, 'تاریخ را به شکل 1405/07/25 وارد کنید یا دکمه پیش‌فرض را بزنید.'); return true; }
    await finishRegistration(q, request, chatId, uid, pending, date);
    return true;
  }
  return false;
}

async function beginRegistration(q, chatId, uid, parsed, actor) {
  const [owners, warehouses] = await Promise.all([
    ownerChoices(q, { phone: parsed.phone }),
    q`SELECT id FROM warehouses WHERE active = true LIMIT 1`
  ]);
  if (!owners.length) { await say(chatId, 'مالک فعالی با ظرفیت خالی وجود ندارد.\nمالک ربات با /addowner یا /setownerslot ظرفیت را تنظیم می‌کند.'); return; }
  if (!warehouses.length) {
    await say(chatId, actor.isOwner
      ? 'هنوز هیچ انباری تعریف نشده است.\nبرای ثبت خط اول انبار بسازید:\n/addwarehouse نام انبار'
      : 'هنوز هیچ انباری تعریف نشده است.\nاز مالک ربات بخواهید انبار تعریف کند (/addwarehouse).');
    return;
  }
  await q`INSERT INTO listing_registration_sessions(telegram_user_id, phone_number, phone_display, price_toman, condition_text)
    VALUES(${uid}, ${parsed.phone}, ${parsed.displayPhone}, ${parsed.price}, ${parsed.condition})
    ON CONFLICT(telegram_user_id) DO UPDATE SET phone_number = EXCLUDED.phone_number, phone_display = EXCLUDED.phone_display,
      price_toman = EXCLUDED.price_toman, condition_text = EXCLUDED.condition_text, owner_id = NULL, warehouse_id = NULL, created_at = NOW()`;
  await say(chatId, [
    `ثبت — مرحله ۲ از ۴`,
    formatPhoneDisplay(parsed.phone, parsed.displayPhone),
    `${money(parsed.price)} تومان — ${parsed.condition}`,
    '',
    'مالک سیم‌کارت را انتخاب کنید:',
    '/cancel = لغو'
  ].join('\n'), markup({ inline_keyboard: owners.map((owner) => [{ text: `${owner.name} — ${capacityLabel(owner.used, owner.max_line_slots)}`, callback_data: `regowner_${uid}_${owner.id}` }]) }));
}

async function ownerChoices(q, { phone, currentOwnerId } = {}) {
  let refOwnerId = currentOwnerId;
  if (refOwnerId == null && phone) {
    const open = await openListingByPhone(q, phone);
    refOwnerId = open?.owner_id;
  }
  const owners = await activeOwnersWithUsage(q);
  return owners.filter((owner) => canAssignOwner({
    used: owner.used,
    max: owner.max_line_slots,
    alreadyOnThisOwner: String(owner.id) === String(refOwnerId || '')
  }));
}

async function finishRegistration(q, request, chatId, uid, pending, date) {
  try {
    const saved = await saveListing(q, {
      phone: pending.phone_number,
      displayPhone: pending.phone_display,
      price: pending.price_toman,
      condition: pending.condition_text,
      ownerId: pending.owner_id,
      warehouseId: pending.warehouse_id,
      date,
      by: uid
    });
    const [, fresh] = await Promise.all([
      q`DELETE FROM listing_registration_sessions WHERE telegram_user_id = ${uid}`,
      listingById(q, saved.row.id)
    ]);
    const sent = await syncChannel(q, tg, fresh, publicOrigin(request));
    const published = sent?.ok || /not modified/i.test(sent?.description || '');
    await say(chatId, `ثبت ${saved.mode === 'create' ? (saved.reopened ? 'دوره جدید' : 'اولیه') : 'به‌روزرسانی'} انجام شد.\n${formatPhoneDisplay(fresh.phone_number, fresh.phone_display)}\nمالک: ${fresh.owner_name || '-'}\nانبار: ${fresh.warehouse_name || '-'}\nتاریخ سند: ${displayJalali(date)}\n${published ? 'آگهی کانال به‌روز شد.' : 'آگهی در کانال منتشر نشد.'}`);
  } catch (error) {
    if (error.message === 'OWNER_FULL') await say(chatId, `ظرفیت این مالک تکمیل است: ${error.used}/${error.max}`);
    else if (error.message === 'OWNER_MISSING' || error.message === 'WAREHOUSE_MISSING') await say(chatId, 'مالک یا انبار معتبر نیست. ثبت را دوباره شروع کنید.');
    else throw error;
  }
}

async function sendLookup(q, chatId, actor, digits, display) {
  const full = await lookupListingByPhone(q, digits);
  if (!full) {
    await say(chatId, `سیم‌کارت ${formatPhoneDisplay(digits, display)} پیدا نشد.\n\nاگر تازه ثبت کرده‌اید، ثبت را کامل کنید (مالک/انبار/تاریخ).`);
    return;
  }
  await presentLookup(q, chatId, actor, full);
}

function lookupKeyboard(row, actor) {
  const id = row.id;
  const keyboard = [];
  if (actor.allow('lookup')) {
    if (reserveAllowed(row.status)) keyboard.push([{ text: 'رزرو کردن', callback_data: `lookup_reserve_${id}` }]);
    if (row.status === 'reserved') {
      const canDeliver = actor.isOwner || row.reserved_by == null || Number(row.reserved_by) === Number(actor.uid);
      if (canDeliver) {
        keyboard.push([{ text: 'تحویل به مشتری (فروش خط رزرو)', callback_data: `lookup_deliver_${id}` }]);
      }
      keyboard.push([{ text: 'آزاد کردن رزرو', callback_data: `lookup_release_${id}` }]);
    } else if (saleAllowed(row.status)) {
      keyboard.push([{ text: 'فروش نهایی', callback_data: `lookup_sell_${id}` }]);
    }
    keyboard.push([{ text: 'تغییر وضعیت', callback_data: `lookup_status_${id}` }, { text: 'تغییر مالک', callback_data: `lookup_owner_${id}` }]);
    keyboard.push([{ text: 'تغییر انبار', callback_data: `lookup_warehouse_${id}` }, { text: 'تغییر تاریخ سند', callback_data: `lookup_date_${id}` }]);
    if (canManualDiscount(actor) && ['active', 'reserved', 'ready_transfer'].includes(row.status)) {
      keyboard.push([
        { text: 'تخفیف دستی', callback_data: `lookup_discount_${id}` },
        { text: 'حذف تخفیف', callback_data: `lookup_cleardiscount_${id}` }
      ]);
    }
  }
  if (actor.allow('history')) keyboard.push([{ text: 'مشاهده تاریخچه', callback_data: `lookup_history_${id}` }]);
  if (actor.allow('invoices') && row.status === 'sold') keyboard.push([{ text: 'صدور / دریافت فاکتور', callback_data: `invoice_start_${id}` }]);
  keyboard.push([{ text: 'بستن', callback_data: 'lookup_back' }]);
  return { inline_keyboard: keyboard };
}

const OPEN_LINE_FILTERS = { all: null, a: 'active', r: 'reserved', t: 'ready_transfer' };
const OPEN_LINE_FILTER_LABEL = { all: 'همه', a: 'موجود', r: 'رزرو', t: 'آماده انتقال' };

function openLineActionButtons(row, actor) {
  const id = row.id;
  const buttons = [[{ text: 'مدیریت (استعلام کامل)', callback_data: `olp_open_${id}` }]];
  const shortcuts = [];
  if (row.status === 'active' && reserveAllowed(row.status)) {
    shortcuts.push({ text: 'رزرو', callback_data: `olp_act_${id}_reserve` });
  }
  if (row.status === 'reserved') {
    const canAct = actor.isOwner || row.reserved_by == null || Number(row.reserved_by) === Number(actor.uid);
    if (canAct) {
      shortcuts.push({ text: 'تحویل', callback_data: `olp_act_${id}_deliver` });
      shortcuts.push({ text: 'آزاد کردن رزرو', callback_data: `olp_act_${id}_release` });
    }
  } else if (saleAllowed(row.status)) {
    shortcuts.push({ text: 'فروش', callback_data: `olp_act_${id}_sell` });
  }
  if (shortcuts.length) buttons.push(shortcuts);
  return buttons;
}

function openLineListText(listNo, row) {
  const phone = formatPhoneDisplay(row.phone_number, row.phone_display);
  const pricePart = listingPriceBreakdown(row).hasDiscount
    ? formatListingPricePlain(row).replace(/\n/g, ' · ')
    : `${formatMoneyDisplay(row.price_toman)} تومان`;
  const priceStatus = `${pricePart} — ${statusLabel(row.status)}`;
  if (row.status === 'reserved') {
    const who = row.reserver_name || (row.reserved_by ? String(row.reserved_by) : '-');
    const when = row.reserved_until ? displayDateTime(row.reserved_until) : '-';
    return `${listNo}. ${phone}\n   ${priceStatus}\n   رزرو: ${who} · ${when}`;
  }
  return `${listNo}. ${phone}\n   ${priceStatus}`;
}

function openLineNumberKeyboard(rows, currentPage, limit, filterToken) {
  const numbered = rows.map((row, index) => {
    const listNo = (currentPage - 1) * limit + index + 1;
    return { text: String(listNo), callback_data: `olp_pick_${row.id}_${currentPage}_${filterToken}` };
  });
  const keyboard = [];
  for (let i = 0; i < numbered.length; i += 5) {
    keyboard.push(numbered.slice(i, i + 5));
  }
  return keyboard;
}

async function sendOpenLineActionsMenu(q, chatId, actor, listing, listPage, filterToken, messageId) {
  const phone = formatPhoneDisplay(listing.phone_number, listing.phone_display);
  const extra = listing.status === 'reserved' && listing.reserved_until
    ? `\nرزرو تا: ${displayDateTime(listing.reserved_until)}`
    : '';
  const keyboard = openLineActionButtons(listing, actor);
  keyboard.push([{ text: '« بازگشت به لیست', callback_data: `olp_page_${listPage}_${filterToken}` }]);
  const text = [
    'عملیات روی خط',
    '',
    phone,
    `${statusLabel(listing.status)} — ${formatListingPricePlain(listing).replace(/\n/g, ' · ')}${extra}`,
    '',
    'یک عملیات را انتخاب کنید:'
  ].join('\n');
  const payload = { text, reply_markup: JSON.stringify({ inline_keyboard: keyboard }) };
  if (messageId) await tg('editMessageText', { chat_id: chatId, message_id: messageId, ...payload });
  else await say(chatId, text, { reply_markup: payload.reply_markup });
}

async function sendOpenLinesPanel(q, chatId, actor, page, filterToken, messageId) {
  const limit = 10;
  const safePage = Math.max(1, page);
  const status = OPEN_LINE_FILTERS[filterToken] ?? null;
  const countRows = await q`SELECT COUNT(*)::int AS count FROM listings l
    WHERE l.status IN ('active', 'reserved', 'ready_transfer')
      AND (${status}::text IS NULL OR l.status = ${status})`;
  const total = Number(countRows[0]?.count || 0);
  const pages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(safePage, pages);
  const rows = await q`SELECT l.id, l.phone_number, l.phone_display, l.price_toman, l.status, l.reserved_by, l.reserved_until,
      a.display_name AS reserver_name
    FROM listings l
    LEFT JOIN admins a ON a.telegram_user_id = l.reserved_by
    WHERE l.status IN ('active', 'reserved', 'ready_transfer')
      AND (${status}::text IS NULL OR l.status = ${status})
    ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'reserved' THEN 1 WHEN 'ready_transfer' THEN 2 ELSE 3 END,
      l.reserved_until ASC NULLS LAST, l.id DESC
    LIMIT ${limit} OFFSET ${(currentPage - 1) * limit}`;
  const filterLabel = OPEN_LINE_FILTER_LABEL[filterToken] || OPEN_LINE_FILTER_LABEL.all;
  const body = rows.length
    ? rows.map((row, index) => openLineListText((currentPage - 1) * limit + index + 1, row)).join('\n\n')
    : 'خطی در این فیلتر نیست.';
  const keyboard = openLineNumberKeyboard(rows, currentPage, limit, filterToken);
  const filters = ['all', 'a', 'r', 't'].map((token) => ({
    text: token === filterToken ? `• ${OPEN_LINE_FILTER_LABEL[token]} •` : OPEN_LINE_FILTER_LABEL[token],
    callback_data: `olp_page_1_${token}`
  }));
  keyboard.push(filters);
  const nav = [];
  if (currentPage > 1) nav.push({ text: '◀ قبلی', callback_data: `olp_page_${currentPage - 1}_${filterToken}` });
  if (currentPage < pages) nav.push({ text: 'بعدی ▶', callback_data: `olp_page_${currentPage + 1}_${filterToken}` });
  if (nav.length) keyboard.push(nav);
  const text = [
    'خطوط موجود (برای فروش)',
    `فیلتر: ${filterLabel}`,
    '',
    body,
    '',
    `تعداد: ${total} — صفحه ${currentPage}/${pages}`,
    '',
    'روی شمارهٔ همان ردیف در لیست بزنید → منوی عملیات همان خط'
  ].join('\n');
  const payload = { text, reply_markup: JSON.stringify({ inline_keyboard: keyboard }) };
  if (messageId) await tg('editMessageText', { chat_id: chatId, message_id: messageId, ...payload });
  else await say(chatId, text, { reply_markup: payload.reply_markup });
}

async function sendHistory(q, chatId, raw) {
  const phone = normalizePhone(raw);
  if (!phone) { await say(chatId, 'شماره 0912 معتبر وارد کنید.'); return; }
  const rows = await historyForPhone(q, phone.digits);
  const [owners, warehouses] = await Promise.all([q`SELECT id, name FROM owners`, q`SELECT id, name FROM warehouses`]);
  await say(chatId, `تاریخچه ${formatPhoneDisplay(phone.digits, phone.display)}\n\n${historyLines(rows, new Map(owners.map((item) => [String(item.id), item.name])), new Map(warehouses.map((item) => [String(item.id), item.name])))}`);
}

async function loadOwnerCard(q, ownerId) {
  return (await q`SELECT o.id, o.name, o.active, o.max_line_slots, COUNT(l.id) FILTER (WHERE l.status IN ('active','reserved','ready_transfer','inactive'))::int AS used
    FROM owners o LEFT JOIN listings l ON l.owner_id = o.id WHERE o.id = ${ownerId} GROUP BY o.id`)[0] || null;
}

function ownerManageMarkup(owner) {
  const id = owner.id;
  const capButton = (slots) => ({ text: String(slots), callback_data: `owner_cap_${id}_${slots}` });
  return {
    inline_keyboard: [
      [{ text: owner.active ? 'غیرفعال کردن' : 'فعال کردن', callback_data: `owner_toggle_${id}` }],
      [capButton(10), capButton(20), capButton(50), capButton(100)],
      [{ text: 'عدد دلخواه سقف', callback_data: `owner_limit_${id}` }],
      [{ text: 'لیست خطوط', callback_data: `owner_lines_${id}_1` }],
      [{ text: 'بازگشت', callback_data: 'owners_back' }]
    ]
  };
}

function ownerManageText(owner) {
  const used = Number(owner.used || 0);
  const max = Number(owner.max_line_slots ?? 10);
  return [
    owner.name,
    `وضعیت: ${owner.active ? 'فعال' : 'غیرفعال'}`,
    `سیم‌کارت ثبت‌شده: ${used} از ${max}`,
    '',
    'سقف تعداد سیم‌کارت این مالک را از دکمه‌ها عوض کنید.',
    'عدد دلخواه را هم می‌توانید تایپ کنید.'
  ].join('\n');
}

async function applyOwnerCap(q, ownerId, slots) {
  const owner = await loadOwnerCard(q, ownerId);
  if (!owner) return { ok: false, error: 'مالک پیدا نشد.' };
  const used = Number(owner.used || 0);
  if (!Number.isInteger(slots) || slots < 0 || slots > 100000) return { ok: false, error: 'سقف باید یک عدد صحیح بین ۰ تا ۱۰۰۰۰۰ باشد.' };
  if (slots < used) return { ok: false, error: `این مالک ${used} خط باز دارد. سقف نمی‌تواند کمتر از ${used} باشد.` };
  await q`UPDATE owners SET max_line_slots = ${slots}, updated_at = NOW() WHERE id = ${ownerId}`;
  return { ok: true, owner: { ...owner, max_line_slots: slots } };
}

async function sendOwners(q, chatId, actor) {
  const rows = await q`SELECT o.id, o.name, o.active, o.max_line_slots, COUNT(l.id) FILTER (WHERE l.status IN ('active','reserved','ready_transfer','inactive'))::int AS used
    FROM owners o LEFT JOIN listings l ON l.owner_id = o.id
    GROUP BY o.id ORDER BY o.active DESC, o.name`;
  if (!actor.isOwner) {
    const lines = rows.filter((row) => row.active).map((row) => `${row.name} — ${capacityLabel(row.used, row.max_line_slots)}`).join('\n') || 'مالک فعالی نیست.';
    await say(chatId, `مالکین (فقط مشاهده)\n\n${lines}\n\nبرای ثبت خط، مالکی با ظرفیت خالی لازم است.`);
    return;
  }
  const keyboard = rows.map((row) => [{ text: `${row.name} — ${capacityLabel(row.used, row.max_line_slots)}${row.active ? '' : ' — غیرفعال'}`, callback_data: `owner_manage_${row.id}` }]);
  keyboard.push([{ text: 'افزودن مالک', callback_data: 'owner_add' }]);
  await say(chatId, 'مالکین\n\nمالک موردنظر را انتخاب کنید:', markup({ inline_keyboard: keyboard }));
}

async function sendWarehouses(q, chatId, actor) {
  const rows = await warehousesWithStock(q);
  if (!rows.length) {
    const emptyKb = actor.isOwner
      ? markup({ inline_keyboard: [[{ text: 'افزودن انبار', callback_data: 'wh_add' }]] })
      : undefined;
    await say(chatId, actor.isOwner
      ? 'هنوز انباری ثبت نشده است.\n\nدکمه «افزودن انبار» را بزنید یا:\n/addwarehouse نام\n(بدون انبار، ثبت خط ممکن نیست.)'
      : 'هنوز انباری ثبت نشده است.\nاز مالک ربات بخواهید با /addwarehouse انبار تعریف کند.', emptyKb);
    return;
  }
  const lines = rows.map((row, index) => warehouseStockLine(row, index)).join('\n');
  const keyboard = [];
  for (const row of rows.filter((item) => item.active)) {
    const open = Number(row.open_lines || 0);
    keyboard.push([{
      text: `${row.name} — ${open} خط`,
      callback_data: `wh_lines_${row.id}`
    }]);
  }
  if (actor.isOwner) {
    keyboard.push([{ text: 'افزودن انبار', callback_data: 'wh_add' }]);
  }
  if (actor.allow('add_listing')) {
    keyboard.push([{ text: 'ثبت سیم‌کارت (خط جدید)', callback_data: 'wh_add_listing' }]);
  }
  const footer = actor.isOwner ? '\n\nغیرفعال کردن انبار: /removewarehouse ID' : '';
  await say(chatId, `انبارها — موجودی خطوط باز\n\n${lines}\n\nروی هر انبار بزنید تا خطوط همان انبار را ببینید.${footer}`, markup({ inline_keyboard: keyboard }));
}

async function sendLines(q, chatId, actor, page, filter, messageId, showLinesHint = false) {
  const status = filter.status || null;
  const ownerId = filter.ownerId || null;
  const warehouseId = filter.warehouseId || null;
  await q`INSERT INTO line_list_sessions(telegram_user_id, status, owner_id, warehouse_id, updated_at)
    VALUES(${actor.uid}, ${status}, ${ownerId}, ${warehouseId}, NOW())
    ON CONFLICT(telegram_user_id) DO UPDATE SET status = EXCLUDED.status, owner_id = EXCLUDED.owner_id, warehouse_id = EXCLUDED.warehouse_id, updated_at = NOW()`;
  const limit = 15;
  const [countRows, rowsInitial] = await Promise.all([
    q`SELECT COUNT(*)::int AS count FROM listings l
      WHERE (${status}::text IS NULL OR l.status = ${status})
        AND (${ownerId}::bigint IS NULL OR l.owner_id = ${ownerId})
        AND (${warehouseId}::bigint IS NULL OR l.warehouse_id = ${warehouseId})`,
    q`SELECT l.phone_display, l.phone_number, l.price_toman, l.status, l.prefix_code, o.name AS owner_name
      FROM listings l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE (${status}::text IS NULL OR l.status = ${status})
        AND (${ownerId}::bigint IS NULL OR l.owner_id = ${ownerId})
        AND (${warehouseId}::bigint IS NULL OR l.warehouse_id = ${warehouseId})
      ORDER BY CASE WHEN l.prefix_code = 0 THEN 10 WHEN l.prefix_code BETWEEN 1 AND 9 THEN l.prefix_code ELSE 11 END, l.id DESC
      LIMIT ${limit} OFFSET ${(Math.max(1, page) - 1) * limit}`
  ]);
  const total = Number(countRows[0]?.count || 0);
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), pages);
  let rows = rowsInitial;
  if (safePage !== Math.max(1, page)) {
    rows = await q`SELECT l.phone_display, l.phone_number, l.price_toman, l.status, l.prefix_code, o.name AS owner_name
      FROM listings l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE (${status}::text IS NULL OR l.status = ${status})
        AND (${ownerId}::bigint IS NULL OR l.owner_id = ${ownerId})
        AND (${warehouseId}::bigint IS NULL OR l.warehouse_id = ${warehouseId})
      ORDER BY CASE WHEN l.prefix_code = 0 THEN 10 WHEN l.prefix_code BETWEEN 1 AND 9 THEN l.prefix_code ELSE 11 END, l.id DESC
      LIMIT ${limit} OFFSET ${(safePage - 1) * limit}`;
  }
  const body = rows.length ? rows.map((row, index) => `${(safePage - 1) * limit + index + 1}. ${formatPhoneDisplay(row.phone_number, row.phone_display)} — ${money(row.price_toman)} تومان — ${statusLabel(row.status)} — ${row.owner_name || '-'}`).join('\n') : 'خطی در این صفحه نیست.';
  const filterText = `وضعیت: ${status ? statusLabel(status) : 'همه'} | مالک: ${ownerId || 'همه'} | انبار: ${warehouseId || 'همه'}`;
  const token = status ? TOKEN_BY_STATUS[status] : 'all';
  const nav = [];
  if (safePage > 1) nav.push({ text: 'قبلی', callback_data: `lp_${safePage - 1}_${token}_${ownerId || 0}_${warehouseId || 0}` });
  if (safePage < pages) nav.push({ text: 'بعدی', callback_data: `lp_${safePage + 1}_${token}_${ownerId || 0}_${warehouseId || 0}` });
  const keyboard = [];
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'فیلتر وضعیت', callback_data: 'lf_status' }, { text: 'فیلتر مالک', callback_data: 'lf_owner' }, { text: 'فیلتر انبار', callback_data: 'lf_wh' }]);
  keyboard.push([{ text: 'خروجی PDF', callback_data: 'lpdf' }, { text: 'حذف فیلتر', callback_data: 'lp_1_all_0_0' }]);
  const hint = showLinesHint && safePage === 1 && !status && !ownerId && !warehouseId
    ? '\n\nراهنما: فیلتر وضعیت/مالک/انبار · خروجی PDF'
    : '';
  const payload = { text: `لیست خطوط\n${filterText}\n\n${body}\n\nتعداد: ${total}\nصفحه ${safePage} از ${pages}${hint}`, reply_markup: JSON.stringify({ inline_keyboard: keyboard }) };
  if (messageId) await tg('editMessageText', { chat_id: chatId, message_id: messageId, ...payload });
  else await say(chatId, payload.text, { reply_markup: payload.reply_markup });
}

async function sendReports(q, chatId) {
  const [stats, salesStats, invoiceStats, freshRow, owners, warehouses, admins] = await Promise.all([
    q`SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved,
      COUNT(*) FILTER (WHERE status = 'sold')::int AS sold,
      COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive,
      COUNT(*) FILTER (WHERE status = 'ready_transfer')::int AS ready,
      COUNT(*) FILTER (WHERE special_sale_applied_at IS NOT NULL)::int AS specials,
      COALESCE(SUM(price_toman) FILTER (WHERE status = 'active'), 0)::bigint AS value
    FROM listings`,
    q`SELECT
      COUNT(*)::int AS total_sales,
      COALESCE(SUM(price_toman), 0)::bigint AS total_amount,
      COUNT(*) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days')::int AS sales_7d,
      COALESCE(SUM(price_toman) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days'), 0)::bigint AS amount_7d,
      COUNT(*) FILTER (WHERE sold_at >= NOW() - INTERVAL '30 days')::int AS sales_30d,
      COALESCE(SUM(price_toman) FILTER (WHERE sold_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS amount_30d,
      COUNT(*) FILTER (WHERE special_sale_applied_at IS NOT NULL)::int AS sold_with_special
    FROM listings WHERE status = 'sold'`,
    q`SELECT COUNT(*)::int AS invoiced_count, COALESCE(SUM(final_toman), 0)::bigint AS invoiced_amount
      FROM invoices`,
    q`SELECT COUNT(*)::int AS count FROM listing_history
      WHERE field_name = 'created' AND changed_at >= NOW() - INTERVAL '7 days'`,
    q`SELECT o.name,
      COUNT(l.id) FILTER (WHERE l.status IN ('active','reserved','ready_transfer','inactive'))::int AS open_lines,
      COUNT(l.id) FILTER (WHERE l.status = 'sold')::int AS sold_lines
    FROM owners o LEFT JOIN listings l ON l.owner_id = o.id
    GROUP BY o.id, o.name ORDER BY o.name`,
    q`SELECT w.name, COUNT(l.id)::int AS lines
    FROM warehouses w LEFT JOIN listings l ON l.warehouse_id = w.id AND l.status IN ('active','reserved','ready_transfer','inactive')
    GROUP BY w.id, w.name ORDER BY w.name`,
    q`SELECT changed_by, COUNT(*)::int AS actions, COUNT(*) FILTER (WHERE field_name = 'sale')::int AS sales
    FROM listing_history WHERE changed_by IS NOT NULL GROUP BY changed_by ORDER BY sales DESC, actions DESC LIMIT 8`
  ]);
  const s = stats[0] || {};
  const active = Number(s.active || 0);
  const reserved = Number(s.reserved || 0);
  const sold = Number(s.sold || 0);
  const inactive = Number(s.inactive || 0);
  const ready = Number(s.ready || 0);
  const specials = Number(s.specials || 0);
  const fresh = Number(freshRow[0]?.count || 0);
  const value = Number(s.value || 0);
  const sale = salesStats[0] || {};
  const inv = invoiceStats[0] || {};
  const totalSales = Number(sale.total_sales || 0);
  const totalAmount = Number(sale.total_amount || 0);
  const sales7 = Number(sale.sales_7d || 0);
  const amount7 = Number(sale.amount_7d || 0);
  const sales30 = Number(sale.sales_30d || 0);
  const amount30 = Number(sale.amount_30d || 0);
  const soldSpecial = Number(sale.sold_with_special || 0);
  const invoicedCount = Number(inv.invoiced_count || 0);
  const invoicedAmount = Number(inv.invoiced_amount || 0);
  const text = [
    'گزارش‌ها',
    '',
    `موجود: ${active}`,
    `رزرو شده: ${reserved}`,
    `آماده انتقال: ${ready}`,
    `فروخته‌شده: ${sold}`,
    `غیرفعال: ${inactive}`,
    `ثبت جدید ۷ روز: ${fresh}`,
    `خطوط با فروش ویژه (فعال/گذشته): ${specials}`,
    `ارزش موجودی فعال: ${money(value)} تومان`,
    '',
    'آمار فروش (قیمت خط هنگام فروش)',
    `کل: ${totalSales} فروش · ${money(totalAmount)} تومان`,
    `۷ روز اخیر: ${sales7} فروش · ${money(amount7)} تومان`,
    `۳۰ روز اخیر: ${sales30} فروش · ${money(amount30)} تومان`,
    `فروش با تخفیف ویژه: ${soldSpecial} خط`,
    invoicedCount
      ? `فاکتور صادرشده: ${invoicedCount} · ${money(invoicedAmount)} تومان (مبلغ نهایی فاکتور)`
      : 'فاکتور صادرشده: —',
    '',
    'مالک‌ها',
    owners.map((row) => `${row.name}: باز ${row.open_lines} / فروخته ${row.sold_lines}`).join('\n') || '-',
    '',
    'انبارها',
    warehouses.map((row) => `${row.name}: ${row.lines}`).join('\n') || '-',
    '',
    'عملکرد ادمین‌ها',
    admins.map((row) => `${row.changed_by}: فروش ${row.sales} / رویداد ${row.actions}`).join('\n') || '-',
    '',
    'راهنما: «موجود» برای آگهی کانال · «رزرو شده» خطوط در حال مذاکره · «فروخته‌شده» برای فاکتور'
  ].join('\n');
  await say(chatId, text);
}

async function sendPartners(q, chatId) {
  const rows = await q`SELECT telegram_user_id, display_name, active FROM partners ORDER BY active DESC, display_name NULLS LAST`;
  const lines = rows.length ? rows.map((row, index) => `${index + 1}. ${row.display_name || row.telegram_user_id} — ${row.active ? 'فعال' : 'غیرفعال'}`).join('\n') : 'هنوز همکاری ثبت نشده است.';
  await say(chatId, `همکاران\n\n${lines}\n\n/addpartner ID نام\n/removepartner ID\n/togglepartner ID`);
}

async function sendListingsExcelTemplate(chatId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', [
    'قالب ورود خطوط (Excel)',
    '',
    'برگه «خطوط» را پر کنید و فایل .xlsx را برای ربات بفرستید.',
    'ستون‌های الزامی: سیم‌کارت، قیمت (تومان)',
    'اختیاری: وضعیت، توضیحات، مالک، انبار، تاریخ سند'
  ].join('\n'));
  form.append(
    'document',
    new Blob([buildListingsExcelTemplateBuffer()], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    'قالب-ورود-خطوط.xlsx'
  );
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const result = await response.json();
  if (!result?.ok) await say(chatId, 'ارسال قالب ناموفق بود. دوباره /excel را بزنید.');
}

function isExcelDocument(document) {
  if (!document) return false;
  const name = String(document.file_name || '').toLowerCase();
  if (name.endsWith('.xlsx')) return true;
  return document.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function excelResumeKey(uid, fileUniqueId) {
  return `excel_resume:${uid}:${fileUniqueId || 'file'}`;
}

async function syncExcel(q, request, message, actor) {
  const chatId = message.chat.id;
  const file = await tg('getFile', { file_id: message.document.file_id });
  if (!file?.ok) { await say(chatId, 'دریافت فایل از تلگرام ناموفق بود.'); return; }
  const binary = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.result.file_path}`);
  let ads;
  try {
    ads = listingAdsFromExcelBuffer(Buffer.from(await binary.arrayBuffer()));
  } catch (error) {
    await say(chatId, `خطا در خواندن Excel: ${error.message || 'فرمت نامعتبر'}`);
    return;
  }
  if (!ads.length) {
    await say(chatId, 'هیچ ردیف معتبری پیدا نشد.\nاز /excel قالب را بگیرید؛ برگه اول باید «خطوط» باشد و ستون‌های سیم‌کارت و قیمت پر شوند.');
    return;
  }
  const resumeKey = excelResumeKey(actor.uid, message.document.file_unique_id);
  const savedIndex = Number(await settingValue(q, resumeKey, '0')) || 0;
  const start = savedIndex > 0 && savedIndex < ads.length ? savedIndex : 0;
  if (!String(process.env.CHANNEL_ID || '').trim()) {
    await say(chatId, 'CHANNEL_ID روی سرور تنظیم نشده؛ خطوط در دیتابیس ثبت می‌شوند ولی در کانال منتشر نمی‌شوند.');
  }
  await say(chatId, start
    ? `ادامهٔ ورود اکسل از ردیف ${start + 1} از ${ads.length}…`
    : `در حال ثبت اکسل (${ads.length} ردیف)…`);
  let created = 0, updated = 0, failed = 0, channelOk = 0, channelMiss = 0;
  const missingOwners = new Set();
  const missingWarehouses = new Set();
  let ownerFull = 0;
  let lastChannelError = '';
  let index = start;
  const deadline = Date.now() + 18_000;
  const origin = publicOrigin(request);
  const installmentConfig = await getInstallmentConfig(q).catch(() => null);
  for (; index < ads.length; index += 1) {
    if (Date.now() >= deadline) break;
    const ad = ads[index];
    try {
      let ownerId;
      let warehouseId;
      if (ad.ownerName) {
        ownerId = await ownerIdByName(q, ad.ownerName);
        if (!ownerId) {
          missingOwners.add(ad.ownerName);
          throw new Error('OWNER_MISSING');
        }
      }
      if (ad.warehouseName) {
        warehouseId = await warehouseIdByName(q, ad.warehouseName);
        if (!warehouseId) {
          missingWarehouses.add(ad.warehouseName);
          throw new Error('WAREHOUSE_MISSING');
        }
      }
      const saved = await saveListing(q, {
        phone: ad.phone,
        displayPhone: ad.displayPhone,
        price: ad.price,
        condition: ad.condition,
        ownerId,
        warehouseId,
        date: ad.documentDate ?? undefined,
        by: actor.uid
      });
      const fresh = await listingById(q, saved.row.id);
      let sent = await syncChannel(q, tg, fresh, origin, installmentConfig);
      const retryAfter = Number(sent?.parameters?.retry_after || 0);
      if (!sent?.ok && retryAfter > 0) {
        const waitMs = Math.min(retryAfter * 1000, Math.max(0, deadline - Date.now() - 500));
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          sent = await syncChannel(q, tg, fresh, origin, installmentConfig);
        }
      }
      const published = sent?.ok || /not modified/i.test(String(sent?.description || ''));
      if (published) channelOk += 1;
      else {
        channelMiss += 1;
        lastChannelError = String(sent?.description || sent?.error_code || 'unknown');
      }
      if (saved.mode === 'create') created += 1; else updated += 1;
    } catch (error) {
      failed += 1;
      if (error?.message === 'OWNER_FULL') ownerFull += 1;
      console.error('excel row failed', ad?.phone, error?.message || error);
    }
  }
  const finished = index >= ads.length;
  if (finished) await q`DELETE FROM settings WHERE key = ${resumeKey}`;
  else await putSetting(q, resumeKey, String(index));
  const ownerHint = missingOwners.size
    ? `مالک پیدا نشد (نام باید دقیقاً مثل /owners باشد؛ یا ستون مالک را خالی بگذارید):\n${[...missingOwners].slice(0, 8).join(' · ')}`
    : '';
  const whHint = missingWarehouses.size
    ? `انبار پیدا نشد (نام باید دقیقاً مثل انبارهای بات باشد؛ یا ستون انبار را خالی بگذارید):\n${[...missingWarehouses].slice(0, 8).join(' · ')}`
    : '';
  const channelHint = channelMiss && lastChannelError
    ? `علت کانال: ${lastChannelError}`
    : '';
  const summary = [
    finished ? 'ورود اکسل تمام شد.' : 'بخشی از اکسل ثبت شد.',
    `این مرحله: ردیف ${start + 1} تا ${Math.max(start + 1, index)} از ${ads.length}`,
    `ثبت جدید: ${created}`,
    `به‌روزرسانی خط باز: ${updated}`,
    `خطا: ${failed}${ownerFull ? ` (شامل ${ownerFull} سقف مالک)` : ''}`,
    `کانال — منتشر/به‌روز: ${channelOk} · منتشر نشد: ${channelMiss}`,
    channelHint,
    ownerHint,
    whHint,
    finished ? '' : 'همین فایل را دوباره بفرستید تا بقیهٔ ردیف‌ها ادامه پیدا کند.'
  ].filter(Boolean).join('\n').slice(0, 3500);
  await say(chatId, summary);
}

async function continueInvoice(q, chatId, uid, draft, text) {
  if (draft.step === 'name') {
    if (text.trim().length < 5) { await say(chatId, 'نام و نام خانوادگی را کامل وارد کنید.'); return true; }
    await q`UPDATE invoice_drafts SET customer_name = ${text.trim()}, step = 'nid', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
    await say(chatId, 'کد ملی ۱۰ رقمی را وارد کنید.');
    return true;
  }
  if (draft.step === 'nid') {
    const nationalId = validNationalId(text);
    if (!nationalId) { await say(chatId, 'کد ملی معتبر نیست.'); return true; }
    const nextStep = draft.customer_phone ? 'address' : 'phone';
    await q`UPDATE invoice_drafts SET national_id = ${nationalId}, step = ${nextStep}, updated_at = NOW() WHERE telegram_user_id = ${uid}`;
    await say(chatId, nextStep === 'address' ? 'آدرس کامل را وارد کنید.' : 'شماره موبایل مشتری را وارد کنید.');
    return true;
  }
  if (draft.step === 'phone') {
    const phone = customerPhone(text);
    if (!phone) { await say(chatId, 'شماره موبایل معتبر نیست.'); return true; }
    await q`UPDATE invoice_drafts SET customer_phone = ${phone}, step = 'address', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
    await say(chatId, 'آدرس کامل را وارد کنید.');
    return true;
  }
  if (draft.step === 'address') {
    if (text.trim().length < 5) { await say(chatId, 'آدرس را کامل‌تر وارد کنید.'); return true; }
    await q`UPDATE invoice_drafts SET address = ${text.trim()}, step = 'birth', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
    await say(chatId, 'تاریخ تولد را وارد کنید. مثال: 1370/01/15');
    return true;
  }
  if (draft.step === 'birth') {
    const date = parseDateInput(text);
    if (!date) { await say(chatId, 'تاریخ تولد نامعتبر است.'); return true; }
    const row = (await q`UPDATE invoice_drafts SET birth_date = ${date}, updated_at = NOW() WHERE telegram_user_id = ${uid} RETURNING *`)[0];
    if (row?.sale_type === 'cash') {
      await q`UPDATE invoice_drafts SET step = 'confirm', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
      await showInvoiceConfirm(q, chatId, uid);
      return true;
    }
    if (row?.sale_type === 'installment' && row.months && row.cash_percent != null) {
      await q`UPDATE invoice_drafts SET step = 'confirm', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
      await showInvoiceConfirm(q, chatId, uid);
      return true;
    }
    await q`UPDATE invoice_drafts SET step = 'type', updated_at = NOW() WHERE telegram_user_id = ${uid}`;
    const listingId = row?.listing_id;
    const cashCb = listingId ? `invoice_type_cash_${listingId}` : 'invoice_type_cash';
    const instCb = listingId ? `invoice_type_installment_${listingId}` : 'invoice_type_installment';
    await say(chatId, 'نوع فروش را انتخاب کنید:', markup({ inline_keyboard: [[{ text: 'نقدی', callback_data: cashCb }, { text: 'اقساطی', callback_data: instCb }]] }));
    return true;
  }
  if (draft.step === 'confirm') {
    await showInvoiceConfirm(q, chatId, uid);
    return true;
  }
  await say(chatId, 'از دکمه‌های پیام قبلی استفاده کنید یا /cancel را بزنید.');
  return true;
}

async function fetchInvoicesForCustomer(q, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const phone = customerPhone(trimmed) || normalizePhone(trimmed)?.digits;
  const nationalId = validNationalId(trimmed);
  if (nationalId) {
    return q`SELECT i.id, i.invoice_number, i.customer_name, i.national_id, i.customer_phone, i.final_toman, i.sale_type, i.created_at,
      l.phone_number, l.phone_display
      FROM invoices i LEFT JOIN listings l ON l.id = i.listing_id
      WHERE i.national_id = ${nationalId}
      ORDER BY i.created_at DESC LIMIT 50`;
  }
  if (phone) {
    return q`SELECT i.id, i.invoice_number, i.customer_name, i.national_id, i.customer_phone, i.final_toman, i.sale_type, i.created_at,
      l.phone_number, l.phone_display
      FROM invoices i LEFT JOIN listings l ON l.id = i.listing_id
      WHERE i.customer_phone = ${phone} OR i.customer_phone = ${trimmed}
      ORDER BY i.created_at DESC LIMIT 50`;
  }
  const one = (await q`SELECT national_id, customer_phone FROM invoices WHERE invoice_number = ${trimmed} LIMIT 1`)[0];
  if (!one) {
    return q`SELECT i.id, i.invoice_number, i.customer_name, i.national_id, i.customer_phone, i.final_toman, i.sale_type, i.created_at,
      l.phone_number, l.phone_display
      FROM invoices i LEFT JOIN listings l ON l.id = i.listing_id
      WHERE i.invoice_number = ${trimmed}
      ORDER BY i.created_at DESC LIMIT 1`;
  }
  return q`SELECT i.id, i.invoice_number, i.customer_name, i.national_id, i.customer_phone, i.final_toman, i.sale_type, i.created_at,
    l.phone_number, l.phone_display
    FROM invoices i LEFT JOIN listings l ON l.id = i.listing_id
    WHERE (i.national_id IS NOT NULL AND i.national_id = ${one.national_id})
      OR (i.customer_phone IS NOT NULL AND i.customer_phone = ${one.customer_phone})
    ORDER BY i.created_at DESC LIMIT 50`;
}

async function sendCustomerPurchaseHistory(q, chatId, query) {
  const rows = await fetchInvoicesForCustomer(q, query);
  if (!rows.length) { await say(chatId, 'سوابق خریدی برای این مشتری پیدا نشد.'); return; }
  const head = rows[0];
  const body = rows.map((row, index) => {
    const sim = formatPhoneDisplay(row.phone_number, row.phone_display);
    const kind = row.sale_type === 'installment' ? 'اقساطی' : 'نقدی';
    return `${index + 1}. ${row.invoice_number} — ${sim} — ${kind} — ${money(row.final_toman)} ت — ${displayJalali(row.created_at)}`;
  }).join('\n');
  const keyboard = rows.slice(0, 10).map((row) => [{ text: `PDF ${row.invoice_number}`, callback_data: `invpdf_${row.id}` }]);
  await say(chatId, [
    'سوابق خرید مشتری',
    '',
    `نام: ${head.customer_name || '-'}`,
    `کد ملی: ${head.national_id || '-'}`,
    `موبایل: ${head.customer_phone ? formatPhoneDisplay(head.customer_phone) : '-'}`,
    `تعداد خرید: ${rows.length}`,
    '',
    body
  ].join('\n'), markup({ inline_keyboard: keyboard }));
}

async function sendInvoiceList(q, chatId, query) {
  let rows;
  if (!query) {
    rows = await q`SELECT id, invoice_number, customer_name, national_id, customer_phone, final_toman, created_at FROM invoices ORDER BY id DESC LIMIT 10`;
  } else {
    rows = await fetchInvoicesForCustomer(q, query);
    if (rows.length > 1) {
      await sendCustomerPurchaseHistory(q, chatId, query);
      return;
    }
    if (rows.length === 1) {
      rows = rows.map(({ id, invoice_number, customer_name, national_id, customer_phone, final_toman, created_at }) =>
        ({ id, invoice_number, customer_name, national_id, customer_phone, final_toman, created_at }));
    }
  }
  if (!rows.length) { await say(chatId, 'فاکتوری پیدا نشد.'); return; }
  const lines = rows.map((row) => `${row.invoice_number} — ${row.customer_name} — ${money(row.final_toman)} تومان — ${displayJalali(row.created_at)}`).join('\n');
  const keyboard = rows.slice(0, 8).map((row) => [{ text: `PDF ${row.invoice_number}`, callback_data: `invpdf_${row.id}` }]);
  const hint = query && rows[0]?.national_id ? '\n\nبرای همهٔ خریدهای این مشتری: /customer ' + rows[0].national_id : '';
  await say(chatId, `فاکتورها\n\n${lines}${hint}`, markup({ inline_keyboard: keyboard }));
}

async function handleCallback(q, request, callback) {
  const uid = callback.from?.id;
  const data = String(callback.data || '');
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const actor = await actorOf(q, uid);
  if (!actor.isStaff) { await deny(chatId, callback); return; }
  if (data === 'staff_guide') {
    await sendStaffGuide(chatId, actor);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: callback.id, text });
  const needs = async (key) => {
    if (actor.allow(key)) return true;
    await deny(chatId, callback);
    return false;
  };

  const registration = data.match(/^(regowner|regwh|regdate)_(\d+)(?:_(\d+|default))?$/);
  if (registration) {
    if (!await needs('add_listing')) return;
    await handleRegistrationCallback(q, request, callback, actor, registration);
    return;
  }
  if (data.startsWith('owner_') || data === 'owners_back') {
    if (!actor.isOwner) { await deny(chatId, callback); return; }
    await handleOwnerCallback(q, callback, actor, data);
    return;
  }
  if (data.startsWith('olp_') || data.startsWith('rsv_')) {
    if (!await needs('lookup')) return;
    await handleOpenLinesCallback(q, request, callback, actor, data);
    return;
  }
  if (data.startsWith('lookup_') || data === 'lookup_back') {
    if (data.includes('history')) { if (!await needs('history')) return; }
    else if (!await needs('lookup')) return;
    await handleLookupCallback(q, request, callback, actor, data);
    return;
  }
  const whLines = data.match(/^wh_lines_(\d+)$/);
  if (whLines) {
    if (!canViewWarehouses(actor)) { await deny(chatId, callback); return; }
    const warehouseId = Number(whLines[1]) || null;
    await sendLines(q, chatId, actor, 1, { warehouseId }, messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'wh_add') {
    if (!actor.isOwner) { await deny(chatId, callback); return; }
    await q`INSERT INTO owner_action_sessions(telegram_user_id, action, owner_id) VALUES(${actor.uid}, 'warehouse_add', NULL)
      ON CONFLICT(telegram_user_id) DO UPDATE SET action = 'warehouse_add', owner_id = NULL, created_at = NOW()`;
    await say(chatId, 'افزودن انبار\n\nنام انبار را در پیام بعدی بفرستید.\n/cancel = انصراف');
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'wh_add_listing') {
    if (!await needs('add_listing')) return;
    await say(chatId, [
      'ثبت سیم‌کارت — مرحله ۱ از ۴',
      '',
      'شماره 0912 را بفرستید (با یا بدون فاصله)،',
      'یا ۳ خط: شماره / قیمت میلیون / وضعیت',
      '',
      '/cancel = لغو'
    ].join('\n'));
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data.startsWith('lp_') || data.startsWith('lf_') || data.startsWith('lset_') || data === 'lpdf' || data.startsWith('lines_page_')) {
    if (!await needs('lines')) return;
    await handleLinesCallback(q, callback, actor, data);
    return;
  }
  if (data.startsWith('invoice_') || data.startsWith('invpdf_')) {
    if (!await needs('invoices')) return;
    await handleInvoiceCallback(q, callback, actor, data);
    return;
  }
  if (data.startsWith('priceup_') || data === 'manage_price_up') {
    if (!(actor.isOwner || actor.allow('settings'))) { await deny(chatId, callback); return; }
    await handlePriceUpCallback(q, request, callback, actor, data === 'manage_price_up' ? 'manage_price_up' : data);
    return;
  }
  if (data.startsWith('chanmsg_') || data === 'manage_channel_msgs') {
    if (!canEditChannelMessages(actor)) { await deny(chatId, callback); return; }
    await handleChannelMsgCallback(q, callback, actor, data);
    return;
  }
  if (data.startsWith('manage_') || data.startsWith('perm_') || data.startsWith('admin_')) {
    const adminKey = isSettingsManageCallback(data) ? 'settings' : 'admin_management';
    if (!(actor.isOwner || actor.allow(adminKey) || (data === 'manage_back' && (actor.allow('settings') || actor.allow('admin_management'))))) { await deny(chatId, callback); return; }
    await handleAdminCallback(q, request, callback, actor, data);
    return;
  }
  if (data.startsWith('docdone_') || data.startsWith('docdelay_')) {
    const id = Number(data.split('_')[1]);
    if (data.startsWith('docdone_')) {
      await q`UPDATE listings SET sale_document_status = 'done', sale_document_completed_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
      await answer('سند ثبت شد.');
    } else {
      await q`UPDATE listings SET sale_document_cycle = COALESCE(sale_document_cycle, 0) + 1, sale_document_due_date = COALESCE(sale_document_due_date, CURRENT_DATE) + INTERVAL '7 days', sale_document_last_reminded_at = NULL, updated_at = NOW() WHERE id = ${id}`;
      await answer('موعد سند ۷ روز عقب رفت.');
    }
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [] }) });
    return;
  }
  const prAction = data.match(/^pr_(lookup|sell|invoice)_(\d+)$/);
  if (prAction) {
    if (prAction[1] === 'invoice') { if (!await needs('invoices')) return; }
    else if (!await needs('lookup')) return;
    await handlePurchaseRequestAction(q, request, callback, actor, prAction[1], Number(prAction[2]));
    return;
  }
  const claim = data.match(/^(claim|handoff)_(\d+)$/);
  if (!claim) { await answer('عملیات نامعتبر'); return; }
  await handleClaim(q, callback, actor, claim[1], Number(claim[2]));
}

async function handleRegistrationCallback(q, request, callback, actor, match) {
  const [, kind, sid, value] = match;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (String(actor.uid) !== String(sid)) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این ثبت متعلق به شما نیست.' }); return; }
  const session = (await q`SELECT * FROM listing_registration_sessions WHERE telegram_user_id = ${sid} LIMIT 1`)[0];
  if (!session) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این ثبت قبلاً انجام شده است.' }); return; }
  if (kind === 'regowner') {
    const choices = await ownerChoices(q, { phone: session.phone_number });
    if (!choices.some((owner) => String(owner.id) === String(value))) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ظرفیت این مالک تکمیل است.' }); return; }
    await q`UPDATE listing_registration_sessions SET owner_id = ${Number(value)} WHERE telegram_user_id = ${sid}`;
    const warehouses = await warehousesWithStock(q);
    const active = warehouses.filter((warehouse) => warehouse.active);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: 'ثبت — مرحله ۳ از ۴\n\nانبار را انتخاب کنید (تعداد = خطوط باز در انبار):',
      reply_markup: JSON.stringify({
        inline_keyboard: active.map((warehouse) => [{
          text: `${warehouse.name} — ${Number(warehouse.open_lines || 0)} خط`,
          callback_data: `regwh_${sid}_${warehouse.id}`
        }])
      })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'مالک ثبت شد.' });
    return;
  }
  if (kind === 'regwh') {
    await q`UPDATE listing_registration_sessions SET warehouse_id = ${Number(value)} WHERE telegram_user_id = ${sid}`;
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'ثبت — مرحله ۴ از ۴\n\nتاریخ آماده سند را بفرستید (مثال 1405/07/25)\nیا دکمه پیش‌فرض را بزنید:', reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'پیش‌فرض: ۲۰ روز بعد', callback_data: `regdate_${sid}_default` }]] }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'انبار ثبت شد.' });
    return;
  }
  const date = value === 'default' ? plusDaysISO(20) : parseDateInput(value);
  if (!date || !session.owner_id || !session.warehouse_id) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'اطلاعات ثبت کامل نیست.' }); return; }
  await finishRegistration(q, request, chatId, actor.uid, session, date);
  await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ثبت انجام شد.' });
}

async function handleOwnerCallback(q, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (data === 'owner_add') {
    await q`INSERT INTO owner_action_sessions(telegram_user_id, action, owner_id) VALUES(${actor.uid}, 'add', NULL)
      ON CONFLICT(telegram_user_id) DO UPDATE SET action = 'add', owner_id = NULL, created_at = NOW()`;
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'نام مالک را در پیام بعدی بفرستید.', reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'انصراف', callback_data: 'owners_back' }]] }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'owners_back') { await tg('deleteMessage', { chat_id: chatId, message_id: messageId }); await sendOwners(q, chatId, actor); await tg('answerCallbackQuery', { callback_query_id: callback.id }); return; }
  const manage = data.match(/^owner_manage_(\d+)$/);
  if (manage) {
    const owner = await loadOwnerCard(q, Number(manage[1]));
    if (!owner) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'مالک پیدا نشد.' }); return; }
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: ownerManageText(owner),
      reply_markup: JSON.stringify(ownerManageMarkup(owner))
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const cap = data.match(/^owner_cap_(\d+)_(\d+)$/);
  if (cap) {
    const applied = await applyOwnerCap(q, Number(cap[1]), Number(cap[2]));
    if (!applied.ok) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: applied.error }); return; }
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: ownerManageText(applied.owner),
      reply_markup: JSON.stringify(ownerManageMarkup(applied.owner))
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: `سقف شد ${applied.owner.max_line_slots}` });
    return;
  }
  const toggle = data.match(/^owner_toggle_(\d+)$/);
  if (toggle) { await q`UPDATE owners SET active = NOT active, updated_at = NOW() WHERE id = ${Number(toggle[1])}`; await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'وضعیت مالک تغییر کرد.' }); return; }
  const limit = data.match(/^owner_limit_(\d+)$/);
  if (limit) {
    const owner = await loadOwnerCard(q, Number(limit[1]));
    await q`INSERT INTO owner_action_sessions(telegram_user_id, action, owner_id) VALUES(${actor.uid}, 'limit', ${Number(limit[1])})
      ON CONFLICT(telegram_user_id) DO UPDATE SET action = 'limit', owner_id = EXCLUDED.owner_id, created_at = NOW()`;
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `سقف جدید «${owner?.name || 'مالک'}» را بفرستید.\nالان: ${Number(owner?.used || 0)} از ${Number(owner?.max_line_slots ?? 10)}\nمثال: 25\n/cancel = انصراف`
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const lines = data.match(/^owner_lines_(\d+)_(\d+)$/);
  if (lines) {
    const ownerId = Number(lines[1]);
    const page = Math.max(1, Number(lines[2]));
    const total = await ownerUsage(q, ownerId);
    const slice = await q`SELECT phone_display, phone_number, status FROM listings WHERE owner_id = ${ownerId} AND status IN ('active','reserved','ready_transfer','inactive') ORDER BY id DESC LIMIT 15 OFFSET ${(page - 1) * 15}`;
    const body = slice.map((row, index) => `${(page - 1) * 15 + index + 1}. ${formatPhoneDisplay(row.phone_number, row.phone_display)} — ${statusLabel(row.status)}`).join('\n') || 'خط بازی به نام این مالک نیست.';
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `خطوط باز\n\n${body}\n\n${capacityLabel(total, (await q`SELECT max_line_slots FROM owners WHERE id = ${ownerId}`)[0]?.max_line_slots)}` });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
  }
}

async function handleOpenLinesCallback(q, request, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const page = data.match(/^olp_page_(\d+)_([art]|all)$/);
  if (page) {
    await sendOpenLinesPanel(q, chatId, actor, Number(page[1]), page[2], messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const legacyPage = data.match(/^rsv_page_(\d+)$/);
  if (legacyPage) {
    await sendOpenLinesPanel(q, chatId, actor, Number(legacyPage[1]), 'r', messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const pick = data.match(/^olp_pick_(\d+)_(\d+)_([art]|all)$/);
  if (pick) {
    const listing = await listingById(q, Number(pick[1]));
    if (!listing || !['active', 'reserved', 'ready_transfer'].includes(String(listing.status))) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این خط دیگر در لیست نیست.' });
      return;
    }
    await sendOpenLineActionsMenu(q, chatId, actor, listing, Number(pick[2]), pick[3], messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: `خط ${pick[1]}` });
    return;
  }
  const open = data.match(/^olp_open_(\d+)$/) || data.match(/^rsv_open_(\d+)$/);
  if (open) {
    const listing = await listingById(q, Number(open[1]));
    if (!listing || !['active', 'reserved', 'ready_transfer'].includes(String(listing.status))) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این خط دیگر در لیست موجود نیست.' });
      return;
    }
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'مدیریت خط' });
    await presentLookup(q, chatId, actor, listing);
    return;
  }
  const act = data.match(/^olp_act_(\d+)_(reserve|release|deliver|sell)$/);
  if (act) {
    const lookupAction = act[2] === 'deliver' ? 'deliver' : act[2] === 'sell' ? 'sell' : act[2];
    await handleLookupCallback(q, request, callback, actor, `lookup_${lookupAction}_${act[1]}`);
    return;
  }
  const deliver = data.match(/^rsv_deliver_(\d+)$/);
  if (deliver) {
    await handleLookupCallback(q, request, callback, actor, `lookup_deliver_${deliver[1]}`);
  }
}

async function beginReservedDeliverConfirm(q, callback, actor, listing) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const id = listing.id;
  if (listing.status !== 'reserved') {
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فقط برای خط رزرو شده.' });
    return;
  }
  if (!actor.isOwner && listing.reserved_by != null && Number(listing.reserved_by) !== Number(actor.uid)) {
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این رزرو برای ادمین دیگری است.' });
    return;
  }
  await tg('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId,
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [{ text: 'تأیید تحویل / فروش', callback_data: `lookup_sellok_${id}` }],
        [{ text: 'انصراف', callback_data: `lookup_refresh_${id}` }]
      ]
    })
  });
  await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'تحویل به مشتری را تأیید کنید.' });
}

async function handleLookupCallback(q, request, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (data === 'lookup_back') {
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [] }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'بسته شد' });
    return;
  }
  const action = data.match(/^lookup_(reserve|release|sell|sellok|deliver|status|owner|warehouse|date|history|refresh|discount|cleardiscount)_(\d+)$/);
  const setStatus = data.match(/^lookup_setstatus_(\d+)_(active|reserved|sold|inactive)$/);
  const setOwner = data.match(/^lookup_setowner_(\d+)_(\d+)$/);
  const setWarehouse = data.match(/^lookup_setwarehouse_(\d+)_(\d+)$/);
  if (action) {
    const [, name, idRaw] = action;
    const id = Number(idRaw);
    const listing = await listingById(q, id);
    if (!listing) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'سیم‌کارت پیدا نشد.' }); return; }
    if (name === 'reserve') {
      const reserved = await reserveListing(q, id, actor.uid);
      if (!reserved) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فقط خط موجود قابل رزرو است.' }); return; }
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'برای یک ساعت رزرو شد.' });
      let fresh = await syncListingChannel(q, request, id);
      fresh = await postReserveNotice(q, tg, fresh);
      await presentLookup(q, chatId, actor, fresh);
      return;
    }
    if (name === 'release') {
      const current = await listingById(q, id);
      const released = await releaseListing(q, id, actor.uid, { isOwner: actor.isOwner });
      if (released?.denied) {
        await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فقط رزروکننده یا مالک ربات می‌تواند رزرو را آزاد کند.' });
        return;
      }
      if (!released) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'رزرو فعالی نیست.' }); return; }
      await clearReserveNotice(q, tg, current);
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'رزرو آزاد شد.' });
      const fresh = await syncListingChannel(q, request, id);
      await presentLookup(q, chatId, actor, fresh);
      return;
    }
    if (name === 'deliver') {
      await beginReservedDeliverConfirm(q, callback, actor, listing);
      return;
    }
    if (name === 'sell') {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'تأیید فروش', callback_data: `lookup_sellok_${id}` }], [{ text: 'انصراف', callback_data: `lookup_refresh_${id}` }]] }) });
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فروش را تأیید کنید.' });
      return;
    }
    if (name === 'sellok') {
      const current = await listingById(q, id);
      const sold = await sellListing(q, id, actor.uid);
      if (!sold) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این خط قابل فروش نیست.' }); return; }
      if (current?.status === 'reserved') await clearReserveNotice(q, tg, current);
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فروش ثبت شد.' });
      const fresh = await syncListingChannel(q, request, id);
      await announceSold(q, tg, { ...(fresh || sold), channel_chat_id: current.channel_chat_id, channel_message_id: current.channel_message_id });
      await presentLookup(q, chatId, actor, fresh, {
        suffix: '\n\nپاسخ «فروخته شد» روی آگهی کانال ثبت شد و ۴۸ ساعت بعد پاک می‌شود.',
        withFooter: false
      });
      return;
    }
    if (name === 'status') {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [
        [{ text: 'موجود', callback_data: `lookup_setstatus_${id}_active` }, { text: 'رزرو شده', callback_data: `lookup_setstatus_${id}_reserved` }],
        [{ text: 'فروخته شده', callback_data: `lookup_setstatus_${id}_sold` }, { text: 'غیرفعال', callback_data: `lookup_setstatus_${id}_inactive` }],
        [{ text: 'بازگشت', callback_data: `lookup_refresh_${id}` }]
      ] }) });
      await tg('answerCallbackQuery', { callback_query_id: callback.id });
      return;
    }
    if (name === 'owner' || name === 'warehouse') {
      const prefix = name === 'owner' ? 'lookup_setowner' : 'lookup_setwarehouse';
      const buttons = [];
      if (name === 'owner') {
        const owners = await activeOwnersWithUsage(q);
        for (const row of owners) {
          const already = String(listing.owner_id || '') === String(row.id);
          if (!canAssignOwner({ used: row.used, max: row.max_line_slots, alreadyOnThisOwner: already })) continue;
          buttons.push([{ text: `${row.name} — ${capacityLabel(row.used, row.max_line_slots)}`, callback_data: `${prefix}_${id}_${row.id}` }]);
        }
      } else {
        const rows = await q`SELECT id, name FROM warehouses WHERE active = true ORDER BY name`;
        for (const row of rows) buttons.push([{ text: row.name, callback_data: `${prefix}_${id}_${row.id}` }]);
      }
      buttons.push([{ text: 'بازگشت', callback_data: `lookup_refresh_${id}` }]);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
      await tg('answerCallbackQuery', { callback_query_id: callback.id });
      return;
    }
    if (name === 'date') {
      await q`INSERT INTO listing_edit_sessions(telegram_user_id, listing_id, action) VALUES(${actor.uid}, ${id}, 'date')
        ON CONFLICT(telegram_user_id) DO UPDATE SET listing_id = EXCLUDED.listing_id, action = 'date', created_at = NOW()`;
      await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'تاریخ آماده سند جدید را وارد کنید.\nمثال: 1405/07/25' });
      await tg('answerCallbackQuery', { callback_query_id: callback.id });
      return;
    }
    if (name === 'discount') {
      if (!canManualDiscount(actor)) { await deny(chatId, callback); return; }
      if (!['active', 'reserved', 'ready_transfer'].includes(listing.status)) {
        await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فقط برای خط موجود/رزرو/آماده انتقال.' });
        return;
      }
      const listPrice = listingListPriceToman(listing);
      await q`INSERT INTO listing_edit_sessions(telegram_user_id, listing_id, action) VALUES(${actor.uid}, ${id}, 'discount')
        ON CONFLICT(telegram_user_id) DO UPDATE SET listing_id = EXCLUDED.listing_id, action = 'discount', created_at = NOW()`;
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: [
          'تخفیف دستی',
          formatPhoneDisplay(listing.phone_number, listing.phone_display),
          `قیمت مبنا: ${money(listPrice)} تومان`,
          '',
          'یکی را بفرستید:',
          '• درصد: 5 یا 5%',
          '• کسر میلیون: -20',
          '• قیمت نهایی میلیون: 550',
          '',
          '/cancel برای انصراف'
        ].join('\n')
      });
      await tg('answerCallbackQuery', { callback_query_id: callback.id });
      return;
    }
    if (name === 'cleardiscount') {
      if (!canManualDiscount(actor)) { await deny(chatId, callback); return; }
      const result = await clearManualListingDiscount(q, id, actor.uid);
      if (!result.ok) {
        await tg('answerCallbackQuery', { callback_query_id: callback.id, text: result.reason === 'NONE' ? 'تخفیفی روی این خط نیست.' : 'خطا.' });
        return;
      }
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'تخفیف حذف شد.' });
      const fresh = await syncListingChannel(q, request, id);
      await presentLookup(q, chatId, actor, fresh);
      return;
    }
    if (name === 'history') { await sendHistory(q, chatId, listing.phone_number); await tg('answerCallbackQuery', { callback_query_id: callback.id }); return; }
    if (name === 'refresh') { await presentLookup(q, chatId, actor, listing); await tg('answerCallbackQuery', { callback_query_id: callback.id }); }
    return;
  }
  if (setStatus) {
    const id = Number(setStatus[1]);
    const next = setStatus[2];
    if (next === 'reserved') { await handleLookupCallback(q, request, { ...callback, data: `lookup_reserve_${id}` }, actor, `lookup_reserve_${id}`); return; }
    if (next === 'sold') { await handleLookupCallback(q, request, { ...callback, data: `lookup_sellok_${id}` }, actor, `lookup_sellok_${id}`); return; }
    if (next === 'active') {
      const current = await listingById(q, id);
      if (current?.status === 'reserved') { await handleLookupCallback(q, request, { ...callback, data: `lookup_release_${id}` }, actor, `lookup_release_${id}`); return; }
    }
    const current = (await q`SELECT status FROM listings WHERE id = ${id}`)[0];
    await q`UPDATE listings SET status = ${next}, updated_at = NOW() WHERE id = ${id}`;
    await logChange(q, { listingId: id, field: 'status', from: current?.status, to: next, by: actor.uid });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'وضعیت تغییر کرد.' });
    await syncListingChannel(q, request, id);
    return;
  }
  if (setOwner || setWarehouse) {
    const listingId = Number((setOwner || setWarehouse)[1]);
    const valueId = Number((setOwner || setWarehouse)[2]);
    const column = setOwner ? 'owner_id' : 'warehouse_id';
    const current = (await q`SELECT owner_id, warehouse_id, status FROM listings WHERE id = ${listingId}`)[0];
    if (setOwner) {
      const used = await ownerUsage(q, valueId);
      const owner = (await q`SELECT max_line_slots FROM owners WHERE id = ${valueId}`)[0];
      const already = String(current?.owner_id || '') === String(valueId);
      if (!canAssignOwner({ used, max: owner?.max_line_slots, alreadyOnThisOwner: already })) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ظرفیت مالک تکمیل است.' }); return; }
    }
    if (column === 'owner_id') await q`UPDATE listings SET owner_id = ${valueId}, updated_at = NOW() WHERE id = ${listingId}`;
    else await q`UPDATE listings SET warehouse_id = ${valueId}, updated_at = NOW() WHERE id = ${listingId}`;
    await logChange(q, { listingId, field: column, from: current?.[column], to: valueId, by: actor.uid });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: column === 'owner_id' ? 'مالک تغییر کرد.' : 'انبار تغییر کرد.' });
    const fresh = await listingById(q, listingId);
    await presentLookup(q, chatId, actor, fresh);
  }
}

async function handleLinesCallback(q, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const session = (await q`SELECT * FROM line_list_sessions WHERE telegram_user_id = ${actor.uid}`)[0] || {};
  if (data === 'lpdf') {
    const rows = await q`SELECT l.phone_display, l.phone_number, l.price_toman, l.status, o.name AS owner_name, w.name AS warehouse_name
      FROM listings l LEFT JOIN owners o ON o.id = l.owner_id LEFT JOIN warehouses w ON w.id = l.warehouse_id
      WHERE (${session.status || null}::text IS NULL OR l.status = ${session.status || null})
        AND (${session.owner_id || null}::bigint IS NULL OR l.owner_id = ${session.owner_id || null})
        AND (${session.warehouse_id || null}::bigint IS NULL OR l.warehouse_id = ${session.warehouse_id || null})
      ORDER BY CASE WHEN l.prefix_code = 0 THEN 10 WHEN l.prefix_code BETWEEN 1 AND 9 THEN l.prefix_code ELSE 11 END, l.id DESC
      LIMIT 500`;
    const { linesPdf } = await import('../invoice/pdf.js');
    const pdf = await linesPdf(rows, `وضعیت ${session.status || 'همه'} / مالک ${session.owner_id || 'همه'} / انبار ${session.warehouse_id || 'همه'}`);
    await sendPdf(chatId, 'lines.pdf', pdf.toString('base64'), 'لیست خطوط');
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'PDF ارسال شد.' });
    return;
  }
  if (data === 'lf_status') {
    const buttons = [['همه', 'all'], ['موجود', 'a'], ['رزرو', 'r'], ['فروخته', 's'], ['غیرفعال', 'i'], ['آماده انتقال', 't']]
      .map(([label, token]) => [{ text: label, callback_data: `lp_1_${token}_${session.owner_id || 0}_${session.warehouse_id || 0}` }]);
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'lf_owner' || data === 'lf_wh') {
    const rows = data === 'lf_owner' ? await q`SELECT id, name FROM owners WHERE active = true ORDER BY name` : await q`SELECT id, name FROM warehouses WHERE active = true ORDER BY name`;
    const prefix = data === 'lf_owner' ? 'o' : 'w';
    const buttons = rows.slice(0, 20).map((row) => [{ text: row.name, callback_data: `lset_${prefix}_${row.id}` }]);
    buttons.push([{ text: 'همه', callback_data: `lset_${prefix}_0` }]);
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const setFilter = data.match(/^lset_([ow])_(\d+)$/);
  if (setFilter) {
    const ownerId = setFilter[1] === 'o' ? Number(setFilter[2]) || null : session.owner_id || null;
    const warehouseId = setFilter[1] === 'w' ? Number(setFilter[2]) || null : session.warehouse_id || null;
    await sendLines(q, chatId, actor, 1, { status: session.status, ownerId, warehouseId }, messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const page = data.match(/^lp_(\d+)_(all|a|r|s|i|t)_(\d+)_(\d+)$/) || data.match(/^lines_page_(\d+)$/);
  if (page) {
    const filter = page.length === 5 ? { status: STATUS_BY_TOKEN[page[2]] || null, ownerId: Number(page[3]) || null, warehouseId: Number(page[4]) || null } : { status: session.status, ownerId: session.owner_id, warehouseId: session.warehouse_id };
    await sendLines(q, chatId, actor, Number(page[1]), filter, data.startsWith('lines_page_') ? null : messageId);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
  }
}

function installmentMonthKeyboard(months) {
  const buttons = months.map((month) => ({ text: `${month} ماه`, callback_data: `invoice_month_${month}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return rows;
}

function installmentPercentKeyboard(percents) {
  const buttons = percents.map((percent) => ({ text: `${percent}%`, callback_data: `invoice_pct_${percent}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return rows;
}

async function handleInvoiceCallback(q, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const actorUid = invoiceActorUid(callback, actor);
  const inst = await getInstallmentConfig(q);
  const start = data.match(/^invoice_start_(\d+)$/);
  if (start) {
    const listing = await listingById(q, Number(start[1]));
    if (!listing || listing.status !== 'sold') { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فاکتور فقط برای خط فروخته‌شده صادر می‌شود.' }); return; }
    const existing = (await q`SELECT * FROM invoices WHERE listing_id = ${listing.id} LIMIT 1`)[0];
    if (existing?.pdf_base64) {
      await sendPdf(chatId, invoicePdfFilename(existing), existing.pdf_base64, `فاکتور ${existing.invoice_number}`);
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فاکتور قبلی ارسال شد.' });
      return;
    }
    await q`INSERT INTO invoice_drafts(telegram_user_id, listing_id, step) VALUES(${actorUid}, ${listing.id}, 'name')
      ON CONFLICT(telegram_user_id) DO UPDATE SET listing_id = EXCLUDED.listing_id, step = 'name', customer_name = NULL, national_id = NULL, customer_phone = NULL, address = NULL, birth_date = NULL, sale_type = NULL, months = NULL, cash_percent = NULL, updated_at = NOW()`;
    await say(chatId, 'نام و نام خانوادگی خریدار را وارد کنید.');
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const typePick = data.match(/^invoice_type_(cash|installment)(?:_(\d+))?$/);
  if (typePick) {
    const saleType = typePick[1] === 'cash' ? 'cash' : 'installment';
    const listingId = typePick[2] ? Number(typePick[2]) : null;
    const updated = listingId
      ? await q`UPDATE invoice_drafts SET sale_type = ${saleType}, step = ${saleType === 'cash' ? 'confirm' : 'months'}, updated_at = NOW()
          WHERE telegram_user_id = ${actorUid} AND listing_id = ${listingId} RETURNING listing_id`
      : await q`UPDATE invoice_drafts SET sale_type = ${saleType}, step = ${saleType === 'cash' ? 'confirm' : 'months'}, updated_at = NOW()
          WHERE telegram_user_id = ${actorUid} RETURNING listing_id`;
    if (!updated[0]) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'پیش‌نویس فاکتور منقضی شده. دوباره از استعلام «صدور فاکتور» را بزنید.' });
      return;
    }
    if (saleType === 'cash') await showInvoiceConfirm(q, chatId, actorUid);
    else await say(chatId, 'مدت اقساط را انتخاب کنید:', markup({ inline_keyboard: installmentMonthKeyboard(inst.monthOptions) }));
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const month = data.match(/^invoice_month_(\d+)$/);
  if (month) {
    await q`UPDATE invoice_drafts SET months = ${Number(month[1])}, step = 'percent', updated_at = NOW() WHERE telegram_user_id = ${actorUid}`;
    await say(chatId, 'درصد پیش‌پرداخت را انتخاب کنید:', markup({ inline_keyboard: installmentPercentKeyboard(inst.percentOptions) }));
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const percent = data.match(/^invoice_pct_(\d+)$/);
  if (percent) {
    await q`UPDATE invoice_drafts SET cash_percent = ${Number(percent[1])}, step = 'confirm', updated_at = NOW() WHERE telegram_user_id = ${actorUid}`;
    await showInvoiceConfirm(q, chatId, actorUid);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const confirm = data.match(/^invoice_confirm(?:_(\d+))?$/);
  if (confirm) {
    await finalizeInvoiceDraft(q, chatId, callback, actor, confirm[1] ? Number(confirm[1]) : null);
    return;
  }
  const pdf = data.match(/^invpdf_(\d+)$/);
  if (pdf) {
    const invoice = (await q`SELECT * FROM invoices WHERE id = ${Number(pdf[1])} LIMIT 1`)[0];
    if (!invoice?.pdf_base64) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'فایل فاکتور پیدا نشد.' }); return; }
    await sendPdf(chatId, invoicePdfFilename(invoice), invoice.pdf_base64, `فاکتور ${invoice.invoice_number}`);
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'PDF ارسال شد.' });
  }
}

async function finalizeInvoiceDraft(q, chatId, callback, actor, listingIdHint) {
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: callback.id, text });
  const actorUid = invoiceActorUid(callback, actor);
  let draft = await fetchInvoiceDraft(q, actorUid, listingIdHint);
  const listingId = draft?.listing_id || listingIdHint;
  let listing = listingId ? await listingById(q, Number(listingId)) : null;
  if (listingId) {
    const existing = (await q`SELECT * FROM invoices WHERE listing_id = ${listingId} LIMIT 1`)[0];
    if (existing?.pdf_base64 && (!draft || !draft.sale_type)) {
      await sendPdf(chatId, invoicePdfFilename(existing), existing.pdf_base64, `فاکتور ${existing.invoice_number}`);
      if (actorUid != null) await q`DELETE FROM invoice_drafts WHERE telegram_user_id = ${actorUid}`;
      await answer('فاکتور قبلی ارسال شد.');
      return;
    }
  }
  if (!draft || !listing) {
    await answer('پیش‌نویس فاکتور پیدا نشد. آخرین پیام «تأیید فاکتور» را بزنید یا از استعلام دوباره «صدور فاکتور» را شروع کنید.');
    return;
  }
  if (!draft.sale_type) {
    await answer('نوع فروش (نقدی/اقساطی) را انتخاب کنید.');
    return;
  }
  try {
    const result = await buildInvoice(q, draft, listing, actorUid);
    if (result.invoice.pdf_base64) {
      await sendPdf(chatId, invoicePdfFilename(result.invoice), result.invoice.pdf_base64, `فاکتور ${result.invoice.invoice_number}`);
    } else {
      await say(chatId, `فاکتور ${result.invoice.invoice_number} ثبت شد ولی فایل PDF ذخیره نشده است.`);
    }
    await q`DELETE FROM invoice_drafts WHERE telegram_user_id = ${actorUid}`;
    await answer(result.created ? 'فاکتور صادر شد.' : 'فاکتور قبلی ارسال شد.');
  } catch (error) {
    console.error('finalizeInvoiceDraft', error);
    const existing = (await q`SELECT * FROM invoices WHERE listing_id = ${listing.id} LIMIT 1`)[0];
    if (existing?.pdf_base64) {
      await sendPdf(chatId, invoicePdfFilename(existing), existing.pdf_base64, `فاکتور ${existing.invoice_number}`);
      await q`DELETE FROM invoice_drafts WHERE telegram_user_id = ${actorUid}`;
      await answer('فاکتور صادر شد.');
      return;
    }
    await answer('خطا در ساخت PDF. دوباره «صدور PDF» را بزنید.');
  }
}

async function showInvoiceConfirm(q, chatId, uid) {
  const row = (await q`SELECT d.*, l.phone_display, l.phone_number, l.price_toman, l.original_price_toman, l.special_sale_applied_at FROM invoice_drafts d JOIN listings l ON l.id = d.listing_id WHERE d.telegram_user_id = ${uid} LIMIT 1`)[0];
  if (!row) { await say(chatId, 'پیش‌نویس پیدا نشد.'); return; }
  if (!row.sale_type) {
    await say(chatId, 'نوع فروش را انتخاب کنید:', markup({ inline_keyboard: [[{ text: 'نقدی', callback_data: `invoice_type_cash_${row.listing_id}` }, { text: 'اقساطی', callback_data: `invoice_type_installment_${row.listing_id}` }]] }));
    return;
  }
  await q`UPDATE invoice_drafts SET step = 'confirm', updated_at = NOW() WHERE telegram_user_id = ${uid} AND listing_id = ${row.listing_id}`;
  const inst = await getInstallmentConfig(q);
  const saleLabel = row.sale_type === 'installment' ? `اقساطی ${row.months} ماه / ${row.cash_percent}%` : 'نقدی';
  const listing = {
    price_toman: row.price_toman,
    original_price_toman: row.original_price_toman,
    special_sale_applied_at: row.special_sale_applied_at
  };
  const priceBlock = invoiceDraftPriceSummary(row, listing, inst);
  await say(chatId, [
    'تأیید فاکتور',
    '',
    row.customer_name,
    row.national_id,
    formatPhoneDisplay(row.customer_phone),
    formatPhoneDisplay(row.phone_number, row.phone_display),
    saleLabel,
    '',
    priceBlock
  ].join('\n'), markup({ inline_keyboard: [[{ text: 'صدور PDF', callback_data: `invoice_confirm_${row.listing_id}` }]] }));
}

function priceUpScopeKeyboard() {
  return [
    [{ text: 'فقط موجود (کانال)', callback_data: 'priceup_scope_active' }],
    [{ text: 'موجود + رزرو + آماده انتقال', callback_data: 'priceup_scope_open' }],
    [{ text: 'همه خطوط باز', callback_data: 'priceup_scope_all_open' }],
    [{ text: '↩️ بازگشت', callback_data: 'manage_back' }]
  ];
}

function priceUpPercentKeyboard(scope) {
  return [
    [{ text: '+۲٪', callback_data: `priceup_pct_${encodePriceUpPercent(2)}_${scope}` }, { text: '+۵٪', callback_data: `priceup_pct_${encodePriceUpPercent(5)}_${scope}` }],
    [{ text: '+۱۰٪', callback_data: `priceup_pct_${encodePriceUpPercent(10)}_${scope}` }, { text: '+۱۵٪', callback_data: `priceup_pct_${encodePriceUpPercent(15)}_${scope}` }],
    [{ text: 'درصد دلخواه', callback_data: `priceup_custom_${scope}` }],
    [{ text: 'بازگشت', callback_data: 'manage_price_up' }]
  ];
}

async function sendPriceUpConfirm(q, chatId, message, actor, scope, percent) {
  const preview = await previewPriceIncrease(q, { percent, scope });
  const sample = preview.changed ? (await listingsForPriceScopePreview(q, scope, percent)) : null;
  const lines = [
    'تأیید افزایش قیمت',
    '',
    `محدوده: ${PRICE_INCREASE_SCOPES[scope] || scope}`,
    `درصد: ${percent}٪`,
    `تعداد خط: ${preview.total} — ${preview.changed} خط قیمت جدید می‌گیرند`,
    '',
    'قیمت‌ها به نزدیک‌ترین ۱ میلیون تومان گرد می‌شوند.',
    'آگهی کانال برای خطوط موجود به‌روز می‌شود.'
  ];
  if (sample) {
    lines.push('', 'نمونه:', `${formatPhoneDisplay(sample.phone, sample.phone)}`, `${money(sample.oldPrice)} → ${money(sample.newPrice)} تومان`);
  }
  const token = encodePriceUpPercent(percent);
  await say(chatId, lines.join('\n'), markup({
    inline_keyboard: [
      [{ text: '✅ اعمال افزایش', callback_data: `priceup_do_${token}_${scope}` }],
      [{ text: 'انصراف', callback_data: 'manage_price_up' }]
    ]
  }));
}

async function listingsForPriceScopePreview(q, scope, percent) {
  const rows = scope === 'active'
    ? await q`SELECT phone_number, price_toman FROM listings WHERE status = 'active' AND COALESCE(price_toman, 0) > 0 LIMIT 50`
    : scope === 'open'
      ? await q`SELECT phone_number, price_toman FROM listings WHERE status IN ('active', 'reserved', 'ready_transfer') AND COALESCE(price_toman, 0) > 0 LIMIT 50`
      : await q`SELECT phone_number, price_toman FROM listings WHERE status IN ('active', 'reserved', 'ready_transfer', 'inactive') AND COALESCE(price_toman, 0) > 0 LIMIT 50`;
  for (const row of rows) {
    const oldPrice = Number(row.price_toman);
    const newPrice = priceAfterPercentIncrease(oldPrice, percent);
    if (newPrice && newPrice !== oldPrice) return { phone: row.phone_number, oldPrice, newPrice };
  }
  return null;
}

async function handlePriceUpCallback(q, request, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const uid = actor.uid;
  if (data === 'manage_price_up') {
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: 'افزایش قیمت درصدی\n\nمحدوده خطوط را انتخاب کنید:',
      reply_markup: JSON.stringify({ inline_keyboard: priceUpScopeKeyboard() })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const scopePick = data.match(/^priceup_scope_(active|open|all_open)$/);
  if (scopePick) {
    const scope = scopePick[1];
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `افزایش قیمت — ${PRICE_INCREASE_SCOPES[scope]}\n\nدرصد افزایش را انتخاب کنید:`,
      reply_markup: JSON.stringify({ inline_keyboard: priceUpPercentKeyboard(scope) })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const custom = data.match(/^priceup_custom_(active|open|all_open)$/);
  if (custom) {
    await q`INSERT INTO owner_action_sessions(telegram_user_id, action, owner_id) VALUES(${uid}, ${`price_up:${custom[1]}`}, NULL)
      ON CONFLICT(telegram_user_id) DO UPDATE SET action = EXCLUDED.action, owner_id = NULL, created_at = NOW()`;
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `درصد افزایش را بفرستید (عدد بین ۰.۱ تا ۱۰۰).\nمثال: 7 یا 7.5\n\nمحدوده: ${PRICE_INCREASE_SCOPES[custom[1]]}`,
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'انصراف', callback_data: 'manage_price_up' }]] })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const pickPct = data.match(/^priceup_pct_(\d+)_(active|open|all_open)$/);
  if (pickPct) {
    const percent = decodePriceUpPercent(pickPct[1]);
    const scope = pickPct[2];
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    await sendPriceUpConfirm(q, chatId, callback.message, actor, scope, percent);
    return;
  }
  const apply = data.match(/^priceup_do_(\d+)_(active|open|all_open)$/);
  if (apply) {
    const percent = decodePriceUpPercent(apply[1]);
    const scope = apply[2];
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'در حال اعمال…' });
    let result;
    try {
      result = await increaseListingPricesByPercent(q, { percent, scope, by: uid });
    } catch (error) {
      await say(chatId, error.message === 'INVALID_PERCENT' ? 'درصد نامعتبر است.' : 'خطا در افزایش قیمت.');
      return;
    }
    let channelUpdates = 0;
    for (const row of result.updated) {
      const fresh = await syncListingChannel(q, request, row.id);
      if (fresh?.channel_chat_id) channelUpdates += 1;
    }
    const samples = result.updated.slice(0, 5).map((row) => `${formatPhoneDisplay(row.phone, row.phone)}: ${money(row.oldPrice)} → ${money(row.newPrice)}`).join('\n');
    await say(chatId, [
      `افزایش ${percent}٪ اعمال شد.`,
      `${result.count} خط به‌روز شد.`,
      channelUpdates ? `${channelUpdates} آگهی کانال به‌روز شد.` : '',
      samples ? `\nنمونه:\n${samples}` : ''
    ].filter(Boolean).join('\n'));
    return;
  }
}

async function sendManageSimPanel(q, request, chatId, messageId, actor) {
  const inst = await getInstallmentConfig(q);
  const origin = publicOrigin(request);
  const calcBase = process.env.PUBLIC_CALC_BASE_URL || origin;
  const localCalcHint = /127\.0\.0\.1|localhost/i.test(calcBase)
    ? '\n\n⚠️ لینک «خرید اقساطی» در کانال از همین آدرس ساخته می‌شود. روی موبایل 127.0.0.1 باز نمی‌شود — برای تست کانال، PUBLIC_CALC_BASE_URL را آدرس عمومی (مثلاً ngrok یا Vercel) بگذارید.'
    : '';
  const help = [
    'تنظیمات فروش اقساطی',
    '',
    formatInstallmentConfigSummary(inst),
    '',
    'دستورات:',
    '/setinterest 5',
    '/setinstallmentmonths 2 3 4 5 6 7 8',
    '/setinstallmentpercents 30 40 50 60 70 80 90',
    '/setinstallmentround 50000',
    '/setinstallmentdefault 30',
    '/setpurchaseexpire 30',
    '/toggleinstallment',
    localCalcHint
  ].join('\n');
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: help,
    reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: inst.salesEnabled ? '⏸ غیرفعال کردن فروش اقساطی' : '▶️ فعال کردن فروش اقساطی', callback_data: 'manage_inst_toggle' }],
      [{ text: '↩️ بازگشت', callback_data: 'manage_back' }]
    ] })
  };
  const edited = await tg('editMessageText', payload);
  if (!edited?.ok && !/not modified/i.test(edited?.description || '')) {
    await say(chatId, help, markup({
      inline_keyboard: [
        [{ text: inst.salesEnabled ? 'غیرفعال کردن فروش اقساطی' : 'فعال کردن فروش اقساطی', callback_data: 'manage_inst_toggle' }],
        [{ text: '↩️ بازگشت', callback_data: 'manage_back' }]
      ]
    }));
  }
}

async function channelMessagesPanelText(q) {
  const msgs = await loadChannelStatusMessages(q, settingValue);
  const lines = ['📝 پیام‌های کانال', '', 'وضعیت، سند، فروش ویژه، لینک‌های خرید و ریپلای‌ها.'];
  for (const key of Object.keys(CHANNEL_MSG_DEFAULTS)) {
    const label = CHANNEL_MSG_EDIT_LABELS[key] || key;
    const preview = String(msgs[key]).length > 48 ? `${String(msgs[key]).slice(0, 45)}…` : msgs[key];
    lines.push('', `${label}:\n${preview}`);
  }
  lines.push('', 'دستور: /setchannelmsg sold متن');
  return lines.join('\n');
}

function channelMessagesKeyboard() {
  const keys = Object.keys(CHANNEL_MSG_DEFAULTS);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    const row = keys.slice(i, i + 2).map((key) => {
      const label = (CHANNEL_MSG_EDIT_LABELS[key] || key).split('(')[0].trim().slice(0, 14);
      return { text: `✏️ ${label}`, callback_data: `chanmsg_edit_${key}` };
    });
    rows.push(row);
  }
  rows.push([{ text: '🔄 بازگشت به پیش‌فرض', callback_data: 'chanmsg_reset_menu' }]);
  rows.push([{ text: '↩️ بازگشت', callback_data: 'manage_channel' }]);
  return { inline_keyboard: rows };
}

async function handleChannelMsgCallback(q, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const uid = actor.uid;

  if (data === 'manage_channel_msgs') {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: await channelMessagesPanelText(q),
      reply_markup: JSON.stringify(channelMessagesKeyboard())
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }

  const edit = data.match(/^chanmsg_edit_(channel_msg_[a-z0-9_]+)$/);
  if (edit) {
    const key = edit[1];
    if (!CHANNEL_MSG_DEFAULTS[key]) {
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'پیام نامعتبر.' });
      return;
    }
    await q`INSERT INTO owner_action_sessions(telegram_user_id, action, owner_id) VALUES(${uid}, ${`chanmsg:${key}`}, NULL)
      ON CONFLICT(telegram_user_id) DO UPDATE SET action = EXCLUDED.action, owner_id = EXCLUDED.owner_id`;
    const current = (await loadChannelStatusMessages(q, settingValue))[key];
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: [
        `ویرایش: ${CHANNEL_MSG_EDIT_LABELS[key]}`,
        '',
        `فعلی:\n${current}`,
        '',
        'متن جدید را در همین چت بفرستید (حداکثر ۵۰۰ کاراکتر).',
        'انصراف: /cancel'
      ].join('\n'),
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '↩️ انصراف', callback_data: 'manage_channel_msgs' }]] })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }

  if (data === 'chanmsg_reset_menu') {
    const resetRows = [];
    const keys = Object.keys(CHANNEL_MSG_DEFAULTS);
    for (let i = 0; i < keys.length; i += 2) {
      resetRows.push(keys.slice(i, i + 2).map((key) => ({
        text: (CHANNEL_MSG_EDIT_LABELS[key] || key).split('(')[0].trim().slice(0, 12),
        callback_data: `chanmsg_reset_${key}`
      })));
    }
    resetRows.push([{ text: '↩️ بازگشت', callback_data: 'manage_channel_msgs' }]);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: 'کدام پیام به پیش‌فرض برگردد؟',
      reply_markup: JSON.stringify({ inline_keyboard: resetRows })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }

  const reset = data.match(/^chanmsg_reset_(channel_msg_[a-z0-9_]+)$/);
  if (reset && CHANNEL_MSG_DEFAULTS[reset[1]]) {
    await clearChannelStatusMessage(q, reset[1]);
    await tg('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: `پیش‌فرض: ${CHANNEL_MSG_DEFAULTS[reset[1]]}`,
      show_alert: true
    });
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: await channelMessagesPanelText(q),
      reply_markup: JSON.stringify(channelMessagesKeyboard())
    });
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: callback.id });
}

async function handleAdminCallback(q, request, callback, actor, data) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (data === 'manage_back') { await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'مدیریت', reply_markup: JSON.stringify(manageKeyboard(actor)) }); await tg('answerCallbackQuery', { callback_query_id: callback.id }); return; }
  if (data === 'manage_sim') {
    await sendManageSimPanel(q, request, chatId, messageId, actor);
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'manage_inst_toggle') {
    const inst = await getInstallmentConfig(q);
    await putSetting(q, 'installment_sales_enabled', inst.salesEnabled ? 'false' : 'true');
    const next = await getInstallmentConfig(q);
    const channelUpdates = await refreshInstallmentChannelPosts(q, tg, request, next);
    const alert = next.salesEnabled ? 'فروش اقساطی فعال شد' : 'فروش اقساطی غیرفعال شد';
    const detail = channelUpdates ? `\n${channelUpdates} آگهی کانال به‌روز شد.` : '';
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: `${alert}${detail}`, show_alert: true });
    await sendManageSimPanel(q, request, chatId, messageId, actor);
    return;
  }
  if (data === 'manage_channel') {
    const channelRows = [];
    if (canEditChannelMessages(actor)) {
      channelRows.push([{ text: '📝 پیام‌های کانال', callback_data: 'manage_channel_msgs' }]);
    }
    channelRows.push([{ text: '↩️ بازگشت', callback_data: 'manage_back' }]);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: [
        `کانال فعلی: ${process.env.CHANNEL_ID || 'تنظیم نشده'}`,
        'تغییر CHANNEL_ID از متغیرهای محیطی انجام می‌شود.',
        canEditChannelMessages(actor) ? '\nمالک/ادمین با دسترسی تنظیمات می‌تواند همه متن‌های کانال را از دکمه زیر ویرایش کند.' : ''
      ].filter(Boolean).join('\n'),
      reply_markup: JSON.stringify({ inline_keyboard: channelRows })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'manage_instagram') {
    const instagram = await settingValue(q, 'instagram_username', '-');
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `آیدی اینستاگرام: ${instagram}\nتغییر: /setinstagram @username`, reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: 'manage_back' }]] }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'manage_bot') {
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `ربات: @${String(process.env.BOT_USERNAME || 'SamiSIM0912Bot').replace(/^@/, '')}\nفروشگاه: /setstorename /setstorephone /setstoreaddress`, reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: 'manage_back' }]] }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'manage_admins') {
    const rows = await q`SELECT display_name, priority, active, telegram_user_id FROM admins ORDER BY priority`;
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `مالک و ادمین‌ها.\n${adminListLines(rows).join('\n')}\n\nروی ادمین ۱ یا ۲ برای دسترسی‌ها بزنید.`,
      reply_markup: JSON.stringify({ inline_keyboard: manageAdminKeyboard(rows) })
    });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  if (data === 'admin_owner_info') {
    const ownerId = ownerTelegramId() || '—';
    await tg('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: `مالک اصلی (${ownerId}) از OWNER_TELEGRAM_ID است. مالک‌های مشترک از CO_OWNER_TELEGRAM_IDS. ادمین با bot_owner در permissions هم دسترسی مالک دارد.`,
      show_alert: true
    });
    return;
  }
  if (data === 'admin_coowner_info') {
    const coList = coOwnerTelegramIds().filter((id) => id !== ownerTelegramId()).join(', ') || '—';
    await tg('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: `مالک مشترک (${coList}) از CO_OWNER_TELEGRAM_IDS است — همان دسترسی کامل مالک ربات.`,
      show_alert: true
    });
    return;
  }
  if (data === 'admin_add') { await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'فرمت:\n/setadmin 1 TELEGRAM_ID @username' }); await tg('answerCallbackQuery', { callback_query_id: callback.id }); return; }
  if (data === 'admin_remove') {
    const rows = await q`SELECT display_name, priority, telegram_user_id, active FROM admins WHERE active = true ORDER BY priority`;
    const buttons = rows.map((row) => [{ text: `${row.priority}. ${row.display_name || row.telegram_user_id}`, callback_data: `admin_remove_${row.priority}` }]);
    buttons.push([{ text: 'بازگشت', callback_data: 'manage_admins' }]);
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: 'ادمین غیرفعال شود:', reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const remove = data.match(/^admin_remove_(1|2)$/);
  if (remove) { await q`UPDATE admins SET active = false WHERE priority = ${Number(remove[1])}`; await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ادمین غیرفعال شد.' }); return; }
  const perm = data.match(/^perm_admin_(1|2)$/);
  if (perm) {
    const admin = (await q`SELECT display_name, permissions FROM admins WHERE priority = ${Number(perm[1])} LIMIT 1`)[0];
    if (!admin) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'این ادمین هنوز ثبت نشده.' }); return; }
    const permissions = admin.permissions || {};
    const buttons = Object.entries(PERMISSIONS).map(([key, label]) => {
      const mark = permissions[key] === true ? '✅' : '❌';
      const emoji = PERM_MENU_EMOJI[key] ? `${PERM_MENU_EMOJI[key]} ` : '';
      return [{ text: `${mark} ${emoji}${label}`, callback_data: `perm_toggle_${perm[1]}_${key}` }];
    });
    buttons.push([{ text: 'بازگشت', callback_data: 'manage_admins' }]);
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `دسترسی‌های ${admin.display_name || perm[1]}`, reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }
  const toggle = data.match(/^perm_toggle_(1|2)_([a-z_]+)$/);
  if (toggle && Object.hasOwn(PERMISSIONS, toggle[2])) {
    const priority = Number(toggle[1]);
    const admin = (await q`SELECT permissions FROM admins WHERE priority = ${priority} LIMIT 1`)[0];
    const permissions = { ...(admin?.permissions || {}) };
    permissions[toggle[2]] = permissions[toggle[2]] !== true;
    await q`UPDATE admins SET permissions = ${JSON.stringify(permissions)}::jsonb WHERE priority = ${priority}`;
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: `${PERMISSIONS[toggle[2]]} ${permissions[toggle[2]] ? 'فعال شد' : 'غیرفعال شد'}` });
    await handleAdminCallback(q, request, { ...callback, data: `perm_admin_${priority}` }, actor, `perm_admin_${priority}`);
  }
}

async function handleClaim(q, callback, actor, action, id) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const row = (await q`SELECT pr.*, a.telegram_user_id AS current_admin_uid FROM purchase_requests pr LEFT JOIN admins a ON a.telegram_user_id = pr.assigned_admin WHERE pr.id = ${id} LIMIT 1`)[0];
  if (!row) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'درخواست پیدا نشد.' }); return; }
  if (action === 'claim') {
    await q`UPDATE purchase_requests SET status = 'claimed', claimed_at = NOW(), assigned_admin = ${actor.uid}, assigned_priority = (SELECT priority FROM admins WHERE telegram_user_id = ${actor.uid} LIMIT 1) WHERE id = ${id}`;
    await say(chatId, `درخواست خرید #${id} پیگیری شد.\nاز دکمه‌های همان پیام: «رزرو و فروش» یا «فاکتور با اطلاعات مشتری».`);
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify(purchaseClaimedKeyboard(id)) });
    await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'درخواست به شما واگذار شد.' });
    return;
  }
  const second = (await q`SELECT * FROM admins WHERE active = true AND priority = 2 ORDER BY priority LIMIT 1`)[0];
  if (!second) { await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'ادمین دوم فعال نیست.' }); return; }
  await q`UPDATE purchase_requests SET status = 'pending', assigned_admin = ${second.telegram_user_id}, assigned_priority = 2, expires_at = NOW() + INTERVAL '30 minutes', handoff_notified = true WHERE id = ${id}`;
  const full = (await q`SELECT pr.*, l.phone_number, l.phone_display, l.condition_text FROM purchase_requests pr JOIN listings l ON l.id = pr.listing_id WHERE pr.id = ${id}`)[0];
  await tg('sendMessage', { chat_id: second.telegram_user_id, text: adminText(full, ADMIN_LABELS[2]), reply_markup: adminKeyboard(id) });
  if (row.current_admin_uid) await say(row.current_admin_uid, `درخواست خرید #${id} به ادمین ۲ واگذار شد.`);
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [] }) });
  await tg('answerCallbackQuery', { callback_query_id: callback.id, text: 'به ادمین ۲ واگذار شد.' });
}

