/**
 * scripts/setup-supabase.js — applies supabase/schema.sql to the project.
 * Idempotent: every statement uses IF NOT EXISTS, so re-running is safe.
 *
 * Usage: node scripts/setup-supabase.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

// Table list mirrors schema.sql, used for the after-state report.
const TABLES = [
  'businesses', 'users', 'inventory', 'sales', 'returns', 'expenses',
  'inventory_movements', 'audit_logs', 'notifications', 'access_requests',
  'settings', 'budget_limits', 'backups_history', 'backups_data',
  'sent_reports', 'contact_requests', 'signup_otps', 'password_resets', 'backup_otps',
];

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');

  // Statements are separated by top-level semicolons; the schema has no
  // dollar-quoted bodies or embedded semicolons in strings.
  const statements = sql
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  console.log(`Applying ${statements.length} statements to ${URL}\n`);

  let ok = 0;
  let failed = 0;
  for (const stmt of statements) {
    const { error } = await db.rpc('exec_sql', { sql: stmt });
    if (error) {
      // exec_sql is a management function that may not exist; fall back to
      // the PostgREST-adjacent approach is not possible, so surface clearly.
      console.error(`  ✗ ${stmt.split('\n')[0].slice(0, 70)}`);
      console.error(`    ${error.message}`);
      failed++;
    } else {
      ok++;
    }
  }

  console.log(`\n${ok} ok, ${failed} failed`);
  console.log('\nRow counts:');
  for (const t of TABLES) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    if (error) console.log(`  ${t.padEnd(22)} ERROR: ${error.message}`);
    else console.log(`  ${t.padEnd(22)} ${count}`);
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });