import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearReserveNotice, deleteChannelMessage, postReserveNotice, postSpecialSaleNotice
} from '../src/bot/data.js';

function mockTg() {
  const calls = [];
  const tg = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage') return { ok: true, result: { message_id: 9000 + calls.length } };
    if (method === 'deleteMessage') return { ok: true };
    return { ok: false };
  };
  return { tg, calls };
}

test('reserve notice is posted once and cleared on release', async () => {
  const { tg, calls } = mockTg();
  const updates = [];
  const q = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('UPDATE listings SET reserved_notice_message_id')) updates.push(values[0]);
    if (text.includes('reserved_notice_message_id = NULL')) updates.push(null);
    return [];
  };
  q.query = async () => ({ rows: [] });

  let row = {
    id: 1,
    status: 'reserved',
    channel_chat_id: '-1001',
    channel_message_id: 50,
    reserved_notice_message_id: null
  };
  q.channelSettings = { channel_msg_reserved: '🟡 در حال رزرو' };
  const origQ = q;
  const qWithSettings = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT value FROM settings')) {
      const key = values[0];
      const val = origQ.channelSettings?.[key];
      return val != null ? [{ value: val }] : [];
    }
    return origQ(strings, ...values);
  };
  qWithSettings.query = q.query;

  row = await postReserveNotice(qWithSettings, tg, row);
  assert.equal(row.reserved_notice_message_id, 9001);
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1);
  assert.equal(calls[0].payload.text, '🟡 در حال رزرو');

  row = await postReserveNotice(q, tg, row);
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1);

  row.reserved_notice_message_id = 9001;
  await clearReserveNotice(q, tg, row);
  assert.equal(calls.filter((c) => c.method === 'deleteMessage').length, 1);
  assert.equal(row.reserved_notice_message_id, null);
});

test('special sale notice replies on channel post', async () => {
  const { tg, calls } = mockTg();
  const q = async () => [];
  q.query = async () => ({ rows: [] });

  let row = {
    id: 2,
    special_sale_applied_at: new Date().toISOString(),
    special_sale_notice_message_id: null,
    channel_chat_id: '-1001',
    channel_message_id: 60
  };
  row = await postSpecialSaleNotice(q, tg, row);
  assert.equal(row.special_sale_notice_message_id, 9001);
  assert.match(calls[0].payload.text, /فروش ویژه/);
  assert.equal(calls[0].payload.reply_to_message_id, 60);
});

test('deleteChannelMessage treats missing message as success', async () => {
  const tg = async () => ({ ok: false, description: 'message to delete not found' });
  assert.equal(await deleteChannelMessage(tg, '-1', 1), true);
});
