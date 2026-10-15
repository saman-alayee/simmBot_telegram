import { createHash } from 'node:crypto';

/** Secret ثابت وابسته به توکن — روی Vercel و لوکال یکسان است */
export function webhookSecretToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return '';
  return createHash('sha256').update(`simmbot-webhook-v1:${token}`).digest('hex').slice(0, 32);
}

/** هر secret معتبر (مشتق + env قدیمی Vercel) */
export function webhookSecretCandidates() {
  const set = new Set();
  const derived = webhookSecretToken();
  if (derived) set.add(derived);
  const explicit = String(process.env.WEBHOOK_SECRET || '').trim();
  if (explicit && explicit !== '[SENSITIVE]') set.add(explicit);
  return set;
}

/** کلید setup — اگر SETUP_KEY در env نباشد از توکن مشتق می‌شود */
export function setupAccessKey() {
  const explicit = String(process.env.SETUP_KEY || '').trim();
  if (explicit && explicit !== '[SENSITIVE]') return explicit;
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return '';
  return createHash('sha256').update(`simmbot-setup-v1:${token}`).digest('hex').slice(0, 24);
}
