import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ensureLocalPostgres, localDatabaseUrl } from './local-pg.mjs';

const projectRoot = process.cwd();
const marker = path.join(projectRoot, '.local', '.schema-ready');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const splitAt = trimmed.indexOf('=');
    if (splitAt < 1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    let value = trimmed.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

export async function bootstrapLocalDatabase({ force = false } = {}) {
  loadEnvFile(path.join(projectRoot, '.env.local'));
  await ensureLocalPostgres();
  process.env.DATABASE_URL = process.env.DATABASE_URL || localDatabaseUrl;
  process.env.LOCAL_PG = '1';

  if (!force && fs.existsSync(marker)) return;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sqlPath = path.join(projectRoot, 'scripts', 'dev', 'local-base-schema.sql');
  await pool.query(fs.readFileSync(sqlPath, 'utf8'));
  await pool.end();

  const { sql } = await import('../../src/database/sql.js');
  const { ensureSchema, resetSchemaCache } = await import('../../src/database/schema.js');
  resetSchemaCache();
  await ensureSchema(sql());

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  console.log('اسکیمای تست محلی آماده است.');
}

export function writeLocalEnvFile(token) {
  const envPath = path.join(projectRoot, '.env.local');
  let keepChannel = '-1000000000000';
  let keepChannelUser = 'testsimmm';
  let keepOwner = 'auto';
  let keepCoOwner = '';
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('CHANNEL_ID=')) {
        const v = t.slice('CHANNEL_ID='.length);
        if (v && v !== '-1000000000000') keepChannel = v;
      }
      if (t.startsWith('CHANNEL_USERNAME=')) keepChannelUser = t.slice('CHANNEL_USERNAME='.length);
      if (t.startsWith('OWNER_TELEGRAM_ID=') && !t.endsWith('auto')) keepOwner = t.slice('OWNER_TELEGRAM_ID='.length);
      if (t.startsWith('CO_OWNER_TELEGRAM_IDS=')) keepCoOwner = t.slice('CO_OWNER_TELEGRAM_IDS='.length);
    }
  }
  const lines = [
    '# تست محلی — تولید خودکار',
    'LOCAL_DEV=1',
    'LOCAL_PG=1',
    `DATABASE_URL=${localDatabaseUrl}`,
    `TELEGRAM_BOT_TOKEN=${token}`,
    'BOT_USERNAME=TESTSIMMBOT',
    `OWNER_TELEGRAM_ID=${keepOwner}`,
    ...(keepCoOwner ? [`CO_OWNER_TELEGRAM_IDS=${keepCoOwner}`] : []),
    `CHANNEL_ID=${keepChannel}`,
    `CHANNEL_USERNAME=${keepChannelUser}`,
    'WEBHOOK_SECRET=local-dev-webhook-secret',
    'CRON_SECRET=local-dev-cron-secret',
    'SETUP_KEY=local-dev-setup-key',
    'PUBLIC_BASE_URL=http://127.0.0.1:8787',
    'LOCAL_PORT=8787'
  ];
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
}

const runAsCli = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/dev/bootstrap-local.mjs');
if (runAsCli) {
  loadEnvFile(path.join(projectRoot, '.env.local'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN لازم است.');
    process.exit(1);
  }
  writeLocalEnvFile(token);
  bootstrapLocalDatabase({ force: process.argv.includes('--force') })
    .then(async () => {
      const { stopLocalPostgres } = await import('./local-pg.mjs');
      await stopLocalPostgres();
      process.exit(0);
    })
    .catch((error) => { console.error(error); process.exit(1); });
}
