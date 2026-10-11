import fs from 'node:fs';
import path from 'node:path';

let ready = null;

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL name: ${name}`);
  return name;
}

async function run(q, sqlText) {
  await q.query(sqlText);
}

async function ensureBaseSchema(q) {
  const exists = await q.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'listings' LIMIT 1`
  );
  if (exists.length) return;
  const sqlPath = path.join(process.cwd(), 'scripts', 'dev', 'local-base-schema.sql');
  await q.query(fs.readFileSync(sqlPath, 'utf8'));
}

export function ensureSchema(q) {
  if (!ready) ready = applySchema(q).catch((error) => { ready = null; throw error; });
  return ready;
}

export function resetSchemaCache() {
  ready = null;
}

async function applySchema(q) {
  await ensureBaseSchema(q);

  const statements = [
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS phone_display TEXT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS cycle_no INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS period_started_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS special_sale_applied_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS special_sale_announced_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS original_price_toman BIGINT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sold_reply_message_id BIGINT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS reserved_notice_message_id BIGINT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS special_sale_notice_message_id BIGINT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS channel_cleaned_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_document_status TEXT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_document_due_date DATE`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_document_completed_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_document_cycle INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_document_last_reminded_at TIMESTAMPTZ`,
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS request_type TEXT NOT NULL DEFAULT 'installment'`,
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS customer_phone TEXT`,
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS assigned_priority INTEGER`,
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS handoff_notified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS cash_percent INTEGER`,
    `ALTER TABLE purchase_requests ALTER COLUMN months DROP NOT NULL`,
    `ALTER TABLE purchase_requests ALTER COLUMN monthly_installment_toman DROP NOT NULL`,
    `ALTER TABLE purchase_requests ALTER COLUMN total_installment_toman DROP NOT NULL`,
    `ALTER TABLE admins ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE owners ADD COLUMN IF NOT EXISTS max_line_slots INTEGER NOT NULL DEFAULT 10`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS partners (
      telegram_user_id BIGINT PRIMARY KEY,
      display_name TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS owner_action_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      action TEXT NOT NULL,
      owner_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS purchase_contact_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      listing_id BIGINT NOT NULL,
      request_type TEXT NOT NULL,
      months INTEGER,
      cash_percent INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS listing_edit_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      listing_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS listing_registration_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      phone_number TEXT,
      phone_display TEXT,
      price_toman BIGINT,
      condition_text TEXT,
      owner_id BIGINT,
      warehouse_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS line_list_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      status TEXT,
      owner_id BIGINT,
      warehouse_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_drafts (
      telegram_user_id BIGINT PRIMARY KEY,
      listing_id BIGINT NOT NULL,
      step TEXT NOT NULL,
      customer_name TEXT,
      national_id TEXT,
      customer_phone TEXT,
      address TEXT,
      birth_date DATE,
      sale_type TEXT,
      months INTEGER,
      cash_percent INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      listing_id BIGINT NOT NULL UNIQUE REFERENCES listings(id),
      customer_name TEXT NOT NULL,
      national_id TEXT,
      customer_phone TEXT,
      address TEXT,
      birth_date DATE,
      sale_type TEXT NOT NULL,
      price_toman BIGINT NOT NULL,
      discount_toman BIGINT NOT NULL DEFAULT 0,
      final_toman BIGINT NOT NULL,
      months INTEGER,
      cash_amount_toman BIGINT,
      monthly_installment_toman BIGINT,
      total_installment_toman BIGINT,
      store_name TEXT,
      store_phone TEXT,
      store_address TEXT,
      pdf_base64 TEXT,
      created_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS owner_document_slots (
      id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES owners(id),
      listing_id BIGINT NULL REFERENCES listings(id) ON DELETE SET NULL,
      slot_status TEXT NOT NULL DEFAULT 'occupied',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS listings_phone_idx ON listings (phone_number)`,
    `CREATE INDEX IF NOT EXISTS invoices_national_id_idx ON invoices (national_id)`,
    `CREATE INDEX IF NOT EXISTS invoices_customer_phone_idx ON invoices (customer_phone)`
  ];

  for (const statement of statements) await run(q, statement);

  await q.query(`ALTER TABLE purchase_requests DROP CONSTRAINT IF EXISTS purchase_requests_months_check`);
  await q.query(`ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_months_check CHECK (months IS NULL OR (months >= 2 AND months <= 8))`);

  const columns = await q.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'listings'`);
  const names = new Set(columns.map((column) => column.column_name));
  if (names.has('updated_at')) {
    await q.query(`UPDATE listings SET period_started_at = updated_at WHERE period_started_at IS NULL AND updated_at IS NOT NULL`);
  }
  await q.query(`UPDATE listings SET period_started_at = NOW() WHERE period_started_at IS NULL`);
  if (names.has('updated_at')) {
    await q.query(`UPDATE listings SET sold_at = updated_at WHERE status = 'sold' AND sold_at IS NULL AND updated_at IS NOT NULL`);
  }
  await q.query(`UPDATE listings SET sold_at = NOW() WHERE status = 'sold' AND sold_at IS NULL`);

  const fullAccess = JSON.stringify({
    add_listing: true, lookup: true, owners: true, warehouses: true, lines: true,
    reports: true, history: true, invoices: true, partners: true, settings: true, admin_management: true
  });
  await q.query(
    `UPDATE admins SET permissions = $1::jsonb WHERE permissions IS NULL OR permissions = '{}'::jsonb`,
    [fullAccess]
  );
  await q.query(`UPDATE admins SET permissions = permissions || '{"invoices":false}'::jsonb WHERE NOT (permissions ? 'invoices')`);

  const constraints = await q.query(`
    SELECT c.conname, array_agg(a.attname::text ORDER BY cols.ordinality) AS cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
    WHERE t.relname = 'listings' AND c.contype = 'u'
    GROUP BY c.conname
  `);
  for (const constraint of constraints) {
    const cols = Array.isArray(constraint.cols) ? constraint.cols : String(constraint.cols || '').replace(/[{}]/g, '').split(',');
    if (cols.length === 1 && cols[0] === 'phone_number') {
      await q.query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS ${quoteIdent(constraint.conname)}`);
    }
  }
  const indexes = await q.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'listings'`);
  for (const index of indexes) {
    const definition = String(index.indexdef || '');
    if (/UNIQUE/i.test(definition) && /phone_number/i.test(definition) && !/WHERE/i.test(definition)) {
      await q.query(`DROP INDEX IF EXISTS ${quoteIdent(index.indexname)}`);
    }
  }
  await q.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS listings_one_open_phone
    ON listings (phone_number)
    WHERE status IN ('active', 'reserved', 'ready_transfer', 'inactive')
  `);
}
