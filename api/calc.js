import { sql } from '../src/database/sql.js';
import { getInstallmentConfig, resolvedBotUsername } from '../src/bot/data.js';
import { calcPageHtml } from '../src/web/installment-calc.js';

export { calcPageHtml } from '../src/web/installment-calc.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get('listing'));
    if (!id) return new Response('listing required', { status: 400 });
    const q = sql();
    const rows = await q`SELECT * FROM listings WHERE id=${id} AND status='active' LIMIT 1`;
    if (!rows[0]) return new Response('آگهی پیدا نشد', { status: 404 });
    const config = await getInstallmentConfig(q);
    if (!config.salesEnabled) return new Response('فروش اقساطی موقتاً غیرفعال است.', { status: 403 });
    const html = calcPageHtml(rows[0], config, await resolvedBotUsername());
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  }
};
