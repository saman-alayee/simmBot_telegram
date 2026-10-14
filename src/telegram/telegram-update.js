/**
 * Webhook JSON must keep custom_emoji_id as string — IDs exceed Number.MAX_SAFE_INTEGER
 * and request.json() / JSON.parse corrupt them (Premium emoji then shows as normal fallback).
 */
const CUSTOM_EMOJI_ID_JSON = /"custom_emoji_id"\s*:\s*(\d+)/g;

export function parseTelegramUpdate(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  const safe = text.replace(CUSTOM_EMOJI_ID_JSON, '"custom_emoji_id":"$1"');
  return JSON.parse(safe);
}

export function normalizeCustomEmojiEntity(ent) {
  if (!ent || ent.type !== 'custom_emoji' || ent.custom_emoji_id == null) return ent;
  return { ...ent, custom_emoji_id: String(ent.custom_emoji_id) };
}

export function normalizeMessageCustomEmoji(message) {
  if (!message) return message;
  for (const key of ['entities', 'caption_entities']) {
    const list = message[key];
    if (!Array.isArray(list) || !list.length) continue;
    message[key] = list.map((e) => normalizeCustomEmojiEntity(e));
  }
  return message;
}

export function normalizeTelegramUpdate(update) {
  if (!update || typeof update !== 'object') return update;
  normalizeMessageCustomEmoji(update.message);
  normalizeMessageCustomEmoji(update.edited_message);
  normalizeMessageCustomEmoji(update.channel_post);
  normalizeMessageCustomEmoji(update.callback_query?.message);
  return update;
}
