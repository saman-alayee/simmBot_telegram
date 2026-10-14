import { esc } from '../domain/format.js';
import { normalizeCustomEmojiEntity } from './telegram-update.js';

/** طول بر حسب UTF-16 code unit (همان offset/length در entities تلگرام — برابر `.length` در JS). */
export function utf16Length(str) {
  return String(str ?? '').length;
}

/** متن پیام کاربر + محل شروع body (برای ایموجی Pro بعد از trim). */
export function messageBodyMeta(message, trimmedBody = null) {
  const full = message?.text ?? message?.caption ?? '';
  const lead = full.search(/\S/);
  if (lead < 0) return { full, bodyRaw: '', bodyStartUtf16: 0, body: '' };
  const bodyRaw = full.slice(lead);
  const bodyStartUtf16 = utf16Length(full.slice(0, lead));
  const body = trimmedBody != null ? String(trimmedBody) : bodyRaw.trim();
  return { full, bodyRaw, bodyStartUtf16, body };
}

export function utf16IndexToJs(str, utf16Index) {
  const n = String(str ?? '').length;
  const i = Number(utf16Index);
  if (!Number.isFinite(i) || i <= 0) return 0;
  if (i >= n) return n;
  return i;
}

function customEmojiEntitiesInRange(fullText, bodyStartUtf16, bodyUtf16Len, entities) {
  if (!bodyUtf16Len || !entities?.length) return [];
  const endUtf16 = bodyStartUtf16 + bodyUtf16Len;
  return entities
    .map((e) => normalizeCustomEmojiEntity(e))
    .filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id != null)
    .filter((e) => e.offset < endUtf16 && e.offset + e.length > bodyStartUtf16)
    .map((e) => {
      const clipStart = Math.max(e.offset, bodyStartUtf16);
      const clipEnd = Math.min(e.offset + e.length, endUtf16);
      return {
        type: 'custom_emoji',
        offset: clipStart - bodyStartUtf16,
        length: clipEnd - clipStart,
        custom_emoji_id: String(e.custom_emoji_id)
      };
    })
    .filter((e) => e.length > 0);
}

export function sliceEntitiesForBody(fullText, bodyText, entities) {
  if (!bodyText || !entities?.length) return [];
  const pos = fullText.indexOf(bodyText);
  if (pos < 0) return [];
  const bodyStartUtf16 = utf16Length(fullText.slice(0, pos));
  return customEmojiEntitiesInRange(fullText, bodyStartUtf16, utf16Length(bodyText), entities);
}

/** trim متن ذخیره‌شده و جابه‌جایی offset ایموجی اختصاصی */
export function trimBodyAndEntities(text, entities) {
  const s = String(text ?? '');
  const lead = s.search(/\S/);
  if (lead < 0) return { text: '', entities: [] };
  const trailMatch = s.match(/\s*$/);
  const trail = trailMatch ? trailMatch[0].length : 0;
  const trimmed = s.slice(lead, trail ? s.length - trail : s.length);
  const leadUtf16 = utf16Length(s.slice(0, lead));
  const bodyUtf16 = utf16Length(trimmed);
  const endUtf16 = leadUtf16 + bodyUtf16;
  const rebased = customEmojiEntitiesInRange(s, leadUtf16, bodyUtf16, entities || []);
  return { text: trimmed, entities: rebased };
}

function messageEntityList(message) {
  return message?.entities || message?.caption_entities || [];
}

export function entitiesFromUserMessage(message, bodyText, bodyStartUtf16) {
  const full = message?.text ?? message?.caption ?? '';
  if (!bodyText) return [];
  const ents = messageEntityList(message);
  if (bodyStartUtf16 != null && Number.isFinite(bodyStartUtf16)) {
    return customEmojiEntitiesInRange(full, bodyStartUtf16, utf16Length(bodyText), ents);
  }
  const trimmedFull = full.trim();
  if (trimmedFull === bodyText) {
    const leadUtf16 = utf16Length(full.slice(0, full.search(/\S/)));
    return customEmojiEntitiesInRange(full, leadUtf16, utf16Length(bodyText), ents);
  }
  return sliceEntitiesForBody(full, bodyText, ents);
}

/**
 * /setchannelmsg alias متن
 * یا چندخط:
 * /setchannelmsg reserved
 * 🌀رزرو شد🌀
 */
export function parseSetChannelMsg(text) {
  const meta = parseSetChannelMsgMeta(text);
  if (!meta) return null;
  return { alias: meta.alias, body: meta.body };
}

/**
 * همان parseSetChannelMsg + محل دقیق body در متن اصلی (برای entities ایموجی Pro).
 * روی message.text بدون trim کردن offsetها اعمال می‌شود.
 */
export function parseSetChannelMsgMeta(text) {
  const raw = String(text ?? '');
  const lead = raw.search(/\S/);
  if (lead < 0) return null;
  const leadUtf16 = utf16Length(raw.slice(0, lead));
  const s = raw.slice(lead);
  if (!/^\/setchannelmsg(?:@\w+)?/i.test(s)) return null;

  const lines = s.split(/\r?\n/);
  const head = lines[0].match(/^\/setchannelmsg(?:@\w+)?\s+(\S+)(?:\s+(.*))?$/i);
  if (!head) return null;
  const alias = head[1];
  const inlineRest = head[2] || '';

  let bodyRaw;
  let bodyStartInS;
  if (lines.length === 1) {
    bodyStartInS = lines[0].length - inlineRest.length;
    bodyRaw = inlineRest;
  } else if (inlineRest.trim()) {
    bodyStartInS = lines[0].length - inlineRest.length;
    bodyRaw = [inlineRest, ...lines.slice(1)].join('\n');
  } else {
    const nlIdx = s.indexOf('\n');
    bodyStartInS = nlIdx >= 0 ? nlIdx + 1 : lines[0].length;
    bodyRaw = s.slice(bodyStartInS);
  }

  const { text: body } = trimBodyAndEntities(bodyRaw, []);
  if (!body) return null;

  const bodyStartUtf16 = leadUtf16 + utf16Length(s.slice(0, bodyStartInS));
  return { alias, body, bodyRaw, bodyStartUtf16 };
}

/** متن + entities ایموجی Pro از پیام کاربر (دستور /setchannelmsg یا فقط متن). */
export function channelMsgBodyFromMessage(message, meta) {
  const full = message?.text ?? message?.caption ?? '';
  const ents = messageEntityList(message);
  if (meta?.bodyRaw != null && meta.bodyStartUtf16 != null) {
    const sliced = customEmojiEntitiesInRange(
      full,
      meta.bodyStartUtf16,
      utf16Length(meta.bodyRaw),
      ents
    );
    return trimBodyAndEntities(meta.bodyRaw, sliced);
  }
  const bodyMeta = messageBodyMeta(message, meta?.body);
  if (bodyMeta.body) {
    const sliced = customEmojiEntitiesInRange(
      bodyMeta.full,
      bodyMeta.bodyStartUtf16,
      utf16Length(bodyMeta.bodyRaw),
      ents
    );
    return trimBodyAndEntities(bodyMeta.bodyRaw, sliced);
  }
  const bodyText = String(meta?.body ?? full).trim();
  const sliced = entitiesFromUserMessage(message, bodyText);
  return trimBodyAndEntities(bodyText, sliced);
}

/** HTML کانال: ایموجی اختصاصی تلگرام با tg-emoji */
export function channelMsgHtmlFragment(text, entities) {
  const str = String(text ?? '');
  const custom = (entities || [])
    .map((e) => normalizeCustomEmojiEntity(e))
    .filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id)
    .sort((a, b) => a.offset - b.offset);
  if (!custom.length) return esc(str);
  let out = '';
  let lastJs = 0;
  for (const ent of custom) {
    const startJs = utf16IndexToJs(str, ent.offset);
    const endJs = utf16IndexToJs(str, ent.offset + ent.length);
    out += esc(str.slice(lastJs, startJs));
    const id = String(ent.custom_emoji_id).replace(/\D/g, '');
    out += `<tg-emoji emoji-id="${id}">${esc(str.slice(startJs, endJs))}</tg-emoji>`;
    lastJs = endJs;
  }
  out += esc(str.slice(lastJs));
  return out;
}

export function sendMessagePayload(text, entities) {
  const payload = { text: String(text ?? '') };
  const custom = (entities || [])
    .map((e) => normalizeCustomEmojiEntity(e))
    .filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id);
  if (custom.length) payload.entities = custom;
  return payload;
}
