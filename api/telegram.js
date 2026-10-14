import fs from 'node:fs';
import path from 'node:path';
import { sql } from '../src/database/sql.js';
import { syncDefaultBotCommands } from '../src/bot/commands.js';
import { ensureSchema } from '../src/database/schema.js';
import { handleUpdate, tg } from '../src/bot/router.js';
import { normalizeTelegramUpdate, parseTelegramUpdate } from '../src/telegram/telegram-update.js';

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
  if (process.env.LOCAL_PG === '1' && fs.existsSync(schemaReadyMarker)) return;
  await ensureSchema(q);
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response('OK');
    if (process.env.WEBHOOK_SECRET && request.headers.get('x-telegram-bot-api-secret-token') !== process.env.WEBHOOK_SECRET) {
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
      return Response.json({ ok: true });
    }
  }
};
