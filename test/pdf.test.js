import test from 'node:test';
import assert from 'node:assert/strict';
import { invoicePdf, linesPdf } from '../src/invoice/pdf.js';
import { DEFAULT_STORE_ADDRESS, DEFAULT_STORE_WEB, invoicePdfFilename } from '../src/invoice/invoice-template.js';

test('invoice and line-list PDFs are real PDF files', async () => {
  const invoice = await invoicePdf({
    invoice_number: 'S1405-00001',
    created_at: '2026-10-07',
    store_name: 'سامی',
    store_phone: '02100000000',
    store_address: 'تهران',
    customer_name: 'علی رضایی',
    national_id: '0499370899',
    customer_phone: '09120000000',
    birth_date: '1991-04-04',
    address: 'تهران، خیابان مثال',
    phone_display: '0912 111 1111',
    phone_number: '09121111111',
    condition_text: 'کارکرده',
    sale_type: 'installment',
    price_toman: 1000000,
    discount_toman: 40000,
    final_toman: 960000,
    cash_amount_toman: 384000,
    months: 6,
    monthly_installment_toman: 110000,
    total_installment_toman: 660000
  });
  const lines = await linesPdf([
    { phone_display: '09121111111', price_toman: 960000, status: 'active', owner_name: 'سامی', warehouse_name: 'مرکزی' },
    { phone_display: '09120000000', price_toman: 500000, status: 'sold', owner_name: 'رضا', warehouse_name: 'انبار ۲' }
  ], 'وضعیت همه');
  assert.equal(invoice.subarray(0, 4).toString(), '%PDF');
  assert.equal(lines.subarray(0, 4).toString(), '%PDF');
  assert.ok(invoice.length > 1000);
  assert.ok(lines.length > 1000);
});

test('invoice PDF filename uses jalali date', () => {
  const name = invoicePdfFilename({ invoice_number: 'S1405-00001', created_at: '2026-10-07' });
  assert.match(name, /^\d{4}-\d{2}-\d{2}_S1405-00001\.pdf$/);
});

test('invoice store defaults include address and website', () => {
  assert.ok(DEFAULT_STORE_ADDRESS.includes('فروشگاه سامی'));
  assert.equal(DEFAULT_STORE_WEB, 'Www.Samiito.com');
});
