import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ALL_PERMISSIONS } from '../../src/domain/logic.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  process.env[t.slice(0, i)] = t.slice(i + 1);
}

const telegramUserId = process.argv[2];
const displayName = process.argv[3] || 'ادمین';
const priorityArg = process.argv[4] ? Number(process.argv[4]) : null;
if (!/^\d+$/.test(telegramUserId || '')) {
  console.error('Usage: node scripts/add-admin-once.mjs TELEGRAM_ID [display_name] [priority 1|2]');
  process.exit(1);
}

process.env.LOCAL_PG = '1';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
const rows = await pool.query('SELECT telegram_user_id, priority, active FROM admins WHERE priority IN (1, 2) OR telegram_user_id = $1 ORDER BY priority', [telegramUserId]);
const taken = new Set(rows.rows.filter((r) => r.telegram_user_id !== telegramUserId).map((r) => Number(r.priority)));
let priority = priorityArg;
if (![1, 2].includes(priority)) priority = !taken.has(2) ? 2 : !taken.has(1) ? 1 : 2;

await pool.query('DELETE FROM admins WHERE priority = $1 OR telegram_user_id = $2', [priority, telegramUserId]);
await pool.query(
  `INSERT INTO admins(telegram_user_id, display_name, role, priority, active, permissions)
   VALUES ($1, $2, 'admin', $3, true, $4::jsonb)`,
  [telegramUserId, displayName, priority, JSON.stringify(ALL_PERMISSIONS)]
);
const after = await pool.query('SELECT telegram_user_id, display_name, priority, active FROM admins ORDER BY priority');
console.log(JSON.stringify(after.rows, null, 2));
await pool.end();
