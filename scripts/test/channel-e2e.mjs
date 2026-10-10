/**
 * تست کانال واقعی: ثبت، رزرو+Reply، آزاد+حذف Reply، فروش+Reply، Cron 48h/60d (شبیه‌سازی زمان)
 */
import fs from 'node:fs';
import { sql } from '../../src/database/sql.js';
import { ensureSchema, resetSchemaCache } from '../../src/database/schema.js';
import {
  announceSold, clearReserveNotice, listingById, postReserveNotice, postSpecialSaleNotice,
  publicOrigin, releaseListing, reserveListing, saveListing, sellListing, syncChannel
} from '../../src/bot/data.js';
import { runJobs } from '../../src/bot/jobs.js';
import { applySpecialSale } from '../../src/bot/data.js';
import { shouldApplySpecialSale } from '../../src/domain/logic.js';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ??= value;
  }
}

loadEnv('.env.local');
process.env.LOCAL_PG = '1';
console.log('channel-e2e start', process.env.CHANNEL_ID);

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.argv[2] || process.env.CHANNEL_ID;
const ownerId = Number(process.env.OWNER_TELEGRAM_ID || 47314155);
const otherAdmin = ownerId + 1;

if (!token || !channelId || channelId === '-1000000000000') {
  console.error('CHANNEL_ID واقعی نیست. CHANNEL_ID=-100… را در .env.local بگذارید و دوباره channel-e2e را اجرا کنید.');
  process.exit(2);
}

process.env.CHANNEL_ID = String(channelId);

async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function tgOk(method, body = {}) {
  const data = await tg(method, body);
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data;
}

const log = [];
function ok(name, detail = '') {
  log.push({ name, ok: true, detail });
  console.log('OK', name, detail);
}
function fail(name, detail) {
  log.push({ name, ok: false, detail });
  console.error('FAIL', name, detail);
}

const { ensureLocalPostgres, stopLocalPostgres } = await import('../dev/local-pg.mjs');
try { await stopLocalPostgres(); } catch { /* ignore */ }
await ensureLocalPostgres();

const q = sql();
const schemaMarker = '.local/.schema-ready';
resetSchemaCache();
if (fs.existsSync(schemaMarker)) {
  console.log('ensureSchema skipped (local bootstrap marker)');
} else {
  console.log('ensureSchema…');
  await ensureSchema(q);
  console.log('ensureSchema done');
}

async function ensureSeed() {
  let ownerRow = (await q`SELECT id FROM owners WHERE active = true LIMIT 1`)[0];
  if (!ownerRow) {
    ownerRow = (await q`INSERT INTO owners(name, active, max_line_slots) VALUES('E2E Owner', true, 10) RETURNING id`)[0];
  }
  let whRow = (await q`SELECT id FROM warehouses WHERE active = true LIMIT 1`)[0];
  if (!whRow) {
    whRow = (await q`INSERT INTO warehouses(name, active) VALUES('E2E Warehouse', true) RETURNING id`)[0];
  }
  return { ownerRow, whRow };
}

const chat = await tgOk('getChat', { chat_id: channelId });
ok('getChat', chat.result?.title);

const me = await tgOk('getMe', {});
const admins = await tgOk('getChatAdministrators', { chat_id: channelId });
const botAdmin = admins.result?.some((a) => a.user?.id === me.result.id && ['administrator', 'creator'].includes(a.status));
if (!botAdmin) fail('bot admin in channel', 'بات باید ادمین کانال باشد');
else ok('bot admin in channel');

const phone = '09128887766';
console.log('cleanup test phones…');
await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE phone_number = ${phone})`;
await q`DELETE FROM listings WHERE phone_number = ${phone}`;
console.log('saveListing…');

const { ownerRow, whRow } = await ensureSeed();

const created = await saveListing(q, {
  phone,
  displayPhone: phone,
  price: 400_000_000,
  condition: 'تست کانال E2E',
  ownerId: ownerRow?.id,
  warehouseId: whRow?.id,
  date: '2026-12-01',
  by: ownerId
});
ok('saveListing', String(created.row.id));

let row = await listingById(q, created.row.id);
const sent = await syncChannel(q, tg, row, publicOrigin());
if (!sent?.result?.message_id) fail('syncChannel post', JSON.stringify(sent));
else ok('syncChannel post', `msg ${sent.result.message_id}`);

row = await listingById(q, created.row.id);
const reserved = await reserveListing(q, row.id, ownerId);
if (!reserved) fail('reserveListing');
else ok('reserveListing');

row = await listingById(q, row.id);
await syncChannel(q, tg, row, publicOrigin());
row = await postReserveNotice(q, tg, row);
if (!row.reserved_notice_message_id) fail('reserve reply');
else ok('reserve reply', String(row.reserved_notice_message_id));

const denied = await releaseListing(q, row.id, otherAdmin, { isOwner: false });
if (!denied?.denied) fail('release denied for other admin');
else ok('release denied for other admin');

const released = await releaseListing(q, row.id, ownerId, { isOwner: false });
if (!released?.denied && released) {
  await clearReserveNotice(q, tg, row);
  row = await listingById(q, row.id);
  await syncChannel(q, tg, row, publicOrigin());
  ok('release + clear reserve reply');
} else fail('release by reserver');

row = await listingById(q, created.row.id);
const reserved2 = await reserveListing(q, row.id, ownerId);
if (reserved2) {
  row = await listingById(q, row.id);
  await syncChannel(q, tg, row, publicOrigin());
  await postReserveNotice(q, tg, row);
  const sold = await sellListing(q, row.id, ownerId);
  if (sold) {
    await clearReserveNotice(q, tg, row);
    await announceSold(q, tg, { ...sold, channel_chat_id: row.channel_chat_id, channel_message_id: row.channel_message_id });
    ok('sell + sold reply');
    row = await listingById(q, row.id);
    if (row.sold_reply_message_id) ok('sold_reply_message_id', String(row.sold_reply_message_id));
    else fail('sold_reply_message_id missing');

    await q`UPDATE listings SET sold_at = NOW() - INTERVAL '49 hours' WHERE id = ${row.id}`;
    const cron1 = await runJobs(q, tg);
    row = await listingById(q, row.id);
    if (row.channel_cleaned_at) ok('48h cleanup', JSON.stringify(cron1.sold_cleanup));
    else fail('48h cleanup', 'channel_cleaned_at null');
  } else fail('sellListing from reserved');
}

const phone60 = '09128887767';
await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE phone_number = ${phone60})`;
await q`DELETE FROM listings WHERE phone_number = ${phone60}`;
const created60 = await saveListing(q, {
  phone: phone60,
  displayPhone: phone60,
  price: 500_000_000,
  condition: 'تست 60 روز',
  ownerId: ownerRow?.id,
  warehouseId: whRow?.id,
  date: '2026-12-01',
  by: ownerId
});
let row60 = await listingById(q, created60.row.id);
await syncChannel(q, tg, row60, publicOrigin());
await q`UPDATE listings SET period_started_at = NOW() - INTERVAL '59 days' WHERE id = ${row60.id}`;
row60 = await listingById(q, created60.row.id);
if (!shouldApplySpecialSale(row60)) ok('59 days no special');
else fail('59 days should not special');

await q`UPDATE listings SET period_started_at = NOW() - INTERVAL '61 days' WHERE id = ${row60.id}`;
row60 = await listingById(q, created60.row.id);
if (shouldApplySpecialSale(row60)) ok('61 days should special');
const updated = await applySpecialSale(q, row60);
row60 = await listingById(q, updated.id);
await syncChannel(q, tg, row60, publicOrigin());
await postSpecialSaleNotice(q, tg, row60);
row60 = await listingById(q, row60.id);
if (row60.special_sale_notice_message_id) ok('special sale reply');
else fail('special sale reply');

const cron2 = await runJobs(q, tg);
ok('cron runJobs', JSON.stringify({ reservations: cron2.reservations, special_sales: cron2.special_sales }));

const failed = log.filter((x) => !x.ok);
if (failed.length) {
  console.error('CHANNEL_E2E_FAILED', failed.length);
  process.exit(1);
}
console.log('CHANNEL_E2E_OK', log.length, 'checks');
