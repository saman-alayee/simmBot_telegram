import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelMsgBodyFromMessage, messageBodyMeta, parseSetChannelMsg, parseSetChannelMsgMeta, sliceEntitiesForBody, utf16Length
} from '../src/telegram/telegram-text.js';
import { parseTelegramUpdate } from '../src/telegram/telegram-update.js';

test('parseSetChannelMsg supports multiline body after alias', () => {
  const parsed = parseSetChannelMsg('/setchannelmsg reserved\n🌀رزرو شد🌀');
  assert.equal(parsed.alias, 'reserved');
  assert.equal(parsed.body, '🌀رزرو شد🌀');
});

test('parseSetChannelMsg supports inline body', () => {
  const parsed = parseSetChannelMsg('/setchannelmsg sold ❌ فروش ❌');
  assert.equal(parsed.alias, 'sold');
  assert.equal(parsed.body, '❌ فروش ❌');
});

test('sliceEntitiesForBody keeps custom_emoji offsets relative to body', () => {
  const full = '/setchannelmsg reserved\n🌀رزرو شد🌀';
  const body = '🌀رزرو شد🌀';
  const entities = [{ type: 'custom_emoji', offset: utf16Length('/setchannelmsg reserved\n'), length: 2, custom_emoji_id: '123' }];
  const sliced = sliceEntitiesForBody(full, body, entities);
  assert.equal(sliced.length, 1);
  assert.equal(sliced[0].offset, 0);
  assert.equal(sliced[0].custom_emoji_id, '123');
});

test('parseTelegramUpdate keeps custom_emoji_id precision', () => {
  const raw = '{"message":{"text":"x","entities":[{"type":"custom_emoji","offset":0,"length":2,"custom_emoji_id":5447319402312814999}]}}';
  const update = parseTelegramUpdate(raw);
  assert.equal(update.message.entities[0].custom_emoji_id, '5447319402312814999');
});

test('messageBodyMeta + channelMsgBodyFromMessage for chanmsg session', () => {
  const full = '  🌀رزرو  ';
  const emojiOffset = 2;
  const message = {
    text: full,
    entities: [{ type: 'custom_emoji', offset: emojiOffset, length: 2, custom_emoji_id: '999888777666555444' }]
  };
  const meta = messageBodyMeta(message, full.trim());
  const { text: body, entities } = channelMsgBodyFromMessage(message, {
    body: meta.body,
    bodyRaw: meta.bodyRaw,
    bodyStartUtf16: meta.bodyStartUtf16
  });
  assert.equal(body, '🌀رزرو');
  assert.equal(entities.length, 1);
  assert.equal(entities[0].custom_emoji_id, '999888777666555444');
});

test('parseSetChannelMsgMeta + channelMsgBodyFromMessage inline custom emoji', () => {
  const full = '/setchannelmsg reserved رزرو شد 🌀';
  const meta = parseSetChannelMsgMeta(full);
  assert.equal(meta.body, 'رزرو شد 🌀');
  const emojiOffset = utf16Length('/setchannelmsg reserved رزرو شد ');
  const message = {
    text: full,
    entities: [{ type: 'custom_emoji', offset: emojiOffset, length: 2, custom_emoji_id: '5447319402312814999' }]
  };
  const { text: body, entities } = channelMsgBodyFromMessage(message, meta);
  assert.equal(body, 'رزرو شد 🌀');
  assert.equal(entities.length, 1);
  assert.equal(entities[0].custom_emoji_id, '5447319402312814999');
  assert.equal(entities[0].offset, utf16Length('رزرو شد '));
});
