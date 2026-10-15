import { sql } from '../src/database/sql.js';
import { ensureSchema } from '../src/database/schema.js';
import { isValidSetupKey } from '../src/telegram/webhook-secret.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const key = url.searchParams.get('key');
    if (!TOKEN) return Response.json({ ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' }, { status: 500 });
    if (!isValidSetupKey(key)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    let schema = { ok: true };
    try {
      await ensureSchema(sql());
    } catch (error) {
      schema = { ok: false, error: error?.message || 'schema failed' };
    }

    const webhookUrl = `${url.origin}/api/telegram`;
    const body = {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    };
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const webhook = await r.json();
    const ok = schema.ok && webhook.ok;
    return Response.json({ ok, schema, webhook }, { status: ok ? 200 : 500 });
  }
};
