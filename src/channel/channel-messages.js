import { displayJalali, isDocumentReadyDue } from '../domain/format.js';
import { trimBodyAndEntities } from '../telegram/telegram-text.js';

/** Settings keys — متن‌های قابل ویرایش در کانال */
export const CHANNEL_MSG_DEFAULTS = {
  channel_msg_reserved: '⌛رزرو شد⌛',
  channel_msg_sold: '❌فروخته شد❌',
  channel_msg_ready_transfer: '🔵 وضعیت: آماده انتقال',
  channel_msg_special_badge: '🔥 فروش ویژه',
  channel_msg_special_reply: '🔥 فروش ویژه — ۴٪ تخفیف روی قیمت همین خط',
  channel_msg_document_ready: '✅ آماده سند',
  channel_msg_document_future: 'تاریخ سند: {date}',
  channel_msg_document_none: 'تاریخ سند: -',
  channel_msg_sold_document_ready: '✅ آماده سند',
  channel_msg_link_installment: 'خرید اقساطی',
  channel_msg_link_cash: 'خرید نقدی'
};

export const CHANNEL_MSG_EDIT_LABELS = {
  channel_msg_reserved: 'رزرو شد (آگهی + ریپلای)',
  channel_msg_sold: 'فروخته شد (آگهی + ریپلای)',
  channel_msg_ready_transfer: 'آماده انتقال (آگهی)',
  channel_msg_special_badge: 'برچسب فروش ویژه (روی آگهی)',
  channel_msg_special_reply: 'ریپلای فروش ویژه',
  channel_msg_document_ready: 'آماده سند (روی آگهی)',
  channel_msg_document_future: 'تاریخ سند آینده ({date})',
  channel_msg_document_none: 'بدون تاریخ سند',
  channel_msg_sold_document_ready: 'خط اضافه ریپلای فروش (آماده سند)',
  channel_msg_link_installment: 'متن لینک خرید اقساطی',
  channel_msg_link_cash: 'متن لینک خرید نقدی'
};

const SETCHANNEL_ALIASES = {
  reserved: 'channel_msg_reserved',
  r: 'channel_msg_reserved',
  sold: 'channel_msg_sold',
  s: 'channel_msg_sold',
  ready: 'channel_msg_ready_transfer',
  transfer: 'channel_msg_ready_transfer',
  t: 'channel_msg_ready_transfer',
  special: 'channel_msg_special_badge',
  specialbadge: 'channel_msg_special_badge',
  specialreply: 'channel_msg_special_reply',
  docready: 'channel_msg_document_ready',
  docfuture: 'channel_msg_document_future',
  docnone: 'channel_msg_document_none',
  solddoc: 'channel_msg_sold_document_ready',
  installment: 'channel_msg_link_installment',
  cash: 'channel_msg_link_cash'
};

export function channelMsgKeyFromAlias(alias) {
  return SETCHANNEL_ALIASES[String(alias || '').trim().toLowerCase()] || null;
}

export function canEditChannelMessages(actor) {
  return Boolean(actor?.isOwner || actor?.allow?.('settings'));
}

export function channelMessageEntityKey(key) {
  return `${key}_entities`;
}

export async function loadChannelStatusMessages(q, settingValue) {
  const { texts } = await loadChannelMessageBundles(q, settingValue);
  return texts;
}

export async function loadChannelMessageBundles(q, settingValue) {
  const texts = { ...CHANNEL_MSG_DEFAULTS };
  const entities = {};
  for (const key of Object.keys(CHANNEL_MSG_DEFAULTS)) {
    const v = await settingValue(q, key, null);
    if (v != null && String(v).trim()) texts[key] = String(v).trim();
    const entRaw = await settingValue(q, channelMessageEntityKey(key), null);
    if (entRaw) {
      try {
        const parsed = JSON.parse(entRaw);
        if (Array.isArray(parsed) && parsed.length) entities[key] = parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return { texts, entities };
}

export async function saveChannelMessage(q, putSettingFn, key, text, entities) {
  const normalized = trimBodyAndEntities(text, entities);
  await putSettingFn(q, key, normalized.text);
  const ek = channelMessageEntityKey(key);
  const custom = (normalized.entities || []).filter((e) => e.type === 'custom_emoji');
  if (custom.length) {
    await putSettingFn(q, ek, JSON.stringify(custom));
  } else {
    await q`DELETE FROM settings WHERE key = ${ek}`;
  }
}

export async function clearChannelStatusMessage(q, key) {
  await q`DELETE FROM settings WHERE key = ${key}`;
  await q`DELETE FROM settings WHERE key = ${channelMessageEntityKey(key)}`;
}

export function renderChannelDocumentLine(documentReadyDate, msgs, now = new Date()) {
  if (!documentReadyDate) return msgs.channel_msg_document_none;
  if (isDocumentReadyDue(documentReadyDate, now)) return msgs.channel_msg_document_ready;
  const jalali = displayJalali(documentReadyDate);
  return String(msgs.channel_msg_document_future).replace(/\{date\}/g, jalali);
}
