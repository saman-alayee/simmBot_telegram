import {
  getInstallmentConfig, ownerIdByName, publicOrigin, putSetting, saveListing, settingValue, warehouseIdByName
} from '../bot/data.js';
import { runExcelChannelQueue, saveExcelChannelQueue } from './excel-channel-queue.js';

export function excelPendingKey(uid) {
  return `excel_pending:${uid}`;
}

export function excelRunBudgetMs() {
  const fromEnv = Number(process.env.EXCEL_RUN_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 5000) return Math.min(fromEnv, 28000);
  return 28000;
}

export async function saveExcelPending(q, uid, payload) {
  await putSetting(q, excelPendingKey(uid), JSON.stringify(payload));
}

export async function loadExcelPending(q, uid) {
  const text = await settingValue(q, excelPendingKey(uid), '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function clearExcelPending(q, uid) {
  await q`DELETE FROM settings WHERE key = ${excelPendingKey(uid)}`;
}

/**
 * @param {import('../database/sql.js').Sql} q
 */
export async function executeExcelImport(q, request, tg, actor, chatId, ads, { label = '', channelBudgetMs = 6000 } = {}) {
  let created = 0;
  let updated = 0;
  let failed = 0;
  let ownerFull = 0;
  const missingOwners = new Set();
  const missingWarehouses = new Set();
  const listingIds = [];

  for (const ad of ads) {
    try {
      let ownerId;
      let warehouseId;
      if (ad.ownerName) {
        ownerId = await ownerIdByName(q, ad.ownerName);
        if (!ownerId) {
          missingOwners.add(ad.ownerName);
          throw new Error('OWNER_MISSING');
        }
      }
      if (ad.warehouseName) {
        warehouseId = await warehouseIdByName(q, ad.warehouseName);
        if (!warehouseId) {
          missingWarehouses.add(ad.warehouseName);
          throw new Error('WAREHOUSE_MISSING');
        }
      }
      const saved = await saveListing(q, {
        phone: ad.phone,
        displayPhone: ad.displayPhone,
        price: ad.price,
        condition: ad.condition,
        ownerId,
        warehouseId,
        date: ad.documentDate ?? undefined,
        by: actor.uid
      });
      listingIds.push(saved.row.id);
      if (saved.mode === 'create') created += 1;
      else updated += 1;
    } catch (error) {
      failed += 1;
      if (error?.message === 'OWNER_FULL') ownerFull += 1;
      console.error('excel row failed', ad?.phone, error?.message || error);
    }
  }

  await saveExcelChannelQueue(q, actor.uid, {
    listingIds,
    next: 0,
    chatId,
    label
  });

  const installmentConfig = await getInstallmentConfig(q).catch(() => null);
  const channelPass = await runExcelChannelQueue(q, tg, actor.uid, {
    deadlineMs: channelBudgetMs,
    origin: publicOrigin(request),
    installmentConfig
  });

  return {
    created,
    updated,
    failed,
    ownerFull,
    missingOwners,
    missingWarehouses,
    dbTotal: ads.length,
    listingIds,
    channelPass
  };
}

export function formatExcelImportSummary(result) {
  const {
    created, updated, failed, ownerFull, missingOwners, missingWarehouses, dbTotal, channelPass, listingIds
  } = result;
  const ownerHint = missingOwners.size
    ? `مالک پیدا نشد:\n${[...missingOwners].slice(0, 8).join(' · ')}`
    : '';
  const whHint = missingWarehouses.size
    ? `انبار پیدا نشد:\n${[...missingWarehouses].slice(0, 8).join(' · ')}`
    : '';
  const channelHint = channelPass.miss && channelPass.lastError
    ? `علت کانال: ${channelPass.lastError}`
    : '';
  const total = listingIds.length;
  const channelLine = channelPass.done
    ? `کانال — منتشر/به‌روز: ${channelPass.ok} · منتشر نشد: ${channelPass.miss} (${total}/${total} خط)`
    : `کانال — تا ردیف ${channelPass.processedThrough}/${total} · این مرحله OK: ${channelPass.ok} · ناموفق: ${channelPass.miss}`;

  const lines = [
    'ثبت دیتابیس تمام شد.',
    `ردیف‌های معتبر: ${dbTotal}`,
    `ثبت جدید: ${created}`,
    `به‌روزرسانی خط باز: ${updated}`,
    `خطا: ${failed}${ownerFull ? ` (شامل ${ownerFull} سقف مالک)` : ''}`,
    channelLine,
    channelHint,
    ownerHint,
    whHint,
    channelPass.done ? '' : 'برای ادامهٔ انتشار کانال (بدون ارسال مجدد فایل) «ادامه انتشار کانال» را بزنید.'
  ].filter(Boolean);
  return lines.join('\n').slice(0, 3500);
}

export function formatExcelChannelContinueSummary(channelPass) {
  const channelHint = channelPass.miss && channelPass.lastError
    ? `علت کانال: ${channelPass.lastError}`
    : '';
  const total = channelPass.total || 0;
  const lines = [
    channelPass.done ? 'انتشار کانال تمام شد.' : 'بخشی از کانال به‌روز شد.',
    channelPass.done
      ? `کانال — OK: ${channelPass.ok} · ناموفق: ${channelPass.miss} (${total}/${total})`
      : `کانال — پیشرفت: ${channelPass.processedThrough}/${total} · این مرحله OK: ${channelPass.ok}`,
    channelHint,
    channelPass.done ? '' : 'دوباره «ادامه انتشار کانال» را بزنید.'
  ].filter(Boolean);
  return lines.join('\n').slice(0, 3500);
}
