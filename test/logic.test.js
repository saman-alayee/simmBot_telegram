import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allow, canAssignOwner, canReleaseReservation, capacityLabel, excelTarget, invoiceDiscount, invoiceMath,
  isReservationExpired, nextInvoiceNumber, parseExcelAd, parseOwnerSlot, parseStartPayload,
  listingListPriceToman, parseManualDiscountInput, PERMISSIONS, prefixRank, registrationPlan, reserveAllowed, saleAllowed, shouldApplySpecialSale,
  shouldCleanupSoldChannel, sortListings,   priceAfterPercentIncrease, specialPrice, validNationalId
} from '../src/domain/logic.js';
import { channelDocumentReadyLine, displayJalali, isDocumentReadyDue, normalizePhone, parseDateInput, parseListingText, toLatinDigits } from '../src/domain/format.js';
import { buildInstallmentConfig, parseNumberList } from '../src/domain/installment-config.js';
import { channelText } from '../src/channel/channel.js';
import { calcPageHtml } from '../api/calc.js';

const day = 24 * 60 * 60 * 1000;

test('installment config parses custom month and percent lists', () => {
  assert.deepEqual(parseNumberList('2, 3, 4'), [2, 3, 4]);
  const cfg = buildInstallmentConfig({ monthOptions: '3 6 12', percentOptions: '25,50,75', interest: 4, roundToman: 100000 });
  assert.deepEqual(cfg.monthOptions, [3, 6, 12]);
  assert.deepEqual(cfg.percentOptions, [25, 50, 75]);
  assert.equal(cfg.interestPercentMonthly, 4);
  assert.equal(cfg.roundToman, 100000);
});

test('percent price increase rounds to whole millions', () => {
  assert.equal(priceAfterPercentIncrease(580_000_000, 5), 609_000_000);
  assert.equal(priceAfterPercentIncrease(500_000_000, 10), 550_000_000);
  assert.equal(priceAfterPercentIncrease(100_000_000, 0), null);
});

test('persian labels stay readable', () => {
  assert.equal(PERMISSIONS.add_listing, 'ثبت سیم‌کارت');
  assert.equal(PERMISSIONS.invoices, 'فاکتور');
});

test('permission is enforced for direct commands', () => {
  assert.equal(allow(2, 1, { lookup: true, invoices: false }, 'lookup'), true);
  assert.equal(allow(2, 1, { lookup: true }, 'invoices'), false);
  assert.equal(allow(1, 1, {}, 'invoices'), true);
});

test('registration keeps sold history by opening a new cycle', () => {
  assert.equal(registrationPlan(null), 'create');
  assert.equal(registrationPlan({ id: 4, status: 'active' }), 'update');
  assert.equal(excelTarget(null).action, 'create');
  assert.equal(excelTarget({ id: 9, status: 'active' }).action, 'update');
});

test('owner capacity counts open lines and blocks a full owner', () => {
  assert.equal(capacityLabel(7, 10), '7/10');
  assert.equal(canAssignOwner({ used: 7, max: 10, alreadyOnThisOwner: false }), true);
  assert.equal(canAssignOwner({ used: 10, max: 10, alreadyOnThisOwner: false }), false);
  assert.equal(canAssignOwner({ used: 10, max: 10, alreadyOnThisOwner: true }), true);
  assert.deepEqual(parseOwnerSlot('/setownerslot 4 20'), { id: 4, slots: 20 });
  assert.equal(parseOwnerSlot('/setownerslot 4 -1'), null);
});

test('only reserver or bot owner can release a reservation', () => {
  const listing = { status: 'reserved', reserved_by: 47314155 };
  assert.equal(canReleaseReservation(listing, 47314155, false), true);
  assert.equal(canReleaseReservation(listing, 999, false), false);
  assert.equal(canReleaseReservation(listing, 999, true), true);
  assert.equal(canReleaseReservation({ status: 'active', reserved_by: null }, 47314155, false), false);
});

test('reserve lasts one hour and only an active line can be reserved', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  assert.equal(reserveAllowed('active'), true);
  assert.equal(reserveAllowed('reserved'), false);
  assert.equal(reserveAllowed('sold'), false);
  assert.equal(isReservationExpired(new Date(now.getTime() + 60 * 60 * 1000 - 1), now), false);
  assert.equal(isReservationExpired(new Date(now.getTime() - 1), now), true);
});

test('sale is allowed from active, reserved, and ready-transfer lines', () => {
  assert.equal(saleAllowed('active'), true);
  assert.equal(saleAllowed('reserved'), true);
  assert.equal(saleAllowed('ready_transfer'), true);
  assert.equal(saleAllowed('sold'), false);
  assert.equal(saleAllowed('inactive'), false);
});

test('sold channel posts are removed after 48 hours and the record stays eligible only once', () => {
  const soldAt = new Date('2026-10-01T00:00:00Z');
  const row = { status: 'sold', sold_at: soldAt, channel_message_id: 5, sold_reply_message_id: 6 };
  assert.equal(shouldCleanupSoldChannel(row, new Date(soldAt.getTime() + 48 * 60 * 60 * 1000 - 1)), false);
  assert.equal(shouldCleanupSoldChannel(row, new Date(soldAt.getTime() + 48 * 60 * 60 * 1000)), true);
  assert.equal(shouldCleanupSoldChannel({ ...row, channel_cleaned_at: soldAt }, new Date(soldAt.getTime() + 3 * day)), false);
});

test('special sale is four percent once after 60 days and resets with a new period', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const row = { status: 'active', period_started_at: start, special_sale_applied_at: null };
  assert.equal(shouldApplySpecialSale(row, new Date(start.getTime() + 59 * day)), false);
  assert.equal(shouldApplySpecialSale(row, new Date(start.getTime() + 60 * day)), true);
  assert.equal(shouldApplySpecialSale({ ...row, special_sale_applied_at: start }, new Date(start.getTime() + 90 * day)), false);
  assert.equal(shouldApplySpecialSale({ ...row, status: 'reserved' }, new Date(start.getTime() + 90 * day)), false);
  const reopened = { status: 'active', period_started_at: new Date('2026-08-01T00:00:00Z'), special_sale_applied_at: null };
  assert.equal(shouldApplySpecialSale(reopened, new Date('2026-08-15T00:00:00Z')), false);
  assert.equal(specialPrice(1_000_000), 960_000);
});

test('line list order is prefix 1 through 9 then 0', () => {
  const rows = [
    { id: 1, prefix_code: 0 },
    { id: 2, prefix_code: 2 },
    { id: 3, prefix_code: 1 },
    { id: 4, prefix_code: 9 }
  ];
  assert.deepEqual(sortListings(rows).map((row) => row.prefix_code), [1, 2, 9, 0]);
  assert.equal(prefixRank(0), 10);
});

test('installment deep link keeps the selected down payment', () => {
  assert.deepEqual(parseStartPayload('/start buy_15_6_40'), { kind: 'installment', listingId: 15, months: 6, percent: 40 });
  assert.equal(parseStartPayload('/start buy_15_6_25'), null);
  assert.deepEqual(parseStartPayload('/start cash_15'), { kind: 'cash', listingId: 15 });
  assert.deepEqual(parseStartPayload('/start cash_15@SamiSIM0912Bot'), { kind: 'cash', listingId: 15 });
  const html = calcPageHtml({ id: 15, price_toman: 500000000, phone_number: '09121111111', phone_display: '09121111111' }, { interestPercentMonthly: 5, monthOptions: [2, 3, 4, 5, 6, 7, 8], percentOptions: [30, 40, 50, 60, 70, 80, 90], roundToman: 50000 }, 'SamiSIM0912Bot');
  assert.match(html, /buy_'\+id\+'_'\+months\+'_'\+pct/);
  assert.match(html, /خرید اقساطی/);
});

test('phones, jalali dates, and listing text accept persian digits', () => {
  assert.equal(toLatinDigits('۵۸۰'), '580');
  assert.deepEqual(normalizePhone('۰۹۱۲ ۱۵۷ ۲۷ ۵۸'), { digits: '09121572758', display: '0912 157 27 58' });
  assert.equal(parseDateInput('۱۴۰۴/۰۱/۰۱'), '2025-03-21');
  assert.equal(displayJalali(parseDateInput('1404/01/01')), '1404/01/01');
  assert.equal(parseDateInput('2025/03/21'), '2025-03-21');
  const parsed = parseListingText('0912 157 27 58\n580\nکارکرده');
  assert.equal(parsed.phone, '09121572758');
  assert.equal(parsed.price, 580_000_000);
});

test('excel rows update the open cycle and do not invent a sold overwrite', () => {
  const ad = parseExcelAd({ 'سیم‌کارت': '09120000000', 'قیمت': '120000000', 'وضعیت': 'کارکرده', 'توضیحات': 'رند' });
  assert.equal(ad.phone, '09120000000');
  assert.equal(ad.price, 120000000);
  assert.equal(parseExcelAd({ 'سیم‌کارت': '09130000000', 'قیمت': '10' }), null);
});

test('invoice keeps identity data structured and calculates installment from the final price', () => {
  const body = '049937089';
  const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  const nationalId = body + String(remainder < 2 ? remainder : 11 - remainder);
  assert.equal(validNationalId(nationalId), nationalId);
  assert.equal(validNationalId('1111111111'), null);
  assert.equal(nextInvoiceNumber(null, 1405), 'S1405-00001');
  assert.equal(nextInvoiceNumber('S1405-00012', 1405), 'S1405-00013');
  assert.equal(nextInvoiceNumber('S1404-00012', 1405), 'S1405-00001');
  assert.equal(listingListPriceToman({ price_toman: 960_000_000, original_price_toman: 1_000_000_000 }), 1_000_000_000);
  const pct = parseManualDiscountInput('5', 1_000_000_000);
  assert.equal(pct.final, 950_000_000);
  assert.equal(pct.discount, 50_000_000);
  const finalM = parseManualDiscountInput('550', 580_000_000);
  assert.equal(finalM.final, 550_000_000);
  const amounts = invoiceDiscount({ price_toman: 960000, original_price_toman: 1000000 });
  assert.deepEqual(amounts, { price: 1000000, discount: 40000, final: 960000 });
  const cash = invoiceMath({ ...amounts, saleType: 'cash' });
  assert.equal(cash.final, 960000);
  const installment = invoiceMath({ ...amounts, saleType: 'installment', months: 6, percent: 40, interest: 5 });
  assert.equal(installment.cash, Math.floor(960000 * 0.4));
  assert.ok(installment.monthly > 0);
});

test('channel document line switches to ready text after due date', () => {
  assert.match(channelDocumentReadyLine('2099-01-01'), /^تاریخ سند: /);
  assert.equal(channelDocumentReadyLine('2000-01-01'), '✅ <b>آماده سند</b>');
  assert.equal(isDocumentReadyDue('2000-01-01'), true);
  assert.equal(isDocumentReadyDue('2099-12-31'), false);
  const pgDate = new Date('2026-03-19T00:00:00.000Z');
  assert.equal(isDocumentReadyDue(pgDate), true);
  assert.equal(channelDocumentReadyLine(pgDate), '✅ <b>آماده سند</b>');
});

test('channel copy shows reserve and special sale without a public buy link while reserved', () => {
  const reserved = channelText({
    id: 3, phone_display: '09121111111', condition_text: 'کارکرده', price_toman: 1000,
    status: 'reserved', document_ready_date: '2026-10-01'
  }, { bot: 'SamiSIM0912Bot', calcUrl: 'https://example/api/calc?listing=3' });
  assert.match(reserved, /⌛رزرو شد⌛/);
  assert.doesNotMatch(reserved, /خرید نقدی/);
  const special = channelText({
    id: 3, phone_display: '09121111111', condition_text: 'کارکرده', price_toman: 960,
    original_price_toman: 1000, status: 'active', special_sale_applied_at: '2026-10-01', document_ready_date: null
  }, { bot: 'SamiSIM0912Bot', calcUrl: 'https://example/api/calc?listing=3' });
  assert.match(special, /فروش ویژه/);
  assert.match(special, /خرید اقساطی/);
  assert.match(special, /<s>1,000/);
  assert.match(special, /960/);
});
