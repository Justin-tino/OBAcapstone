/**
 * scripts/import-json.js — load Firestore data into Supabase from a JSON file.
 *
 * Use this when you cannot read Firestore programmatically (e.g. the Spark
 * plan daily read quota is exhausted) but you can still copy the data out by
 * hand from the Firebase console, or you have a JSON export.
 *
 * INPUT: a JSON file containing an object keyed by Firestore collection name:
 *
 *   {
 *     "businesses": [ { "id": "...", "name": "...", ... }, ... ],
 *     "inventory":  [ { "id": "...", "name": "...", ... }, ... ],
 *     "users":      [ { "id": "...", "email": "...", ... }, ... ],
 *     "settings":   [ { "id": "taxes", "AGRI": 0, "NON_AGRI": 12, "MAIN": 12 } ]
 *   }
 *
 * Every field is preserved in the `data` jsonb column, so nothing is lost.
 * Only `id` is required per record; the rest of the doc is copied verbatim.
 *
 * Usage:
 *   node scripts/import-json.js path/to/data.json
 *   node scripts/import-json.js --template        print a skeleton to fill in
 *   node scripts/import-json.js --file data.json --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Firestore collection → Postgres table (must match config/db.js)
const TABLES = {
  businesses: 'businesses', users: 'users', inventory: 'inventory',
  sales: 'sales', returns: 'returns', expenses: 'expenses',
  inventoryMovements: 'inventory_movements', auditLogs: 'audit_logs',
  notifications: 'notifications', accessRequests: 'access_requests',
  settings: 'settings', budgetLimits: 'budget_limits',
  backupsHistory: 'backups_history', backupsData: 'backups_data',
  sent_reports: 'sent_reports', contactRequests: 'contact_requests',
  signupOtps: 'signup_otps', passwordResets: 'password_resets', backupOtps: 'backup_otps',
};

// Fields mirrored into real indexed columns (same map as the migration script)
const MIRRORS = {
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
};

function toRow(table, doc) {
  const row = { id: String(doc.id), data: doc };
  for (const [field, col] of Object.entries(MIRRORS[table] || {})) {
    if (doc[field] !== undefined) row[col] = doc[field];
  }
  return row;
}

const TEMPLATE = {
  users: [
    { id: '<Firebase Auth uid>', uid: '<Firebase Auth uid>', email: 'admin@psau.edu.ph', name: 'Default Admin', role: 'system_administrator', businesses: ['all'], status: 'active', lastLogin: 'Never', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  businesses: [
    { id: 'B8', name: 'Rice Production', categoryId: 'AGRI', type: 'AGRI', location: '', manager: '', description: '', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  inventory: [
    { id: 'prod-1', name: 'Product name', category: 'Category', unit: 'pcs', unitCost: 0, sellingPrice: 0, quantity: 0, reorderLevel: 10, supplier: '', description: '', businessCategory: 'AGRI', entityId: 'B8', entityName: 'Rice Production', status: 'out-of-stock', isArchived: false, createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  settings: [
    { id: 'taxes', AGRI: 0, NON_AGRI: 12, MAIN: 12 },
  ],
};

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--template')) {
    console.log('\nCopy this structure, fill in real values from the Firebase console, save as data.json\n');
    console.log(JSON.stringify(TEMPLATE, null, 2));
    console.log('\nThen run:  node scripts/import-json.js data.json\n');
    return;
  }

  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/import-json.js <file.json> [--dry-run]');
    console.error('       node scripts/import-json.js --template');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  let data;
  try {
    // Strip a UTF-8 BOM if present — Windows editors (Notepad, PowerShell
    // Out-File) add one and it would otherwise break JSON.parse.
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    data = JSON.parse(raw);
  }
  catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }

  const dryRun = args.includes('--dry-run');
  console.log(`\nImporting from ${file}${dryRun ? '  (dry run — nothing written)' : ''}\n`);

  let total = 0;
  const summary = [];
  for (const [collection, records] of Object.entries(data)) {
    const table = TABLES[collection];
    if (!table) {
      console.log(`  ${collection.padEnd(22)} skipped (unknown collection)`);
      continue;
    }
    if (!Array.isArray(records) || !records.length) {
      console.log(`  ${collection.padEnd(22)} 0 records`);
      continue;
    }
    const withoutId = records.filter(r => !r || r.id === undefined || r.id === null);
    if (withoutId.length) {
      console.error(`  ${collection.padEnd(22)} ${withoutId.length} record(s) have no "id" — skipped`);
    }
    const rows = records.filter(r => r && r.id !== undefined && r.id !== null).map(r => toRow(table, r));

    let written = 0;
    if (!dryRun) {
      // Replace the table so re-runs are idempotent
      await db.from(table).delete().neq('id', '__never__');
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await db.from(table).upsert(chunk, { onConflict: 'id' });
        if (error) { console.error(`  ${collection}: ${error.message}`); break; }
        written += chunk.length;
      }
    }
    total += written;
    console.log(`  ${collection.padEnd(22)} ${rows.length} record(s) → ${table}${dryRun ? '' : ` (${written} written)`}`);
    summary.push([table, written]);
  }

  console.log(`\nTotal: ${total} records${dryRun ? ' (nothing written)' : ''}`);

  if (!dryRun) {
    console.log('\nVerification — row counts in Supabase:');
    for (const [collection, records] of Object.entries(data)) {
      const table = TABLES[collection];
      if (!table || !Array.isArray(records)) continue;
      const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
      console.log(`  ${table.padEnd(22)} ${error ? 'ERR' : count} / ${records.length} ${!error && count === records.length ? '✓' : '✗'}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });