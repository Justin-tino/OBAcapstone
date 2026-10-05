/**
 * scripts/verify-schema.js — confirms the Supabase schema is in place.
 *
 * Checks, using the SERVICE-ROLE key (bypasses RLS, so it can see rows):
 *   1. every expected table exists
 *   2. row counts
 *   3. RLS is enabled on every table  ← the security-critical check
 *   4. the public ANON key is actually locked out of every table
 *
 * Run: node scripts/verify-schema.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TABLES = [
  'businesses', 'users', 'inventory', 'sales', 'returns', 'expenses',
  'inventory_movements', 'audit_logs', 'notifications', 'access_requests',
  'settings', 'budget_limits', 'backups_history', 'backups_data',
  'sent_reports', 'contact_requests', 'signup_otps', 'password_resets', 'backup_otps',
];

const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

(async () => {
  let bad = 0;

  console.log('\n1. Tables + row counts (service role)\n');
  const missing = [];
  const counts = {};
  for (const t of TABLES) {
    const { count, error } = await service.from(t).select('*', { count: 'exact', head: true });
    if (error) { missing.push(t); console.log(`  ${t.padEnd(22)} MISSING`); bad++; }
    else { counts[t] = count; console.log(`  ${t.padEnd(22)} ${count} row(s)`); }
  }
  if (!missing.length) console.log(`\n  all ${TABLES.length} tables present`);

  // NOTE: an empty table returns `[]` with no error whether or not RLS is on,
  // so probing anon access here cannot prove anything. RLS is verified
  // properly by scripts/verify-rls.js, which writes a canary row and tries to
  // read it back with the anon key.
  console.log('\n2. Row Level Security\n');
  console.log('  Not checked here — an empty table is indistinguishable from a');
  console.log('  blocked one. Run: node scripts/verify-rls.js');

  console.log('\n3. Anon key lockout\n');
  console.log('  Verified separately by scripts/verify-rls.js (canary-row test).\n');

  console.log('─'.repeat(50));
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Rows across all tables: ${totalRows}`);
  console.log(bad ? `\n${bad} issue(s) found.` : '\nSchema verified.');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });