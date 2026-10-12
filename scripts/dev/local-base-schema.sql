CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  max_line_slots INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warehouses (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id BIGINT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  priority INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL,
  phone_display TEXT,
  prefix_code INTEGER,
  price_toman BIGINT NOT NULL,
  condition_text TEXT,
  payment_terms TEXT,
  cash_amount_toman BIGINT,
  created_by BIGINT,
  owner_id BIGINT REFERENCES owners(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  document_ready_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  cycle_no INTEGER NOT NULL DEFAULT 1,
  period_started_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  reserved_at TIMESTAMPTZ,
  reserved_by BIGINT,
  reserved_until TIMESTAMPTZ,
  special_sale_applied_at TIMESTAMPTZ,
  special_sale_announced_at TIMESTAMPTZ,
  original_price_toman BIGINT,
  sold_reply_message_id BIGINT,
  channel_cleaned_at TIMESTAMPTZ,
  channel_chat_id TEXT,
  channel_message_id BIGINT,
  sale_document_status TEXT,
  sale_document_due_date DATE,
  sale_document_completed_at TIMESTAMPTZ,
  sale_document_cycle INTEGER NOT NULL DEFAULT 0,
  sale_document_last_reminded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listing_history (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by BIGINT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  old_price_toman BIGINT,
  new_price_toman BIGINT,
  change_percent NUMERIC,
  reason TEXT,
  changed_by BIGINT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id),
  customer_telegram_id BIGINT NOT NULL,
  customer_username TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  months INTEGER,
  base_price_toman BIGINT NOT NULL,
  cash_amount_toman BIGINT,
  balance_toman BIGINT,
  monthly_installment_toman BIGINT,
  total_installment_toman BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_admin BIGINT,
  assigned_priority INTEGER,
  expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  request_type TEXT NOT NULL DEFAULT 'installment',
  cash_percent INTEGER,
  handoff_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings(key, value) VALUES
  ('installment_interest_percent_monthly', '5'),
  ('store_name', 'سامی'),
  ('store_phone', '02100000000'),
  ('store_address', 'تهرانپارس پایین تر از میدان شاهد(پروین) روبروی پمپ بنزین نبش کوچه پینه فروشگاه سامی')
ON CONFLICT (key) DO NOTHING;

INSERT INTO owners(name, active, max_line_slots)
SELECT 'مالک تست', true, 10
WHERE NOT EXISTS (SELECT 1 FROM owners WHERE name = 'مالک تست');

INSERT INTO warehouses(name, active) VALUES ('انبار تست', true)
ON CONFLICT (name) DO NOTHING;
