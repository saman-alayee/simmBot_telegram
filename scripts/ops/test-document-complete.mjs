import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../../src/database/sql.js';
import { completeSaleDocument, delaySaleDocument, saveListing, sellListing } from '../../src/bot/data.js';
import { documentReadyDateIso, plusDaysISO, tehranYmd } from '../../src/domain/format.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
  return true;
}

if (loadEnv(path.join(root, 'vercel.env'))) delete process.env.LOCAL_PG;
loadEnv(path.join(root, '.env.local'));
if (fs.existsSync(path.join(root, 'vercel.env'))) delete process.env.LOCAL_PG;

const q = sql();
const phone = '09129991112';
const uid = Number(process.env.OWNER_TELEGRAM_ID || 47314155);
const owner = (await q`SELECT id FROM owners WHERE active = true ORDER BY id LIMIT 1`)[0];
const warehouse = (await q`SELECT id FROM warehouses WHERE active = true ORDER BY id LIMIT 1`)[0];
await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = ${phone})`;
await q`DELETE FROM listings WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = ${phone}`;

const created = await saveListing(q, {
  phone,
  displayPhone: phone,
  price: 112_000_000,
  condition: 'تست تکمیل سند',
  ownerId: owner.id,
  warehouseId: warehouse.id,
  date: tehranYmd(),
  by: uid
});
const sold = await sellListing(q, created.row.id, uid);
const delayed = await delaySaleDocument(q, sold.id, uid);
const due = documentReadyDateIso(delayed?.sale_document_due_date);
const expected = plusDaysISO(7);
const done = await completeSaleDocument(q, sold.id, uid);
const again = await completeSaleDocument(q, sold.id, uid);
const delayAfterDone = await delaySaleDocument(q, sold.id, uid);

console.log(JSON.stringify({
  id: sold.id,
  afterSell: sold.sale_document_status,
  delayedDue: due,
  expected,
  cycle: delayed?.sale_document_cycle,
  completed: done?.sale_document_status,
  completedAt: Boolean(done?.sale_document_completed_at),
  secondComplete: again,
  delayAfterDone
}, null, 2));

await q`DELETE FROM listing_history WHERE listing_id = ${sold.id}`;
await q`DELETE FROM listings WHERE id = ${sold.id}`;

if (!delayed || Number(delayed.sale_document_cycle) !== 1 || due !== expected || done?.sale_document_status !== 'done' || again !== null || delayAfterDone !== null) {
  process.exit(1);
}
console.log('DOCUMENT_COMPLETE_DELAY_OK');
