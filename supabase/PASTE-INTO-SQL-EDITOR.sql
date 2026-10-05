

CREATE TABLE IF NOT EXISTS businesses (
  id          text PRIMARY KEY,
  name        text,
  category_id text,
  status      text,
  created_at  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS businesses_category_id_idx ON businesses (category_id);
CREATE INDEX IF NOT EXISTS businesses_status_idx      ON businesses (status);

CREATE TABLE IF NOT EXISTS users (
  id      text PRIMARY KEY,
  uid     text,
  email   text,
  role    text,
  status  text,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS users_email_idx  ON users (email);
CREATE INDEX IF NOT EXISTS users_role_idx   ON users (role);
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

CREATE TABLE IF NOT EXISTS inventory (
  id                text PRIMARY KEY,
  name              text,
  business_category text,
  entity_id         text,
  entity_name       text,
  is_archived       boolean,
  created_at        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS inventory_business_category_idx ON inventory (business_category);
CREATE INDEX IF NOT EXISTS inventory_entity_id_idx        ON inventory (entity_id);
CREATE INDEX IF NOT EXISTS inventory_is_archived_idx      ON inventory (is_archived);
CREATE INDEX IF NOT EXISTS inventory_name_idx            ON inventory (name);

CREATE TABLE IF NOT EXISTS sales (
  id                text PRIMARY KEY,
  business_category text,
  transaction_id    text,
  created_at        text,
  date              text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sales_business_category_idx ON sales (business_category);
CREATE INDEX IF NOT EXISTS sales_created_at_idx       ON sales (created_at);
CREATE INDEX IF NOT EXISTS sales_date_idx             ON sales (date);

CREATE TABLE IF NOT EXISTS returns (
  id                text PRIMARY KEY,
  business_category text,
  original_sale_id  text,
  created_at        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS returns_business_category_idx ON returns (business_category);
CREATE INDEX IF NOT EXISTS returns_original_sale_id_idx  ON returns (original_sale_id);

CREATE TABLE IF NOT EXISTS expenses (
  id                text PRIMARY KEY,
  business_category text,
  date              text,
  created_at        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS expenses_business_category_idx ON expenses (business_category);
CREATE INDEX IF NOT EXISTS expenses_date_idx             ON expenses (date);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id                text PRIMARY KEY,
  product_id        text,
  business_category text,
  type              text,
  created_at        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS inventory_movements_product_id_idx        ON inventory_movements (product_id);
CREATE INDEX IF NOT EXISTS inventory_movements_business_category_idx ON inventory_movements (business_category);
CREATE INDEX IF NOT EXISTS inventory_movements_type_idx             ON inventory_movements (type);
CREATE INDEX IF NOT EXISTS inventory_movements_created_at_idx       ON inventory_movements (created_at);

-- Full history preserved. Nothing is pruned or summarised.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          text PRIMARY KEY,
  log_type    text,
  business_id text,
  timestamp   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx   ON audit_logs (timestamp);
CREATE INDEX IF NOT EXISTS audit_logs_log_type_idx   ON audit_logs (log_type);
CREATE INDEX IF NOT EXISTS audit_logs_business_id_idx ON audit_logs (business_id);

CREATE TABLE IF NOT EXISTS notifications (
  id           text PRIMARY KEY,
  type         text,
  coalesce_key text,
  entity_id    text,
  business_id  text,
  is_read      boolean,
  created_at   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx   ON notifications (created_at);
CREATE INDEX IF NOT EXISTS notifications_coalesce_key_idx ON notifications (coalesce_key);
CREATE INDEX IF NOT EXISTS notifications_type_idx         ON notifications (type);
CREATE INDEX IF NOT EXISTS notifications_entity_id_idx    ON notifications (entity_id);
CREATE INDEX IF NOT EXISTS notifications_is_read_idx      ON notifications (is_read);

CREATE TABLE IF NOT EXISTS access_requests (
  id         text PRIMARY KEY,
  status     text,
  uid        text,
  email      text,
  created_at text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS access_requests_status_idx     ON access_requests (status);
CREATE INDEX IF NOT EXISTS access_requests_created_at_idx ON access_requests (created_at);

CREATE TABLE IF NOT EXISTS settings      (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS budget_limits (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS backups_data  (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS backups_history (
  id        text PRIMARY KEY,
  timestamp text,
  data      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backups_history_timestamp_idx ON backups_history (timestamp);

CREATE TABLE IF NOT EXISTS sent_reports (
  id         text PRIMARY KEY,
  created_at text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sent_reports_created_at_idx ON sent_reports (created_at);

CREATE TABLE IF NOT EXISTS contact_requests (
  id         text PRIMARY KEY,
  created_at text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS contact_requests_created_at_idx ON contact_requests (created_at);

CREATE TABLE IF NOT EXISTS signup_otps (
  id    text PRIMARY KEY,
  email text,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS signup_otps_email_idx ON signup_otps (email);

CREATE TABLE IF NOT EXISTS password_resets (
  id    text PRIMARY KEY,
  email text,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets (email);

CREATE TABLE IF NOT EXISTS backup_otps (
  id    text PRIMARY KEY,
  email text,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backup_otps_email_idx ON backup_otps (email);

-- ── RLS on every table, zero policies ────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses','users','inventory','sales','returns','expenses',
    'inventory_movements','audit_logs','notifications','access_requests',
    'settings','budget_limits','backups_history','backups_data',
    'sent_reports','contact_requests','signup_otps','password_resets','backup_otps'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;