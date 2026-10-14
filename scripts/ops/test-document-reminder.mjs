import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../../src/database/sql.js';
import { ensureSchema, resetSchemaCache } from '../../src/database/schema.js';
import { lookupText, saveListing, sellListing } from '../../src/bot/data.js';
import { remindDocuments } from '../../src/bot/jobs.js';
import { plusDaysISO, tehranYmd } from '../../src/domain/format.js';

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

const usedVercel = loadEnv(path.join(root, 'vercel.env'));
loadEnv(path.join(root, '.env.local'));
if (usedVercel) delete process.env.LOCAL_PG;

if (!process.env.DATABASE_URL || !process.env.TELEGRAM_BOT_TOKEN) {
  console.error('DATABASE_URL or TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}

const phone = '09129991111';
const ownerUid = Number(process.env.OWNER_TELEGRAM_ID || 47314155);
const q = sql();
resetSchemaCache();
await ensureSchema(q);

const owner = (await q`SELECT id FROM owners WHERE active = true ORDER BY id LIMIT 1`)[0];
const warehouse = (await q`SELECT id FROM warehouses WHERE active = true ORDER BY id LIMIT 1`)[0];
if (!owner || !warehouse) {
  console.error('Need an active owner and warehouse');
  process.exit(1);
}

await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = ${phone})`;
await q`DELETE FROM listings WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = ${phone}`;

const created = await saveListing(q, {
  phone,
  displayPhone: phone,
  price: 111_000_000,
  condition: 'تست یادآوری سند',
  ownerId: owner.id,
  warehouseId: warehouse.id,
  date: tehranYmd(),
  by: ownerUid
});
const sold = await sellListing(q, created.row.id, ownerUid);
if (!sold || sold.status !== 'sold' || sold.sale_document_status !== 'pending' || !sold.sale_document_due_date) {
  console.error('sellListing did not set sale document fields', {
    status: sold?.status,
    sale_document_status: sold?.sale_document_status,
    sale_document_due_date: sold?.sale_document_due_date
  });
  process.exit(1);
}

const sent = [];
const count = await remindDocuments(q, async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  sent.push({ chat_id: String(body.chat_id), ok: json.ok === true, description: json.description || null });
  return json;
}, { listingId: sold.id });

const fresh = (await q`SELECT * FROM listings WHERE id = ${sold.id} LIMIT 1`)[0];
console.log(JSON.stringify({
  listingId: sold.id,
  phone,
  due: String(fresh.sale_document_due_date).slice(0, 10),
  expectedDelayDue: plusDaysISO(7),
  status: fresh.sale_document_status,
  reminded: Boolean(fresh.sale_document_last_reminded_at),
  reminderCount: count,
  telegram: sent,
  lookupHasDue: /موعد سند فروش:/.test(lookupText({
    ...fresh,
    owner_name: 'تست',
    warehouse_name: 'تست'
  }))
}, null, 2));

if (count < 1 || sent.some((row) => !row.ok)) process.exit(1);
console.log('DOCUMENT_REMINDER_TEST_OK');
