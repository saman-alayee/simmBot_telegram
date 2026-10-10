import * as XLSX from 'xlsx';
import { parseExcelAd } from '../domain/logic.js';

export const LISTINGS_EXCEL_TEMPLATE = 'templates/listings-import-template.xlsx';

export function listingAdsFromExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames.find((name) => name === 'خطوط') || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true });
  const ads = rows.map(parseExcelAd).filter(Boolean);
  return [...new Map(ads.map((ad) => [ad.phone, ad])).values()];
}
