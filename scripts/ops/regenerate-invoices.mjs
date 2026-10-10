/**
 * بازتولید pdf_base64 همه فاکتورها با قالب فعلی (invoice-template-render).
 * استفاده: node scripts/regenerate-invoices.mjs
 */
import { sql } from '../../src/database/sql.js';
import { invoicePdf } from '../../src/invoice/pdf.js';
import { DEFAULT_STORE_ADDRESS, resolveStoreAddressForInvoice } from '../../src/invoice/invoice-template.js';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54329/samisim';
process.env.LOCAL_PG = '1';

const q = sql();

const rows = await q`
  SELECT i.*, l.phone_number, l.phone_display, l.condition_text
  FROM invoices i
  JOIN listings l ON l.id = i.listing_id
  ORDER BY i.id ASC`;

if (!rows.length) {
  console.log('فاکتوری در دیتابیس نیست.');
  process.exit(0);
}

let ok = 0;
for (const row of rows) {
  const storeAddress = resolveStoreAddressForInvoice(row.store_address);
  const pdf = await invoicePdf({
    invoice_number: row.invoice_number,
    created_at: row.created_at,
    store_name: row.store_name,
    store_phone: row.store_phone,
    store_address: storeAddress,
    customer_name: row.customer_name,
    national_id: row.national_id,
    customer_phone: row.customer_phone,
    birth_date: row.birth_date,
    address: row.address,
    phone_display: row.phone_display,
    phone_number: row.phone_number,
    condition_text: row.condition_text,
    sale_type: row.sale_type,
    price_toman: row.price_toman,
    discount_toman: row.discount_toman,
    final_toman: row.final_toman,
    cash_amount_toman: row.cash_amount_toman,
    months: row.months,
    monthly_installment_toman: row.monthly_installment_toman,
    total_installment_toman: row.total_installment_toman
  });
  await q`UPDATE invoices SET pdf_base64 = ${pdf.toString('base64')}, store_address = ${storeAddress} WHERE id = ${row.id}`;
  ok += 1;
  console.log(`✓ ${row.invoice_number} (listing ${row.listing_id})`);
}

console.log(`\n${ok} فاکتور با قالب جدید به\u200cروز شد.`);
