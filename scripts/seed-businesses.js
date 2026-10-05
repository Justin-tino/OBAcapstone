/**
 * scripts/seed-businesses.js — create the business workspaces in Supabase.
 *
 * WHY THIS EXISTS
 * ---------------
 * Firestore's free-tier daily read quota is exhausted, so the existing
 * business records cannot be copied programmatically. These rows are rebuilt
 * from the business list the app itself rendered (names, the second value
 * shown for each row, and the category grouping).
 *
 * PROVENANCE / WHAT IS APPROXIMATE — please review in Admin > Business:
 *   - `name` and `categoryId`   : observed directly, reliable.
 *   - `location`                 : the app renders location || manager || id,
 *                                 so for rows showing a person-style name this
 *                                 may actually have been the MANAGER field.
 *   - `id`                       : regenerated using the app's own
 *                                 CATEGORY-slug-timestamp scheme, because two
 *                                 of the original ids were not captured.
 *   - status/description/createdAt: not observed — set to sane defaults.
 *
 * Nothing is invented beyond these defaults, and no products are created here.
 * Use Admin > Business Inventory to bulk-load products afterwards.
 *
 * Run: node scripts/seed-businesses.js [--dry-run]
 */
require('dotenv').config();
const FDB = require('../config/db');

const BUSINESSES = [
  // ── Agriculture (7) ──────────────────────────────────────────────────────
  { name: 'Agri B6',         location: 'Kholeen',             categoryId: 'AGRI' },
  { name: 'Tamarind RDEC',   location: 'PSAU',                categoryId: 'AGRI' },
  { name: 'Agri-B2',         location: 'AGRI-b-4-mu1o61fv',   categoryId: 'AGRI' },
  { name: 'Agri-B3',         location: 'PSAU',                categoryId: 'AGRI' },
  { name: 'Agri-B4',         location: 'Palayan',             categoryId: 'AGRI' },
  { name: 'NSTP',            location: 'OBA',                 categoryId: 'AGRI' },
  { name: 'Housing Rentals', location: 'Saamin',              categoryId: 'AGRI' },

  // ── Non-Agriculture (4) ──────────────────────────────────────────────────
  { name: 'nonAgri-B5',      location: 'AGRI-agri-b5-mu7yykit', categoryId: 'NON_AGRI' },
  { name: 'UFC',             location: 'PSAU',                categoryId: 'NON_AGRI' },
  { name: 'N-B1',            location: 'PSAU',                categoryId: 'NON_AGRI' },
  { name: 'Souvenir',        location: 'Kholeen',             categoryId: 'NON_AGRI' },

  // ── Main (3) ─────────────────────────────────────────────────────────────
  { name: 'M-B1',            location: 'PSAU',                categoryId: 'MAIN' },
  { name: 'M-B2',            location: 'PSAU',                categoryId: 'MAIN' },
  { name: 'M-B3',            location: 'PSAU',                categoryId: 'MAIN' },
];

// Same id scheme as POST /api/admin/businesses in routes/admin.js
function makeId(categoryId, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'biz';
  return `${categoryId}-${slug}-${Date.now().toString(36)}`;
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\nSeeding ${BUSINESSES.length} businesses into ${FDB._provider}${dryRun ? '  (dry run)' : ''}\n`);

  const existing = await FDB.getAll('businesses');
  if (existing.length) {
    console.log(`⚠️  ${existing.length} business(es) already exist. Nothing will be created.`);
    console.log('   Delete them first if you want a clean re-seed.\n');
    return;
  }

  let made = 0;
  for (const b of BUSINESSES) {
    const doc = {
      id: makeId(b.categoryId, b.name),
      name: b.name,
      categoryId: b.categoryId,
      type: b.categoryId,
      location: b.location,
      manager: '',
      description: '',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: 'seed-businesses.js (rebuilt from observed list)',
    };
    if (dryRun) { console.log(`  would create  ${b.categoryId.padEnd(8)} ${b.name}`); made++; continue; }
    try {
      await FDB.setDoc('businesses', doc.id, doc);
      console.log(`  created  ${b.categoryId.padEnd(8)} ${doc.id}`);
      made++;
    } catch (e) {
      console.log(`  FAILED   ${b.name}: ${e.message}`);
    }
  }

  console.log(`\n${made} business(es) ${dryRun ? 'would be ' : ''}created.`);

  if (!dryRun) {
    const all = await FDB.getAll('businesses');
    console.log(`\nVerify — ${all.length} rows now in the businesses table:`);
    const byCat = {};
    for (const b of all) (byCat[b.categoryId] ||= []).push(b.name);
    for (const [cat, names] of Object.entries(byCat)) {
      console.log(`  ${cat.padEnd(8)} (${names.length}): ${names.join(', ')}`);
    }
  }
  console.log('\nNext: open /admin/all-inventory and use Bulk Add to load products per business.\n');
})().catch(e => { console.error(e); process.exit(1); });