import { setupAccessKey, webhookSecretToken } from '../src/telegram/webhook-secret.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ ok:false, error:'GET only' }, {status:405});
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const accessKey = setupAccessKey();
    if (!TOKEN || !accessKey) return Response.json({ok:false,error:'Missing setup configuration'},{status:500});
    if (url.searchParams.get('key') !== accessKey) return Response.json({ok:false,error:'Unauthorized'},{status:401});
    const webhookUrl = `${url.origin}/api/telegram`;
    const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query'] };
    const secret = webhookSecretToken();
    if (secret) body.secret_token = secret;
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
    });
    const result = await r.json();
    return Response.json(result, {status: result.ok ? 200 : 500});
  }
};
