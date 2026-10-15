import fs from 'node:fs';
import path from 'node:path';
import { sql } from '../src/database/sql.js';
import { syncDefaultBotCommands } from '../src/bot/commands.js';
import { ensureSchema } from '../src/database/schema.js';
import { handleUpdate, tg } from '../src/bot/router.js';
import { normalizeTelegramUpdate, parseTelegramUpdate } from '../src/telegram/telegram-update.js';
import { webhookSecretCandidates } from '../src/telegram/webhook-secret.js';

let defaultCommandsSynced = false;
async function ensureDefaultBotCommands() {
  if (defaultCommandsSynced) return;
  defaultCommandsSynced = true;
  try {
    const result = await syncDefaultBotCommands(tg);
    if (!result?.ok) console.warn('setMyCommands (default):', result?.description);
  } catch (error) {
    console.warn('setMyCommands (default) failed:', error.message);
  }
}

const schemaReadyMarker = path.join(process.cwd(), '.local', '.schema-ready');

async function prepareDb(q) {
  if (process.env.LOCAL_PG === '1' && fs.existsSync(schemaReadyMarker)) {
    try {
      const rows = await q.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'listings' LIMIT 1`
      );
      if (rows?.length) return;
    } catch {
      /* re-run schema after local DB wipe */
    }
  }
  await ensureSchema(q);
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response('OK');
    const incoming = request.headers.get('x-telegram-bot-api-secret-token') || '';
    const allowedSecrets = webhookSecretCandidates();
    if (incoming && allowedSecrets.size && !allowedSecrets.has(incoming)) {
      return new Response('Unauthorized', { status: 401 });
    }
    let update;
    try {
      const raw = await request.text();
      update = normalizeTelegramUpdate(parseTelegramUpdate(raw));
    } catch { return Response.json({ ok: true }); }
    try {
      const q = sql();
      await prepareDb(q);
      await ensureDefaultBotCommands();
      await handleUpdate({ q, request, update });
      return Response.json({ ok: true });
    } catch (error) {
      console.error(error);
      const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
      if (chatId) {
        try {
          const hint = String(error?.message || 'خطای ناشناخته').slice(0, 180);
          await tg('sendMessage', {
            chat_id: chatId,
            text: `⚠️ خطای سرور (دیتابیس یا env).\n${hint}\n\nDATABASE_URL روی Vercel را با Neon جدید چک کنید.`
          });
        } catch { /* ignore */ }
      }
      return Response.json({ ok: true });
    }
  }
};
