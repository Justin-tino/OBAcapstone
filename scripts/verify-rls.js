/**
 * scripts/verify-rls.js — definitive RLS check.
 *
 * A previous check was inconclusive: an EMPTY table returns `[]` with no error
 * whether or not RLS is enabled. So this writes a canary row with the service
 * role (which bypasses RLS), then tries to read it back with the public anon key.
 *
 *   row visible to anon  => RLS is OFF  => security problem
 *   row hidden from anon => RLS is ON   => correct
 *
 * The canary is deleted afterwards.
 * Run: node scripts/verify-rls.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const TABLES = [
  'businesses', 'users', 'inventory', 'sales', 'returns', 'expenses',
  'inventory_movements', 'audit_logs', 'notifications', 'access_requests',
  'settings', 'budget_limits', 'backups_history', 'backups_data',
  'sent_reports', 'contact_requests', 'signup_otps', 'password_resets', 'backup_otps',
];

const CANARY = 'rls-canary-' + Date.now().toString(36);

(async () => {
  console.log(`\nWriting a canary row to each table, then trying to read it with the anon key…\n`);
  const exposed = [];
  const unknown = [];

  for (const t of TABLES) {
    // 1. service role writes the canary (bypasses RLS)
    const marker = t === 'settings' || t === 'budget_limits' || t === 'backups_data'
      ? { id: CANARY, data: { canary: CANARY } }
      : { id: CANARY, data: { canary: CANARY } };
    const ins = await service.from(t).upsert(marker, { onConflict: 'id' });
    if (ins.error) { unknown.push(t); console.log(`  ${t.padEnd(22)} could not write: ${ins.error.code}`); continue; }

    // 2. anon key tries to read it
    const { data, error } = await anon.from(t).select('*').eq('id', CANARY).limit(1);

    if (error) {
      console.log(`  ${t.padEnd(22)} BLOCKED (${error.code})`);
    } else if (Array.isArray(data) && data.length > 0) {
      console.log(`  ${t.padEnd(22)} *** EXPOSED — anon read the row ***`);
      exposed.push(t);
    } else {
      console.log(`  ${t.padEnd(22)} BLOCKED (row hidden)`);
    }

    // 3. clean up the canary
    await service.from(t).delete().eq('id', CANARY);
  }

  console.log('\n' + '─'.repeat(56));
  if (exposed.length === 0 && unknown.length === 0) {
    console.log('RLS IS ENABLED ON ALL TABLES — the anon key cannot read any row.');
    console.log('This is the correct state.');
  } else if (exposed.length > 0) {
    console.log(`RLS IS NOT ENABLED on ${exposed.length} table(s):`);
    console.log(exposed.map(t => '  ' + t).join('\n'));
    console.log('\nFix — paste this into the Supabase SQL Editor and Run:');
    console.log(exposed.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n'));
  }
  if (unknown.length) console.log('\nCould not test: ' + unknown.join(', '));
  process.exit(exposed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });