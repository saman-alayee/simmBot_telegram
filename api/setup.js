export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ ok:false, error:'GET only' }, {status:405});
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const SETUP_KEY = process.env.SETUP_KEY;
    if (!TOKEN || !SETUP_KEY) return Response.json({ok:false,error:'Missing setup configuration'},{status:500});
    if (url.searchParams.get('key') !== SETUP_KEY) return Response.json({ok:false,error:'Unauthorized'},{status:401});
    const webhookUrl = `${url.origin}/api/telegram`;
    const body = { url: webhookUrl };
    if (process.env.WEBHOOK_SECRET) body.secret_token = process.env.WEBHOOK_SECRET;
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
    });
    const result = await r.json();
    return Response.json(result, {status: result.ok ? 200 : 500});
  }
};
