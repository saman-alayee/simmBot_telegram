import { sql } from '../src/database/sql.js';
import { ensureSchema } from '../src/database/schema.js';
import { webhookSecretToken } from '../src/telegram/webhook-secret.js';

/** یک‌بار migrate Neon: GET /api/init?k=اولین-۱۲-کاراکتر-secret-مشتق-از-توکن */
export default {
  async fetch(request) {
    if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
    const secret = webhookSecretToken();
    if (!secret) return Response.json({ ok: false, error: 'No bot token' }, { status: 500 });
    const k = new URL(request.url).searchParams.get('k') || '';
    if (k !== secret.slice(0, 12)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    try {
      await ensureSchema(sql());
      return Response.json({ ok: true, migrated: true });
    } catch (error) {
      console.error(error);
      return Response.json({ ok: false, error: error?.message || 'migrate failed' }, { status: 500 });
    }
  }
};
