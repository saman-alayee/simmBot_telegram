import { sql } from '../src/database/sql.js';
import { getInstallmentConfig } from '../src/bot/data.js';
import { botLinkUsername } from '../src/domain/format.js';
import { calcPageHtml } from '../src/web/installment-calc.js';

export { calcPageHtml } from '../src/web/installment-calc.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get('listing'));
    if (!id) return new Response('listing required', { status: 400 });
    const q = sql();
    const rows = await q`SELECT * FROM listings WHERE id=${id} AND status IN ('active', 'ready_transfer') LIMIT 1`;
    if (!rows[0]) return new Response('آگهی پیدا نشد', { status: 404 });
    const config = await getInstallmentConfig(q);
    if (!config.salesEnabled) return new Response('فروش اقساطی موقتاً غیرفعال است.', { status: 403 });
    let bot = botLinkUsername(process.env.BOT_USERNAME || 'SamiSIM0912Bot');
    try {
      const me = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
      const body = await me.json();
      if (body?.ok && body.result?.username) bot = botLinkUsername(body.result.username);
    } catch { /* keep env fallback */ }
    const html = calcPageHtml(rows[0], config, bot);
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  }
};
