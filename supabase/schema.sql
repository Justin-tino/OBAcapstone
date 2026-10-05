-- ============================================================================
-- supabase/schema.sql — OBA System, Firestore → Postgres
--
-- Design notes
-- ------------
-- One table per Firestore collection. Every table keeps the FULL document in a
-- `data jsonb` column so no field is ever dropped, truncated, or coerced, and
-- so Firestore's exact types round-trip (Firestore numerics are doubles and
-- they stay doubles). On top of that, the handful of fields the app actually
-- filters or sorts on are mirrored into real typed columns with indexes.
--
-- Storage choices made for the free tier (500 MB database):
--   - TEXT is used instead of VARCHAR(n) so no length limit can ever silently
--     truncate a value.
--   - ISO-8601 timestamps stay TEXT, not timestamptz, so the exact string your
--     reports already parse is preserved with no timezone reinterpretation.
--   - No table stores anything the Firestore source did not hold. auditLogs
--     and backupsData are the largest consumers and are deliberately NOT
--     pruned; at the current volume the whole database is well under 1 MB.
--
-- RLS: ENABLED on every table with no policies. The Express server uses the
-- service-role key, which bypasses RLS exactly as the Firebase Admin SDK
-- bypassed Firestore rules. The public anon key can read nothing.
-- ============================================================================

-- ─── businesses ──────────────────────────────────────────────────────────────
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

-- ─── users ───────────────────────────────────────────────────────────────────
-- NOTE: authentication stays with Firebase Auth (email provider is unchanged).
-- This table holds only the app profile: role, business access, status.
CREATE TABLE IF NOT EXISTS users (
  id      text PRIMARY KEY,          -- Firebase Auth uid
  uid     text,
  email   text,
  role    text,
  status  text,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS users_email_idx  ON users (email);
CREATE INDEX IF NOT EXISTS users_role_idx   ON users (role);
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

-- ─── inventory ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory (
  id                 text PRIMARY KEY,
  name               text,
  business_category  text,
  entity_id          text,
  entity_name        text,
  is_archived        boolean,
  created_at         text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS inventory_business_category_idx ON inventory (business_category);
CREATE INDEX IF NOT EXISTS inventory_entity_id_idx        ON inventory (entity_id);
CREATE INDEX IF NOT EXISTS inventory_is_archived_idx      ON inventory (is_archived);
CREATE INDEX IF NOT EXISTS inventory_name_idx            ON inventory (name);

-- ─── sales ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id                 text PRIMARY KEY,
  business_category  text,
  transaction_id     text,
  created_at         text,
  date               text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sales_business_category_idx ON sales (business_category);
CREATE INDEX IF NOT EXISTS sales_created_at_idx       ON sales (created_at);
CREATE INDEX IF NOT EXISTS sales_date_idx             ON sales (date);

-- ─── returns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS returns (
  id                 text PRIMARY KEY,
  business_category  text,
  original_sale_id   text,
  created_at         text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS returns_business_category_idx ON returns (business_category);
CREATE INDEX IF NOT EXISTS returns_original_sale_id_idx  ON returns (original_sale_id);

-- ─── expenses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id                 text PRIMARY KEY,
  business_category  text,
  date               text,
  created_at         text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS expenses_business_category_idx ON expenses (business_category);
CREATE INDEX IF NOT EXISTS expenses_date_idx             ON expenses (date);

-- ─── inventoryMovements ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_movements (
  id                 text PRIMARY KEY,
  product_id         text,
  business_category  text,
  type               text,
  created_at         text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS inventory_movements_product_id_idx        ON inventory_movements (product_id);
CREATE INDEX IF NOT EXISTS inventory_movements_business_category_idx ON inventory_movements (business_category);
CREATE INDEX IF NOT EXISTS inventory_movements_type_idx             ON inventory_movements (type);
CREATE INDEX IF NOT EXISTS inventory_movements_created_at_idx       ON inventory_movements (created_at);

-- ─── auditLogs ───────────────────────────────────────────────────────────────
-- Full history is preserved. Nothing is pruned or summarised.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         text PRIMARY KEY,
  log_type   text,
  business_id text,
  timestamp  text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx  ON audit_logs (timestamp);
CREATE INDEX IF NOT EXISTS audit_logs_log_type_idx  ON audit_logs (log_type);
CREATE INDEX IF NOT EXISTS audit_logs_business_id_idx ON audit_logs (business_id);

-- ─── notifications ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            text PRIMARY KEY,
  type          text,
  coalesce_key  text,
  entity_id     text,
  business_id   text,
  is_read       boolean,
  created_at    text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx   ON notifications (created_at);
CREATE INDEX IF NOT EXISTS notifications_coalesce_key_idx ON notifications (coalesce_key);
CREATE INDEX IF NOT EXISTS notifications_type_idx         ON notifications (type);
CREATE INDEX IF NOT EXISTS notifications_entity_id_idx    ON notifications (entity_id);
CREATE INDEX IF NOT EXISTS notifications_is_read_idx      ON notifications (is_read);

-- ─── accessRequests ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id          text PRIMARY KEY,
  status      text,
  uid         text,
  email       text,
  created_at  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS access_requests_status_idx     ON access_requests (status);
CREATE INDEX IF NOT EXISTS access_requests_created_at_idx ON access_requests (created_at);

-- ─── settings (single-doc collections, e.g. the 'taxes' document) ───────────
CREATE TABLE IF NOT EXISTS settings (
  id    text PRIMARY KEY,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ─── budgetLimits (keyed per business, like settings) ───────────────────────
CREATE TABLE IF NOT EXISTS budget_limits (
  id    text PRIMARY KEY,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ─── backupsHistory ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backups_history (
  id         text PRIMARY KEY,
  timestamp  text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backups_history_timestamp_idx ON backups_history (timestamp);

-- ─── backupsData (full restorable snapshot blob) ─────────────────────────────
CREATE TABLE IF NOT EXISTS backups_data (
  id    text PRIMARY KEY,
  data  jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ─── sent_reports ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sent_reports (
  id          text PRIMARY KEY,
  created_at  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sent_reports_created_at_idx ON sent_reports (created_at);

-- ─── contactRequests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_requests (
  id          text PRIMARY KEY,
  created_at  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS contact_requests_created_at_idx ON contact_requests (created_at);

-- ─── signupOtps / passwordResets / backupOtps (short-lived, keyed by id) ────
CREATE TABLE IF NOT EXISTS signup_otps (
  id     text PRIMARY KEY,     -- emailKey
  email  text,
  data   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS signup_otps_email_idx ON signup_otps (email);

CREATE TABLE IF NOT EXISTS password_resets (
  id      text PRIMARY KEY,    -- token
  email   text,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets (email);

CREATE TABLE IF NOT EXISTS backup_otps (
  id      text PRIMARY KEY,    -- uid
  email   text,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backup_otps_email_idx ON backup_otps (email);

-- ============================================================================
-- ROW LEVEL SECURITY — enabled, zero policies.
-- Service role bypasses this. The anon key is locked out of every table.
-- ============================================================================
ALTER TABLE businesses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales               ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_limits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups_data        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sent_reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_otps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_otps         ENABLE ROW LEVEL SECURITY;