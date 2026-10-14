import test from 'node:test';
import assert from 'node:assert/strict';
import { displayJalali, documentReadyDateIso, plusDaysISO, saleDocumentDueFromReady, shouldRemindSaleDocument, tehranYmd } from '../src/domain/format.js';
import { staffNotifyChatIds } from '../src/domain/logic.js';
import { historyLines, lookupText } from '../src/bot/data.js';
import { remindDocuments } from '../src/bot/jobs.js';

test('sale document due uses ready date or Tehran today', () => {
  assert.equal(saleDocumentDueFromReady('2026-12-01'), '2026-12-01');
  const now = new Date('2026-10-13T00:20:00+03:30');
  assert.equal(saleDocumentDueFromReady(null, now), '2026-10-13');
  assert.equal(saleDocumentDueFromReady('', now), '2026-10-13');
});

test('plusDaysISO follows the Tehran calendar', () => {
  assert.equal(plusDaysISO(7, new Date('2026-10-13T00:20:00+03:30')), '2026-10-20');
  assert.equal(plusDaysISO(0, new Date('2026-10-13T22:00:00+03:30')), '2026-10-13');
});

test('postgres DATE at Tehran midnight keeps the Tehran calendar day', () => {
  const pgDate = new Date('2026-10-19T20:30:00.000Z');
  assert.equal(documentReadyDateIso(pgDate), '2026-10-20');
  assert.equal(displayJalali(pgDate), displayJalali('2026-10-20'));
});

test('sale document reminder is due once per Tehran day', () => {
  const now = new Date('2026-10-13T15:00:00+03:30');
  const base = { status: 'sold', sale_document_status: 'pending', sale_document_due_date: '2026-10-13' };
  assert.equal(shouldRemindSaleDocument(base, now), true);
  assert.equal(shouldRemindSaleDocument({ ...base, sale_document_due_date: '2026-10-14' }, now), false);
  assert.equal(shouldRemindSaleDocument({ ...base, sale_document_status: 'done' }, now), false);
  assert.equal(shouldRemindSaleDocument({ ...base, status: 'active' }, now), false);
  assert.equal(shouldRemindSaleDocument({ ...base, sale_document_last_reminded_at: '2026-10-13T08:00:00+03:30' }, now), false);
  assert.equal(shouldRemindSaleDocument({ ...base, sale_document_last_reminded_at: '2026-10-12T23:00:00+03:30' }, now), true);
});

test('document reminders go to owner and co-owner even without priority 2', () => {
  assert.deepEqual(
    staffNotifyChatIds({ OWNER_TELEGRAM_ID: '47314155', CO_OWNER_TELEGRAM_IDS: '186174121' }, [
      { telegram_user_id: '8633839153', priority: 1 }
    ]),
    ['47314155', '186174121', '8633839153']
  );
  assert.deepEqual(staffNotifyChatIds({ OWNER_TELEGRAM_ID: '1' }, []), ['1']);
  assert.deepEqual(staffNotifyChatIds({ OWNER_TELEGRAM_ID: 'auto' }, []), []);
  assert.deepEqual(
    staffNotifyChatIds({ OWNER_TELEGRAM_ID: '1', CO_OWNER_TELEGRAM_IDS: '1,2' }, [{ telegram_user_id: '2', priority: 1 }]),
    ['1', '2']
  );
});

test('price history lines keep old amount, new amount, time, and user', () => {
  const text = historyLines([{
    cycle_no: 1,
    field_name: 'price_toman',
    old_value: '500000000',
    new_value: '525000000',
    changed_at: '2026-10-13T10:00:00+03:30',
    changed_by: 47314155
  }], new Map(), new Map());
  assert.match(text, /تغییر قیمت/);
  assert.match(text, /500,000,000/);
  assert.match(text, /525,000,000/);
  assert.match(text, /کاربر 47314155/);
  assert.match(text, /\d{4}\/\d{2}\/\d{2}/);
});

test('lookup shows sale document due or completed', () => {
  const pending = lookupText({
    cycle_no: 1,
    phone_number: '09129991111',
    phone_display: '0912 999 11 11',
    price_toman: 1000000,
    status: 'sold',
    owner_name: 'تست',
    warehouse_name: 'تست',
    document_ready_date: '2026-10-01',
    sale_document_status: 'pending',
    sale_document_due_date: '2026-10-13',
    sale_document_cycle: 1,
    sold_at: '2026-10-13T10:00:00Z',
    period_started_at: '2026-10-01T10:00:00Z'
  });
  assert.match(pending, /موعد سند فروش:/);
  assert.match(pending, /تأخیر 1/);

  const done = lookupText({
    cycle_no: 1,
    phone_number: '09129991111',
    phone_display: '0912 999 11 11',
    price_toman: 1000000,
    status: 'sold',
    owner_name: 'تست',
    warehouse_name: 'تست',
    document_ready_date: '2026-10-01',
    sale_document_status: 'done',
    sale_document_completed_at: '2026-10-13T10:00:00Z',
    sold_at: '2026-10-13T10:00:00Z',
    period_started_at: '2026-10-01T10:00:00Z'
  });
  assert.match(done, /سند فروش: تکمیل شد/);
});

test('remindDocuments notifies owner when only priority 1 admin exists', async () => {
  const previousOwner = process.env.OWNER_TELEGRAM_ID;
  const previousCo = process.env.CO_OWNER_TELEGRAM_IDS;
  process.env.OWNER_TELEGRAM_ID = '47314155';
  process.env.CO_OWNER_TELEGRAM_IDS = '186174121';
  const sent = [];
  const q = async (strings) => {
    const sql = strings.join('?');
    if (sql.includes('FROM admins')) return [{ telegram_user_id: '8633839153', priority: 1 }];
    if (sql.includes('SELECT * FROM listings')) {
      return [{
        id: 99,
        phone_number: '09129991111',
        phone_display: '0912 999 11 11',
        sale_document_due_date: tehranYmd(),
        sale_document_cycle: 0
      }];
    }
    return [];
  };
  try {
    const count = await remindDocuments(q, async (method, body) => {
      sent.push({ method, chat_id: String(body.chat_id), text: body.text });
      return { ok: true };
    }, { listingId: 99 });
    assert.equal(count, 1);
    assert.deepEqual(sent.map((row) => row.chat_id).sort(), ['186174121', '47314155', '8633839153']);
    assert.equal(sent[0].method, 'sendMessage');
    assert.match(sent[0].text, /یادآوری سند/);
    assert.match(sent[0].text, /0912/);
  } finally {
    if (previousOwner == null) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = previousOwner;
    if (previousCo == null) delete process.env.CO_OWNER_TELEGRAM_IDS;
    else process.env.CO_OWNER_TELEGRAM_IDS = previousCo;
  }
});
