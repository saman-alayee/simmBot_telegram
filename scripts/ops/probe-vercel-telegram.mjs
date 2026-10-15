/**
 * شبیه‌سازی آپدیت /start به Vercel و بررسی webhook
 */
import fs from 'node:fs';
import { setupAccessKeyDerived } from '../../src/telegram/webhook-secret.js';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim();
  }
}

loadEnv('.env.local');
const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerUid = Number(process.env.OWNER_TELEGRAM_ID || 47314155);
const url = 'https://simmbottelegram-eta.vercel.app/api/telegram';

const update = {
  update_id: 900000001,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: ownerUid, type: 'private' },
    from: { id: ownerUid, is_bot: false, first_name: 'Probe' },
    text: '/start'
  }
};

const r = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(update)
});
const body = await r.text();
console.log('POST /api/telegram', r.status, body.slice(0, 200));

const wh = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then((x) => x.json());
console.log('webhook_last_error', wh.result?.last_error_message || null);
console.log('webhook_pending', wh.result?.pending_update_count);

const setupKey = setupAccessKeyDerived();
if (setupKey) {
  const setup = await fetch(`https://simmbottelegram-eta.vercel.app/api/setup?key=${encodeURIComponent(setupKey)}`);
  console.log('GET /api/setup', setup.status, (await setup.text()).slice(0, 120));
}
