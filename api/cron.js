import { sql } from '../src/database/sql.js';
import { ensureSchema } from '../src/database/schema.js';
import { runJobs } from '../src/bot/jobs.js';

export default {
  async fetch(request) {
    if (process.env.CRON_SECRET && request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      const q = sql();
      await ensureSchema(q);
      const result = await runJobs(q);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      console.error(error);
      return Response.json({ ok: false }, { status: 500 });
    }
  }
};
