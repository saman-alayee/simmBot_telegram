/**
 * بعد از پاک کردن دیتابیس: اسکیما + مالک/انبار/ادمین اولیه
 * node scripts/ops/rebootstrap-db.mjs
 */
import fs from 'node:fs';
import { sql } from '../../src/database/sql.js';
import { ensureSchema, resetSchemaCache } from '../../src/database/schema.js';
import { ALL_PERMISSIONS } from '../../src/domain/logic.js';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
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
    process.env[key] ??= value;
  }
}

function isLocalDbUrl(url) {
  try {
    const host = new URL(String(url).replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

loadEnv('.env.local');

const forceRemote = process.argv.includes('--neon') || process.argv.includes('--remote');
if (forceRemote) {
  delete process.env.LOCAL_PG;
}

if (!forceRemote && (process.env.LOCAL_PG === '1' || isLocalDbUrl(process.env.DATABASE_URL))) {
  const { ensureLocalPostgres } = await import('../dev/local-pg.mjs');
  await ensureLocalPostgres();
  if (fs.existsSync('.local/.schema-ready')) fs.unlinkSync('.local/.schema-ready');
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

resetSchemaCache();
const q = sql();
await ensureSchema(q);

let owner = (await q`SELECT id FROM owners WHERE active = true ORDER BY id LIMIT 1`)[0];
if (!owner) {
  owner = (await q`INSERT INTO owners(name, active, max_line_slots) VALUES('مالک پیش‌فرض', true, 50) RETURNING id`)[0];
}
let wh = (await q`SELECT id FROM warehouses WHERE active = true ORDER BY id LIMIT 1`)[0];
if (!wh) {
  wh = (await q`INSERT INTO warehouses(name, active) VALUES('انبار پیش‌فرض', true) RETURNING id`)[0];
}

const ownerUid = String(process.env.OWNER_TELEGRAM_ID || '').trim();
if (/^\d+$/.test(ownerUid)) {
  await q`DELETE FROM admins WHERE telegram_user_id = ${ownerUid}`;
  await q`INSERT INTO admins(telegram_user_id, display_name, role, priority, active, permissions)
    VALUES(${ownerUid}, 'مالک', 'admin', 1, true, ${JSON.stringify(ALL_PERMISSIONS)}::jsonb)
    ON CONFLICT (telegram_user_id) DO UPDATE SET active = true, permissions = EXCLUDED.permissions`;
}

fs.mkdirSync('.local', { recursive: true });
fs.writeFileSync('.local/.schema-ready', new Date().toISOString());

let dbHost = '?';
try {
  dbHost = new URL(String(process.env.DATABASE_URL).replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
} catch { /* ignore */ }
console.log('OK rebootstrap', { dbHost, ownerId: owner.id, warehouseId: wh.id, adminUid: ownerUid || null });
