import {
  reserveListing, releaseListing, sellListing, saveListing, openListingByPhone,
  historyForPhone, lookupListingByPhone
} from '../../src/bot/data.js';
import { expireReservations } from '../../src/bot/jobs.js';
import { sql } from '../../src/database/sql.js';
import { ensureSchema, resetSchemaCache } from '../../src/database/schema.js';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54329/samisim';
process.env.LOCAL_PG = '1';

const q = sql();
resetSchemaCache();
await ensureSchema(q);

const phone = '09129998877';
const admin1 = 47314155;
const admin2 = 47314156;

await q`DELETE FROM listing_history WHERE listing_id IN (SELECT id FROM listings WHERE phone_number = ${phone})`;
await q`DELETE FROM listings WHERE phone_number = ${phone}`;

const created = await saveListing(q, {
  phone,
  displayPhone: phone,
  price: 500_000_000,
  condition: 'audit test',
  ownerId: (await q`SELECT id FROM owners LIMIT 1`)[0]?.id,
  warehouseId: (await q`SELECT id FROM warehouses LIMIT 1`)[0]?.id,
  date: '2026-12-01',
  by: admin1
});
console.log('create', created.mode, created.row.id);

const lookupRow = await lookupListingByPhone(q, phone.replace(/\D/g, ''));
console.log('lookup join', Boolean(lookupRow?.owner_name), lookupRow?.id === created.row.id);

const r1 = await reserveListing(q, created.row.id, admin1);
const r2 = await reserveListing(q, created.row.id, admin2);
console.log('reserve1', Boolean(r1), 'reserve2', Boolean(r2));

const blockedRelease = await releaseListing(q, created.row.id, admin2, { isOwner: false });
console.log('release blocked for non-reserver', blockedRelease?.denied === true);
await releaseListing(q, created.row.id, admin1, { isOwner: false });
const r3 = await reserveListing(q, created.row.id, admin2);
console.log('reserve after release', Boolean(r3));

const sold = await sellListing(q, created.row.id, admin2);
console.log('sold', sold?.status);

const reopened = await saveListing(q, {
  phone,
  displayPhone: phone,
  price: 600_000_000,
  condition: 'audit cycle 2',
  ownerId: created.row.owner_id,
  warehouseId: created.row.warehouse_id,
  date: '2026-12-15',
  by: admin1
});
console.log('reopen', reopened.mode, reopened.reopened, 'cycle', reopened.row.cycle_no);

const history = await historyForPhone(q, phone);
console.log('history fields', [...new Set(history.map((h) => h.field_name))].join(', '));

await q`UPDATE listings SET status = 'reserved', reserved_by = ${admin1}, reserved_at = NOW(), reserved_until = NOW() - INTERVAL '5 minutes' WHERE id = ${reopened.row.id}`;
const expired = await expireReservations(q, async () => ({ ok: true }));
console.log('expire count', expired);

const open = await openListingByPhone(q, phone);
console.log('open after expire', open?.status);

console.log('AUDIT_FLOW_OK');
