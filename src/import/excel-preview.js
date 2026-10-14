import { excelTarget } from '../domain/logic.js';
import { openListingByPhone, ownerIdByName, warehouseIdByName } from '../bot/data.js';

/**
 * @param {import('../database/sql.js').Sql} q
 * @param {Array<{ phone: string, ownerName?: string|null, warehouseName?: string|null, excelRow?: number }>} ads
 */
export async function validateExcelAds(q, ads) {
  let createCount = 0;
  let updateCount = 0;
  const missingOwners = new Set();
  const missingWarehouses = new Set();
  for (const ad of ads) {
    if (ad.ownerName) {
      const id = await ownerIdByName(q, ad.ownerName);
      if (!id) missingOwners.add(ad.ownerName);
    }
    if (ad.warehouseName) {
      const id = await warehouseIdByName(q, ad.warehouseName);
      if (!id) missingWarehouses.add(ad.warehouseName);
    }
    const open = await openListingByPhone(q, ad.phone);
    if (excelTarget(open).action === 'create') createCount += 1;
    else updateCount += 1;
  }
  return { createCount, updateCount, missingOwners, missingWarehouses };
}

export function formatExcelPreviewMessage(analysis, validation) {
  const dupLines = analysis.duplicatePhones.slice(0, 6).map(
    (d) => `  · ${d.phone} — ${d.count} بار (ردیف ${d.rows.join('، ')})`
  );
  const invalidLines = analysis.invalidRows.slice(0, 8).map(
    (r) => `  · ردیف ${r.row}${r.reason ? `: ${r.reason}` : ''}`
  );
  const lines = [
    'پیش‌نمایش ورود اکسل',
    '',
    `ردیف‌های برگه (بدون سطر عنوان): ${analysis.sheetRowCount}`,
    `قابل ثبت: ${analysis.ads.length}`,
    `ردیف نامعتبر: ${analysis.invalidRows.length}`,
    analysis.duplicatePhones.length
      ? `تکراری در فایل (آخرین ردیف برای هر شماره): ${analysis.duplicatePhones.length} شماره`
      : 'تکراری در فایل: ندارد',
    ...dupLines,
    '',
    `ثبت جدید: ${validation.createCount}`,
    `به‌روزرسانی خط باز: ${validation.updateCount}`
  ];
  if (validation.missingOwners.size) {
    lines.push('', `مالک پیدا نشد: ${[...validation.missingOwners].slice(0, 6).join(' · ')}`);
  }
  if (validation.missingWarehouses.size) {
    lines.push('', `انبار پیدا نشد: ${[...validation.missingWarehouses].slice(0, 6).join(' · ')}`);
  }
  if (invalidLines.length) {
    lines.push('', 'نمونه ردیف‌های نامعتبر:', ...invalidLines);
  }
  lines.push(
    '',
    'بعد از «تأیید و ثبت»، همهٔ ردیف‌های معتبر یک‌جا در دیتابیس ذخیره می‌شوند.',
    'انتشار در کانال ممکن است در چند مرحله (بدون ارسال مجدد فایل) انجام شود.'
  );
  return lines.join('\n').slice(0, 3900);
}
