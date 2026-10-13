import { CHANNEL_MSG_DEFAULTS, renderChannelDocumentLine } from './channel-messages.js';
import { botLinkUsername, esc, formatListingPriceHtml, formatPhoneDigits, toLatinDigits } from '../domain/format.js';
import { channelMsgHtmlFragment } from '../telegram/telegram-text.js';

export function channelText(row, { bot, calcUrl, installmentEnabled = true, statusMessages = null, statusEntities = null }) {
  const msgs = statusMessages || CHANNEL_MSG_DEFAULTS;
  const ents = statusEntities || {};
  const statusHtml = (key) => channelMsgHtmlFragment(msgs[key], ents[key]);
  const digits = toLatinDigits(row.phone_number).replace(/\D/g, '');
  const phoneHtml = formatPhoneDigits(digits) || row.phone_display || row.phone_number;
  const lines = [
    `<b><code>${esc(phoneHtml)}</code></b>`,
    esc(row.condition_text || '-'),
    `💵 ${formatListingPriceHtml(row)}`
  ];
  if (row.special_sale_applied_at) lines.push(statusHtml('channel_msg_special_badge'));
  lines.push('', esc(renderChannelDocumentLine(row.document_ready_date, msgs)));
  if (row.status === 'reserved') lines.push(statusHtml('channel_msg_reserved'));
  if (row.status === 'ready_transfer') lines.push(statusHtml('channel_msg_ready_transfer'));
  if (row.status === 'sold') lines.push(statusHtml('channel_msg_sold'));
  if (row.status === 'active') {
    const links = [];
    if (installmentEnabled) links.push(`<a href="${calcUrl}">${esc(msgs.channel_msg_link_installment)}</a>`);
    links.push(`<a href="https://t.me/${botLinkUsername(bot)}?start=cash_${row.id}">${esc(msgs.channel_msg_link_cash)}</a>`);
    lines.push(links.join('   |   '));
  }
  return lines.join('\n');
}

export function channelPurchaseKeyboard(row, { bot, calcUrl, installmentEnabled = true, statusMessages = null } = {}) {
  if (!row || row.status !== 'active') return { inline_keyboard: [] };
  const msgs = statusMessages || CHANNEL_MSG_DEFAULTS;
  const buttons = [];
  if (installmentEnabled && calcUrl) {
    buttons.push({ text: msgs.channel_msg_link_installment || 'خرید اقساطی', url: calcUrl });
  }
  buttons.push({
    text: msgs.channel_msg_link_cash || 'خرید نقدی',
    url: `https://t.me/${botLinkUsername(bot)}?start=cash_${row.id}`
  });
  return { inline_keyboard: [buttons] };
}

export function calcUrlFor(origin, listingId) {
  const base = String(process.env.PUBLIC_CALC_BASE_URL || origin || '').replace(/\/$/, '');
  return `${base}/api/calc?listing=${listingId}`;
}
