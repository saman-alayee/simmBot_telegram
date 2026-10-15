import fs from 'node:fs';
import { isValidSetupKey, setupAccessKeyDerived, webhookSecretToken } from '../../src/telegram/webhook-secret.js';

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

loadEnv('.env.local');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}

async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

const me = await tg('getMe');
const wh = await tg('getWebhookInfo');
let localUp = false;
try {
  const r = await fetch('http://127.0.0.1:8787/', { signal: AbortSignal.timeout(2000) });
  localUp = r.ok;
} catch {
  localUp = false;
}

let dbHost = 'missing';
try {
  dbHost = new URL(String(process.env.DATABASE_URL).replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
} catch {
  dbHost = 'invalid';
}

const webhookUrl = wh.result?.url || '';
const diagnosis = {
  bot_ok: me.ok,
  bot_username: me.result?.username,
  webhook_url: webhookUrl || '(empty — no Vercel delivery)',
  webhook_pending: wh.result?.pending_update_count ?? 0,
  webhook_last_error: wh.result?.last_error_message || null,
  local_server_8787: localUp,
  database_host: dbHost,
  local_pg_env: process.env.LOCAL_PG || '0',
  public_base_url: process.env.PUBLIC_BASE_URL || '(unset)'
};

console.log(JSON.stringify(diagnosis, null, 2));

if (!webhookUrl && !localUp) {
  console.log('\nLIKELY_CAUSE: Webhook deleted and local polling not running — bot receives nothing.');
  console.log('FIX: npm run local  OR  open https://YOUR-VERCEL-DOMAIN/api/setup?key=SETUP_KEY');
} else if (webhookUrl && localUp) {
  console.log('\nLIKELY_CAUSE: Local server deleted webhook but Vercel URL not active — use Ctrl+C on local to restore webhook.');
} else if (webhookUrl && wh.result?.last_error_message) {
  console.log('\nLIKELY_CAUSE: Webhook errors — check Vercel logs and DATABASE_URL on Vercel.');
}

const vercelUrl = webhookUrl.includes('vercel.app') ? webhookUrl : 'https://simmbottelegram-eta.vercel.app/api/telegram';
try {
  const noSecret = await fetch(vercelUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const secret = webhookSecretToken();
  const withSecret = secret
    ? await fetch(vercelUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secret
      },
      body: JSON.stringify({ update_id: 999999999, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Diag' }, text: '/start' } })
    })
    : null;
  console.log('\nVERCEL_PROBE no_secret_status:', noSecret.status);
  if (withSecret) {
    const body = await withSecret.text();
    console.log('VERCEL_PROBE with_local_secret_status:', withSecret.status, body.slice(0, 120));
    if (withSecret.status === 401) {
      console.log('LIKELY_CAUSE: Production not deployed yet or old WEBHOOK_SECRET check — push latest code and run --fix-webhook.');
    }
  }
} catch (error) {
  console.log('\nVERCEL_PROBE failed:', error.message);
}

if (process.argv.includes('--fix-webhook')) {
  const setupKey = setupAccessKeyDerived();
  const origin = webhookUrl.replace(/\/api\/telegram\/?$/, '') || 'https://simmbottelegram-eta.vercel.app';
  if (setupKey) {
    const fix = await fetch(`${origin}/api/setup?key=${encodeURIComponent(setupKey)}`);
    const json = await fix.json().catch(() => ({}));
    console.log('\nSETUP_RESULT', fix.status, JSON.stringify(json));
  }
  const body = { url: `${origin}/api/telegram`, allowed_updates: ['message', 'callback_query'] };
  if (process.argv.includes('--with-secret')) {
    const derived = webhookSecretToken();
    if (derived) body.secret_token = derived;
  }
  const set = await tg('setWebhook', body);
  console.log('SET_WEBHOOK_LOCAL_ENV', JSON.stringify(set));
  if (set.ok) {
    const wh2 = await tg('getWebhookInfo');
    console.log('webhook_after', wh2.result?.url);
  }
}
