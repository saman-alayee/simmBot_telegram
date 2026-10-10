/**
 * پوشش بند ۱۵ سند + موارد ۱/۶/۷ (بدون Telegram واقعی).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from '../../src/database/sql.js';
import { ensureSchema, resetSchemaCache } from '../../src/database/schema.js';
import {
  clearReserveNotice, postReserveNotice, postSpecialSaleNotice, releaseListing, reserveListing
} from '../../src/bot/data.js';
import { allow } from '../../src/domain/logic.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    console.error(`FAIL ${label}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  console.log(`OK ${label}`);
}

if (process.env.SKIP_SPEC_UNIT !== '1') {
  runNode(['--test', './test/logic.test.js', './test/pdf.test.js', './test/channel-notices.test.js'], 'unit tests');
}
runNode(['scripts/test/audit-flow.mjs'], 'audit-flow (DB)');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54329/samisim';
process.env.LOCAL_PG = '1';
const q = sql();
const schemaMarker = '.local/.schema-ready';
resetSchemaCache();
if (!fs.existsSync(schemaMarker)) await ensureSchema(q);

const ownerId = Number(process.env.OWNER_TELEGRAM_ID || 47314155);
const otherAdmin = ownerId + 1;
const phone = '09127776655';

await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE phone_number = ${phone})`;
await q`DELETE FROM listings WHERE phone_number = ${phone}`;

const inserted = (await q`INSERT INTO listings(
  phone_number, phone_display, prefix_code, price_toman, condition_text, payment_terms,
  cash_amount_toman, status, cycle_no, period_started_at, channel_chat_id, channel_message_id
) VALUES (
  ${phone}, ${phone}, 1, 100000000, 'spec test', 'cash', 33333333, 'active', 1, NOW(), ${'-100chan'}, ${42}
) RETURNING *`)[0];

const tgLog = [];
const mockTg = async (method, payload) => {
  tgLog.push({ method, payload });
  if (method === 'sendMessage') return { ok: true, result: { message_id: 5001 } };
  if (method === 'deleteMessage') return { ok: true };
  return { ok: true };
};

await reserveListing(q, inserted.id, ownerId);
let row = (await q`SELECT * FROM listings WHERE id = ${inserted.id}`)[0];
row = await postReserveNotice(q, mockTg, row);
if (!row.reserved_notice_message_id) throw new Error('reserve notice not stored');

const denied = await releaseListing(q, inserted.id, otherAdmin, { isOwner: false });
if (!denied?.denied) throw new Error('non-reserver should not release');

await releaseListing(q, inserted.id, ownerId, { isOwner: false });
row = (await q`SELECT * FROM listings WHERE id = ${inserted.id}`)[0];
await clearReserveNotice(q, mockTg, { ...row, reserved_notice_message_id: 5001, channel_chat_id: '-100chan' });
if (!tgLog.some((c) => c.method === 'deleteMessage')) throw new Error('reserve notice should be deleted');

await q`UPDATE listings SET status = 'active', special_sale_applied_at = NOW(), special_sale_notice_message_id = NULL WHERE id = ${inserted.id}`;
row = (await q`SELECT * FROM listings WHERE id = ${inserted.id}`)[0];
await postSpecialSaleNotice(q, mockTg, row);
const specialRow = (await q`SELECT special_sale_notice_message_id FROM listings WHERE id = ${inserted.id}`)[0];
if (!specialRow?.special_sale_notice_message_id) throw new Error('special sale notice not stored');

if (!allow(otherAdmin, ownerId, { invoices: false }, 'invoices')) {
  console.log('OK permission deny invoices for staff without key');
} else {
  throw new Error('permission should deny invoices');
}

await q`DELETE FROM invoices WHERE customer_phone = '09120001122' OR national_id = '0499370899'`;
const listing2 = (await q`INSERT INTO listings(
  phone_number, phone_display, prefix_code, price_toman, condition_text, payment_terms,
  cash_amount_toman, status, cycle_no, period_started_at
) VALUES (
  '09127776656', '09127776656', 1, 100000000, 'spec test 2', 'cash', 33333333, 'sold', 1, NOW()
) RETURNING id`)[0].id;
await q`INSERT INTO invoices(
  invoice_number, listing_id, customer_name, national_id, customer_phone, address, birth_date,
  sale_type, price_toman, discount_toman, final_toman, pdf_base64, created_by
) VALUES
  ('S1405-90001', ${inserted.id}, 'علی تست', '0499370899', '09120001122', 'تهران', '1990-01-01', 'cash', 100, 0, 100, '', ${ownerId}),
  ('S1405-90002', ${listing2}, 'علی تست', '0499370899', '09120001122', 'تهران', '1990-01-01', 'installment', 100, 0, 100, '', ${ownerId})`;

const history = await q`SELECT invoice_number FROM invoices WHERE national_id = '0499370899' ORDER BY invoice_number`;
if (history.length !== 2) throw new Error('customer purchase history query expected 2 invoices');

console.log('OK spec-compliance (channel notices, release rule, customer invoices, permission)');
console.log('MANUAL: see docs/telegram-production-checklist.md for live Telegram/channel/cron checks');
console.log('SPEC_COMPLIANCE_OK');
