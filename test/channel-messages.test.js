import test from 'node:test';
import assert from 'node:assert/strict';
import { channelPurchaseKeyboard, channelText } from '../src/channel/channel.js';
import {
  CHANNEL_MSG_DEFAULTS, canEditChannelMessages, channelMsgKeyFromAlias, loadChannelStatusMessages,
  renderChannelDocumentLine
} from '../src/channel/channel-messages.js';
import { postSpecialSaleNotice } from '../src/bot/data.js';

test('channelText uses all customizable channel strings', () => {
  const msgs = {
    ...CHANNEL_MSG_DEFAULTS,
    channel_msg_special_badge: 'تخفیف ویژه',
    channel_msg_document_future: 'سند: {date}',
    channel_msg_link_installment: 'اقساط',
    channel_msg_link_cash: 'نقد'
  };
  const row = {
    phone_number: '09121234567',
    condition_text: 'نو',
    price_toman: 1000000,
    status: 'active',
    document_ready_date: '2099-06-01',
    special_sale_applied_at: new Date().toISOString(),
    id: 1
  };
  const text = channelText(row, {
    bot: 'TestBot',
    calcUrl: 'https://example.com/calc',
    installmentEnabled: true,
    statusMessages: msgs
  });
  assert.match(text, /تخفیف ویژه/);
  assert.match(text, /سند: /);
  assert.match(text, />اقساط</);
  assert.match(text, />نقد</);
  const withNote = channelText({ ...row, public_note: 'خوش‌قیمت، تحویل فوری' }, {
    bot: 'TestBot',
    calcUrl: 'https://example.com/calc',
    installmentEnabled: true,
    statusMessages: msgs
  });
  assert.match(withNote, /خوش‌قیمت، تحویل فوری/);
  const keyboard = channelPurchaseKeyboard(row, { bot: 'SamiSIM0912Bot', calcUrl: 'https://example.com/calc', installmentEnabled: true, statusMessages: msgs });
  assert.equal(keyboard.inline_keyboard[0][1].url, 'https://t.me/SamiSIM0912Bot?start=cash_1');
  assert.equal(keyboard.inline_keyboard[0][1].text, 'نقد');
  const ready = channelPurchaseKeyboard({ ...row, status: 'ready_transfer' }, { bot: 'SamiSIM0912Bot', calcUrl: 'https://example.com/calc', installmentEnabled: true, statusMessages: msgs });
  assert.equal(ready.inline_keyboard[0][1].url, 'https://t.me/SamiSIM0912Bot?start=cash_1');
});

test('renderChannelDocumentLine respects templates', () => {
  const msgs = { ...CHANNEL_MSG_DEFAULTS, channel_msg_document_ready: 'سند آماده است' };
  assert.equal(renderChannelDocumentLine('2000-01-01', msgs), 'سند آماده است');
  assert.match(renderChannelDocumentLine('2099-01-01', msgs), /تاریخ سند:/);
});

test('loadChannelStatusMessages and aliases', async () => {
  const settingValue = async (_q, key) => (key === 'channel_msg_special_reply' ? 'ریپلای سفارشی' : null);
  const msgs = await loadChannelStatusMessages(null, settingValue);
  assert.equal(msgs.channel_msg_special_reply, 'ریپلای سفارشی');
  assert.equal(channelMsgKeyFromAlias('specialreply'), 'channel_msg_special_reply');
});

test('canEditChannelMessages for owner and settings admin', () => {
  assert.equal(canEditChannelMessages({ isOwner: true, allow: () => false }), true);
  assert.equal(canEditChannelMessages({ isOwner: false, allow: (k) => k === 'settings' }), true);
  assert.equal(canEditChannelMessages({ isOwner: false, allow: () => false }), false);
});

test('special sale reply uses setting text', async () => {
  const { tg, calls } = (() => {
    const calls = [];
    const tg = async (method, payload) => {
      calls.push({ method, payload });
      return method === 'sendMessage' ? { ok: true, result: { message_id: 42 } } : { ok: true };
    };
    return { tg, calls };
  })();
  const q = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT value FROM settings')) {
      const key = values[0];
      if (key === 'channel_msg_special_reply') return [{ value: 'پیام ویژه سفارشی' }];
      return [];
    }
    return [];
  };
  q.query = async () => ({ rows: [] });
  await postSpecialSaleNotice(q, tg, {
    id: 3,
    special_sale_applied_at: new Date().toISOString(),
    special_sale_notice_message_id: null,
    channel_chat_id: '-100',
    channel_message_id: 9
  });
  assert.equal(calls[0].payload.text, 'پیام ویژه سفارشی');
});
