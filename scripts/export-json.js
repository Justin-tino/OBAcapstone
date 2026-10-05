/**
 * scripts/export-json.js — export every collection to portable JSON files.
 *
 * Writes one file per collection into an output folder, in exactly the shape
 * scripts/import-json.js expects, so the two are symmetric:
 *
 *   node scripts/export-json.js                       → ./export-<timestamp>/
 *   node scripts/export-json.js --out my-backup      → ./my-backup/
 *   node scripts/export-json.js --collection inventory
 *
 * Because it reads through config/db.js it works on whichever backend is
 * configured — Supabase (default) or Firestore (DB_PROVIDER=firestore).
 * Every field is exported verbatim from the stored document, so a re-import
 * loses nothing.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const FDB = require('../config/db');

// Every collection the app uses, including ones the in-app backup omitted.
const COLLECTIONS = [
  'businesses', 'users', 'inventory', 'sales', 'returns', 'expenses',
  'inventoryMovements', 'auditLogs', 'notifications', 'accessRequests',
  'settings', 'budgetLimits', 'backupsHistory', 'backupsData',
  'sent_reports', 'contactRequests', 'signupOtps', 'passwordResets', 'backupOtps',
];

// Short-lived auth/OTP material is not worth exporting.
const SKIP = new Set(['signupOtps', 'passwordResets', 'backupOtps']);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dir: null, collection: null, includeSecrets: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out.dir = args[++i];
    else if (args[i] === '--collection') out.collection = args[++i];
    else if (args[i] === '--include-secrets') out.includeSecrets = true;
  }
  return out;
}

(async () => {
  const opts = parseArgs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.dir || `export-${stamp}`);

  const collections = opts.collection ? [opts.collection] : COLLECTIONS;
  console.log(`\nExporting from ${FDB._provider} → ${outDir}\n`);

  const combined = {};
  const manifest = {
    exportedAt: new Date().toISOString(),
    provider: FDB._provider,
    system: 'OBA System',
    collections: {},
    totalRecords: 0,
    note: 'Import with: node scripts/import-json.js <file.json>',
  };

  for (const c of collections) {
    if (SKIP.has(c) && !opts.includeSecrets) {
      console.log(`  ${c.padEnd(20)} skipped (auth/OTP material — use --include-secrets)`);
      continue;
    }
    let docs = [];
    try {
      docs = await FDB.getAll(c);
    } catch (e) {
      console.log(`  ${c.padEnd(20)} ERROR ${e.code || e.message}`);
      continue;
    }
    combined[c] = docs;
    manifest.collections[c] = docs.length;
    manifest.totalRecords += docs.length;
    console.log(`  ${c.padEnd(20)} ${String(docs.length).padStart(5)} record(s)`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Per-collection files (easy to read one at a time)
  for (const [c, docs] of Object.entries(combined)) {
    const safe = c.replace(/[^A-Za-z0-9_-]/g, '_');
    fs.writeFileSync(path.join(outDir, `${safe}.json`), JSON.stringify(docs, null, 2), 'utf8');
  }

  // One combined file for the importer
  const combinedPath = path.join(outDir, 'export.json');
  fs.writeFileSync(combinedPath, JSON.stringify(combined, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const files = fs.readdirSync(outDir);
  console.log(`\nWrote ${files.length} file(s) to ${outDir}`);
  console.log(`Total records: ${manifest.totalRecords}`);
  console.log(`\nImport with:\n  node scripts/import-json.js "${combinedPath}"\n`);
})().catch(e => { console.error(e); process.exit(1); });