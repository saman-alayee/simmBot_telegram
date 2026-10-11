import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLookupName, parseDateInput } from '../src/domain/format.js';
import { parseExcelAd } from '../src/domain/logic.js';
import { buildListingsExcelTemplateBuffer, listingAdsFromExcelBuffer } from '../src/import/excel-import.js';

test('parseExcelAd accepts document date column', () => {
  const ad = parseExcelAd({
    'سیم‌کارت': '09121572758',
    'قیمت': '580000000',
    'وضعیت': 'کارکرده',
    'تاریخ سند': '1405/07/25'
  });
  assert.equal(ad?.phone, '09121572758');
  assert.equal(ad?.documentDate, parseDateInput('1405/07/25'));
  assert.equal(parseExcelAd({ 'سیم‌کارت': '09121572758', 'قیمت': '100', 'تاریخ سند': 'invalid' }), null);
});

test('normalizeLookupName matches Arabic/Persian yeh and kaf', () => {
  assert.equal(normalizeLookupName('ارين اسلامى'), normalizeLookupName('ارین اسلامی'));
  assert.equal(normalizeLookupName('پوريا'), normalizeLookupName('پوریا'));
  assert.equal(normalizeLookupName('مالك تست'), normalizeLookupName('مالک تست'));
});

test('bundled excel template parses sample rows', () => {
  const ads = listingAdsFromExcelBuffer(buildListingsExcelTemplateBuffer());
  assert.equal(ads.length, 2);
  assert.equal(ads[0].phone, '09121572758');
  assert.equal(ads[0].price, 580000000);
  assert.equal(ads[0].documentDate, parseDateInput('1405/07/25'));
  assert.equal(ads[1].phone, '09124561595');
});
