/**
 * تست یکپارچه روندهای اصلی (بدون Telegram واقعی).
 * نیاز: Postgres محلی روی DATABASE_URL (مثلاً npm run local:bootstrap)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  return result.stdout;
}

runNode(['scripts/test/spec-compliance.mjs'], 'spec-compliance (items 1/5/6/7 + audit)');

console.log('BOT_FLOWS_OK');
