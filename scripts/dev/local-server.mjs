import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const splitAt = trimmed.indexOf('=');
    if (splitAt < 1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    let value = trimmed.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

loadEnv('.env.local');

if (process.env.LOCAL_DEV === '1') {
  const { bootstrapLocalDatabase } = await import('./bootstrap-local.mjs');
  await bootstrapLocalDatabase();
}

const missing = ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'CHANNEL_ID', 'WEBHOOK_SECRET', 'OWNER_TELEGRAM_ID', 'CRON_SECRET', 'SETUP_KEY']
  .filter((key) => {
    const value = process.env[key];
    if (key === 'OWNER_TELEGRAM_ID' && String(value || '').toLowerCase() === 'auto') return false;
    return !value || value === '[SENSITIVE]';
  });
if (missing.includes('TELEGRAM_BOT_TOKEN') || missing.includes('DATABASE_URL')) {
  console.error('ربات روشن نشد. این مقدارها در .env.local واقعی نیستند و فقط [SENSITIVE] نوشته شده:');
  console.error(missing.join(', '));
  console.error('مقدار واقعی را از BotFather، Neon و داشبورد Vercel داخل .env.local بگذارید، بعد دوباره npm run local را اجرا کنید.');
  process.exit(1);
}

function windowsProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8' });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return '';
    const server = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1] || '';
    if (!server) return '';
    const picked = server.includes('=') ? (server.match(/https=([^;]+)/i)?.[1] || server.match(/http=([^;]+)/i)?.[1] || '') : server;
    if (!picked) return '';
    return picked.includes('://') ? picked : `http://${picked}`;
  } catch {
    return '';
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 300 });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const proxyUrl = process.env.LOCAL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || windowsProxy() || (await portOpen(2081) ? 'http://127.0.0.1:2081' : '');
if (proxyUrl && process.env.LOCAL_PROXY_READY !== '1') {
  console.log(proxyUrl.includes('@') ? 'درخواست‌های تلگرام از پراکسی محلی رد می‌شوند.' : `درخواست‌های تلگرام از ${proxyUrl} رد می‌شوند.`);
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      LOCAL_PROXY: proxyUrl,
      LOCAL_PROXY_READY: '1'
    }
  });
  await new Promise((resolve) => {
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', () => process.exit(1));
    void resolve;
  });
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || !process.env.DATABASE_URL) {
  console.error('TELEGRAM_BOT_TOKEN یا DATABASE_URL در .env.local نیست.');
  process.exit(1);
}

const [{ default: telegram }, { default: calc }, { default: cron }] = await Promise.all([
  import('../../api/telegram.js'),
  import('../../api/calc.js'),
  import('../../api/cron.js')
]);

const port = Number(process.env.LOCAL_PORT || 8787);
const publicOrigin = process.env.PUBLIC_BASE_URL || 'https://samisim0912bot-v2-1.vercel.app';

async function telegramApi(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const raw = await response.text();
  try {
    const { parseTelegramUpdate } = await import('../../src/telegram/telegram-update.js');
    return parseTelegramUpdate(raw);
  } catch {
    return JSON.parse(raw);
  }
}

function kindOf(update) {
  if (update.callback_query) return 'callback';
  if (update.message?.contact) return 'contact';
  if (update.message?.document) return 'document';
  if (update.message?.text) return 'message';
  return 'other';
}

let previousWebhook = '';
let offset = 0;
let stopped = false;

async function handleUpdate(update) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.WEBHOOK_SECRET) headers['x-telegram-bot-api-secret-token'] = process.env.WEBHOOK_SECRET;
  const request = new Request(`${publicOrigin}/api/telegram`, {
    method: 'POST',
    headers,
    body: JSON.stringify(update)
  });
  const response = await telegram.fetch(request);
  const text = await response.text();
  console.log(`${new Date().toLocaleTimeString('fa-IR')}  ${kindOf(update)}  ${response.status}${response.status === 200 ? '' : '  ' + text.slice(0, 180)}`);
}

async function poll() {
  while (!stopped) {
    try {
      const data = await telegramApi('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (!data.ok) {
        console.error('دریافت آپدیت ناموفق:', data.description || 'خطای تلگرام');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error('ارتباط با تلگرام قطع شد:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const handler = url.pathname === '/api/calc' ? calc : url.pathname === '/api/cron' ? cron : url.pathname === '/api/telegram' ? telegram : null;
  if (!handler) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ربات محلی روشن است. صفحه اقساط: /api/calc?listing=ID');
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
  });
  const response = await handler.fetch(request);
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(body);
});

async function restoreWebhook() {
  if (!previousWebhook) return;
  const body = { url: previousWebhook };
  if (process.env.WEBHOOK_SECRET) body.secret_token = process.env.WEBHOOK_SECRET;
  const result = await telegramApi('setWebhook', body);
  console.log(result.ok ? 'وبهوک قبلی برگردانده شد.' : 'برگرداندن وبهوک ناموفق بود.');
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  console.log('\nدر حال توقف و برگرداندن وبهوک...');
  server.close();
  await restoreWebhook();
  if (process.env.LOCAL_DEV === '1') {
    const { stopLocalPostgres } = await import('./local-pg.mjs');
    await stopLocalPostgres();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

let info;
try {
  info = await telegramApi('getWebhookInfo', {});
} catch (error) {
  console.error('تلگرام از این کامپیوتر در دسترس نیست.');
  console.error('Nekoray باز است ولی اتصال قطع است. داخل Nekoray پروفایل را Start کنید تا پورت 2081 بالا بیاید، بعد دوباره npm run local را بزنید.');
  console.error(error.cause?.code || error.message);
  process.exit(1);
}
if (!info.ok) {
  console.error('اتصال به تلگرام برقرار نشد:', info.description || 'بدون توضیح');
  process.exit(1);
}
previousWebhook = info.result?.url || '';
const removed = await telegramApi('deleteWebhook', { drop_pending_updates: false });
if (!removed.ok) {
  console.error('حالت محلی فعال نشد:', removed.description || 'بدون توضیح');
  process.exit(1);
}

const { syncDefaultBotCommands } = await import('../../src/bot/commands.js');
const cmdSync = await syncDefaultBotCommands((method, body) => telegramApi(method, body));
if (!cmdSync.ok) console.warn('setMyCommands:', cmdSync.description || 'ناموفق');

server.listen(port, '127.0.0.1', () => {
  console.log(`ربات محلی روشن است. در تلگرام /start بزنید.`);
  console.log(`صفحه اقساط محلی: http://127.0.0.1:${port}/api/calc?listing=ID`);
  const calcBase = process.env.PUBLIC_CALC_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  if (/127\.0\.0\.1|localhost/i.test(calcBase) && process.env.CHANNEL_ID) {
    console.log('توجه: لینک «خرید اقساطی» روی پست کانال از PUBLIC_BASE_URL ساخته می‌شود؛ روی موبایل localhost باز نمی‌شود. برای تست از تلفن، PUBLIC_CALC_BASE_URL را آدرس عمومی (ngrok / Vercel) بگذارید.');
  }
  console.log('تا وقتی این پنجره باز است، نسخه Vercel پیام نمی‌گیرد. با Ctrl+C وبهوک برمی‌گردد.');
  poll();
});
