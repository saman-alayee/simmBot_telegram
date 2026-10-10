import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const projectRoot = process.cwd();
const dataDir = path.join(projectRoot, '.local', 'pgdata');

export const localPgPort = Number(process.env.LOCAL_PG_PORT || 54329);
export const localPgDatabase = process.env.LOCAL_PG_DATABASE || 'samisim';
export const localPgUser = 'postgres';
export const localPgPassword = 'postgres';
export const localDatabaseUrl = `postgresql://${localPgUser}:${localPgPassword}@127.0.0.1:${localPgPort}/${localPgDatabase}`;

let embedded = null;

function portOpen(host, openPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: openPort, timeout: 400 });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function ensureLocalPostgres() {
  if (await portOpen('127.0.0.1', localPgPort)) return null;

  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const hasCluster = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: localPgUser,
    password: localPgPassword,
    port: localPgPort,
    persistent: true,
    initdbFlags: ['--encoding=UTF8']
  });

  if (!hasCluster) {
    console.log('در حال راه‌اندازی Postgres محلی (اولین بار ممکن است چند دقیقه طول بکشد)...');
    await embedded.initialise();
  } else {
    console.log('Postgres محلی از قبل initialize شده؛ فقط start می‌شود.');
  }
  await embedded.start();
  try {
    await embedded.createDatabase(localPgDatabase);
  } catch (error) {
    if (!/already exists/i.test(String(error?.message || error))) throw error;
  }
  console.log(`Postgres محلی روی پورت ${localPgPort} آماده است.`);
  return embedded;
}

export async function stopLocalPostgres() {
  if (!embedded) return;
  await embedded.stop();
  embedded = null;
}
