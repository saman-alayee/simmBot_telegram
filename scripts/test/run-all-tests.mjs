import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLocalDatabase } from '../dev/bootstrap-local.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

loadEnv(path.join(root, '.env.local'));
process.env.LOCAL_PG = '1';

function run(label, args) {
  console.log('\n===', label, '===');
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`FAILED ${label} exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`OK ${label}`);
}

try {
  const { stopLocalPostgres, ensureLocalPostgres } = await import('../dev/local-pg.mjs');
  try { await stopLocalPostgres(); } catch { /* ignore */ }
  await ensureLocalPostgres();
} catch { /* ignore */ }
await bootstrapLocalDatabase();
run('unit tests', ['--test', './test/logic.test.js', './test/pdf.test.js', './test/channel-notices.test.js']);
process.env.SKIP_SPEC_UNIT = '1';
run('spec-compliance', ['scripts/test/spec-compliance.mjs']);

const channelId = process.env.CHANNEL_ID;
if (channelId && channelId !== '-1000000000000') {
  run('channel-e2e (@testsimmm)', ['scripts/test/channel-e2e.mjs']);
} else {
  console.log('\nSKIP channel-e2e (CHANNEL_ID not set)');
}

console.log('\nALL_TESTS_OK');
