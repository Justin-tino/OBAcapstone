/**
 * scripts/migrate-firestore-to-supabase.js
 *
 * One-time transfer of all data from Firestore to Supabase Postgres.
 * READ-ONLY on Firestore: it never writes or deletes there, so Firestore stays
 * intact as the rollback copy.
 *
 * Requires Firestore reads to be available. If Firestore returns
 * RESOURCE_EXHAUSTED (Spark plan read quota exhausted), this script will stop
 * and tell you — wait for the daily reset or upgrade to Blaze, then re-run.
 *
 * Usage:  node scripts/migrate-firestore-to-supabase.js
 *         node scripts/migrate-firestore-to-supabase.js --dry-run
 */
require('dotenv').config();
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Firebase: READ-ONLY. Never calls .set/.add/.update/.delete. ──────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n') : '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    clientId: process.env.FIREBASE_CLIENT_ID,
    authUri: process.env.FIREBASE_AUTH_URI,
    tokenUri: process.env.FIREBASE_TOKEN_URI,
  }),
});
const fdb = admin.firestore();

// ── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Firestore collection → Postgres table, matching config/db.js
const COLLECTIONS = [
  ['businesses', 'businesses'],
  ['users', 'users'],
  ['inventory', 'inventory'],
  ['sales', 'sales'],
  ['returns', 'returns'],
  ['expenses', 'expenses'],
  ['inventoryMovements', 'inventory_movements'],
  ['auditLogs', 'audit_logs'],
  ['notifications', 'notifications'],
  ['accessRequests', 'access_requests'],
  ['settings', 'settings'],
  ['budgetLimits', 'budget_limits'],
  ['backupsHistory', 'backups_history'],
  ['backupsData', 'backups_data'],
  ['sent_reports', 'sent_reports'],
  ['contactRequests', 'contact_requests'],
  ['signupOtps', 'signup_otps'],
  ['passwordResets', 'password_resets'],
  ['backupOtps', 'backup_otps'],
];

async function readCollection(name) {
  const snap = await fdb.collection(name).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function toRow(table, doc) {
  const row = { id: String(doc.id), data: doc };
  // Mirror the indexed columns so filtering/sorting works identically
  const mirrors = {
    businesses: { categoryId: 'category_id', status: 'status', createdAt: 'created_at' },
    users: { role: 'role', status: 'status', email: 'email' },
    inventory: {
      name: 'name', businessCategory: 'business_category', entityId: 'entity_id',
      entityName: 'entity_name', isArchived: 'is_archived', createdAt: 'created_at',
    },
    sales: { businessCategory: 'business_category', transactionId: 'transaction_id', createdAt: 'created_at', date: 'date' },
    returns: { businessCategory: 'business_category', originalSaleId: 'original_sale_id', createdAt: 'created_at' },
    expenses: { businessCategory: 'business_category', date: 'date', createdAt: 'created_at' },
    inventory_movements: { productId: 'product_id', businessCategory: 'business_category', type: 'type', createdAt: 'created_at' },
    audit_logs: { logType: 'log_type', businessId: 'business_id', timestamp: 'timestamp' },
    notifications: {
      type: 'type', coalesceKey: 'coalesce_key', entityId: 'entity_id',
      businessId: 'business_id', isRead: 'is_read', createdAt: 'created_at',
    },
    access_requests: { status: 'status', uid: 'uid', email: 'email', createdAt: 'created_at' },
    sent_reports: { createdAt: 'created_at' },
    contact_requests: { createdAt: 'created_at' },
    backups_history: { timestamp: 'timestamp' },
    signup_otps: { email: 'email' },
    password_resets: { email: 'email' },
    backup_otps: { email: 'email' },
  }[table] || {};
  for (const [field, col] of Object.entries(mirrors)) {
    if (doc[field] !== undefined) row[col] = doc[field];
  }
  return row;
}

(async () => {
  console.log(DRY_RUN
    ? 'DRY RUN — reading Firestore, writing nothing to Supabase\n'
    : 'Migrating Firestore → Supabase (Firestore is read-only)\n');

  // Probe Firestore first so a quota failure aborts before any writes
  try {
    await fdb.collection('__quota_probe__').limit(1).get();
  } catch (e) {
    console.error('❌ Firestore read failed:', e.code || e.message);
    if (String(e.details || e.message).includes('Quota')) {
      console.error('   This is the free-tier read quota. Wait for the daily reset');
      console.error('   (midnight Pacific) or upgrade to Blaze, then re-run.');
    }
    process.exit(1);
  }

  let total = 0;
  const report = [];

  for (const [collection, table] of COLLECTIONS) {
    let docs = [];
    try {
      docs = await readCollection(collection);
    } catch (e) {
      console.log(`  ${table.padEnd(22)} skipped (${e.code || e.message})`);
      continue;
    }

    if (!docs.length) {
      console.log(`  ${table.padEnd(22)} 0 docs`);
      report.push([table, 0, 0]);
      continue;
    }

    const rows = docs.map(d => toRow(table, d));
    let written = 0;

    if (!DRY_RUN) {
      // Clear the target table first so re-runs don't duplicate rows
      await supabase.from(table).delete().neq('id', '__never__');
      // Insert in chunks (PostgREST caps a single request body)
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
        if (error) {
          console.error(`  ${table}: ${error.message}`);
          break;
        }
        written += chunk.length;
      }
    }

    total += written;
    console.log(`  ${table.padEnd(22)} ${docs.length} docs → ${written} written`);
    report.push([table, docs.length, written]);
  }

  console.log(`\nTotal: ${total} documents`);

  if (!DRY_RUN) {
    console.log('\nVerification (Supabase row counts):');
    for (const [collection, table] of COLLECTIONS) {
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      const src = report.find(r => r[0] === table);
      const expected = src ? src[1] : 0;
      const ok = !error && count === expected;
      console.log(`  ${table.padEnd(22)} ${count === null ? 'ERR' : count} / ${expected} ${ok ? '✓' : '✗'}`);
    }
  }

  console.log(DRY_RUN ? '\nDry run complete — nothing written.' : '\nMigration complete. Firestore untouched.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });