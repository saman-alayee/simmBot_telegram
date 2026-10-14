import { listingById, publicOrigin, putSetting, settingValue, syncChannel } from '../bot/data.js';

export function excelChannelQueueKey(uid) {
  return `excel_ch_queue:${uid}`;
}

export async function loadExcelChannelQueue(q, uid) {
  const raw = await settingValue(q, excelChannelQueueKey(uid), '');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.listingIds)) return null;
    return {
      listingIds: data.listingIds.map(Number).filter((id) => id > 0),
      next: Math.max(0, Number(data.next) || 0),
      chatId: data.chatId ?? null,
      label: data.label || ''
    };
  } catch {
    return null;
  }
}

export async function saveExcelChannelQueue(q, uid, queue) {
  if (!queue?.listingIds?.length) {
    await q`DELETE FROM settings WHERE key = ${excelChannelQueueKey(uid)}`;
    return;
  }
  await putSetting(q, excelChannelQueueKey(uid), JSON.stringify({
    listingIds: queue.listingIds,
    next: queue.next,
    chatId: queue.chatId,
    label: queue.label || ''
  }));
}

/**
 * @returns {{ synced: number, ok: number, miss: number, done: boolean, lastError: string }}
 */
export async function runExcelChannelQueue(q, tg, uid, { deadlineMs = 25_000, origin = null, installmentConfig = null } = {}) {
  const queue = await loadExcelChannelQueue(q, uid);
  if (!queue || queue.next >= queue.listingIds.length) {
    if (queue) await saveExcelChannelQueue(q, uid, null);
    return { synced: 0, ok: 0, miss: 0, done: true, lastError: '', total: 0, processedThrough: 0 };
  }
  const deadline = Date.now() + deadlineMs;
  let ok = 0;
  let miss = 0;
  let lastError = '';
  let index = queue.next;
  const baseOrigin = origin ?? publicOrigin();
  for (; index < queue.listingIds.length; index += 1) {
    if (Date.now() >= deadline) break;
    const listingId = queue.listingIds[index];
    const fresh = await listingById(q, listingId);
    if (!fresh) continue;
    let sent = await syncChannel(q, tg, fresh, baseOrigin, installmentConfig);
    const retryAfter = Number(sent?.parameters?.retry_after || 0);
    if (!sent?.ok && retryAfter > 0) {
      const waitMs = Math.min(retryAfter * 1000, Math.max(0, deadline - Date.now() - 500));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        sent = await syncChannel(q, tg, fresh, baseOrigin, installmentConfig);
      }
    }
    const published = sent?.ok || /not modified/i.test(String(sent?.description || ''));
    if (published) ok += 1;
    else {
      miss += 1;
      lastError = String(sent?.description || sent?.error_code || 'unknown');
    }
  }
  const done = index >= queue.listingIds.length;
  if (done) await saveExcelChannelQueue(q, uid, null);
  else await saveExcelChannelQueue(q, uid, { ...queue, next: index });
  return {
    synced: index - queue.next,
    ok,
    miss,
    done,
    lastError,
    total: queue.listingIds.length,
    processedThrough: index
  };
}
