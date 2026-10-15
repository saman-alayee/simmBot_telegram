/**
 * تعمیر پروداکشن: migrate DB via cron + setup + webhook
 */
import fs from 'node:fs';
import { setupAccessKey, setupAccessKeyDerived, webhookSecretToken } from '../../src/telegram/webhook-secret.js';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

loadEnv('.env.local');

const origin = 'https://simmbottelegram-eta.vercel.app';
const token = process.env.TELEGRAM_BOT_TOKEN;

async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

const log = [];

const secret = webhookSecretToken();
if (secret) {
  const init = await fetch(`${origin}/api/init?k=${encodeURIComponent(secret.slice(0, 12))}`);
  log.push({ step: 'init_migrate', status: init.status, body: (await init.text()).slice(0, 300) });
}

if (process.env.CRON_SECRET) {
  const cron = await fetch(`${origin}/api/cron`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
  });
  const cronBody = await cron.text();
  log.push({ step: 'cron_migrate', status: cron.status, body: cronBody.slice(0, 300) });
}

const setupKeys = [...new Set([
  setupAccessKeyDerived(),
  setupAccessKey(),
  'local-dev-setup-key'
].filter(Boolean))];

for (const key of setupKeys) {
  const setup = await fetch(`${origin}/api/setup?key=${encodeURIComponent(key)}`);
  const body = await setup.text();
  log.push({ step: 'setup', keyKind: key === setupAccessKeyDerived() ? 'derived' : 'other', status: setup.status, body: body.slice(0, 300) });
  if (setup.status === 200) break;
}

await tg('setWebhook', {
  url: `${origin}/api/telegram`,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false
});
log.push({ step: 'setWebhook', ...(await tg('getWebhookInfo')) });

console.log(JSON.stringify(log, null, 2));
