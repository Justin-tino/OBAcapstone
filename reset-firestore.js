/**
 * reset-firestore.js — DESTRUCTIVE reset for the OBA System.
 *
 * Wipes all data collections + Firebase Auth users, keeping only the default
 * admin (admin@psau.edu.ph), then reseeds admin + default settings.
 *
 * Data now lives in Supabase Postgres (see config/db.js, DB_PROVIDER). Firebase
 * Auth is still the identity provider, so Auth users are still reset here.
 *
 * Usage: node reset-firestore.js --confirm
 */
require('dotenv').config();
const { auth, firestore } = require('./config/firebase');
const FDB = require('./config/db');
const { deleteCollection } = require('./config/db');

const ADMIN_EMAIL = 'admin@psau.edu.ph';
const ADMIN_PASSWORD = 'adminPassword123';
const ADMIN_NAME = 'Default Admin';

// Flat collections (CAPSTONE §5.1 unified database)
const COLLECTIONS_TO_WIPE = [
  'businesses',
  'accessRequests',
  'sales',
  'returns',
  'inventory',
  'expenses',
  'inventoryMovements',
  'auditLogs',
  'notifications',
  'budgetLimits',
  'signupOtps',
  'passwordResets',
  'contactRequests',
  'sent_reports',
  'backupsHistory',
  'backupsData',
  'backupOtps',
  'users', // wiped separately (keep admin doc)
];

async function wipeCollection(name) {
  const n = await deleteCollection(name);
  console.log(`  🧹 ${name}: deleted ${n} doc(s)`);
  return n;
}

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('⛔ Refusing to wipe without explicit confirmation.');
    console.error('   Run: node reset-firestore.js --confirm');
    process.exit(1);
  }
  if (!auth) {
    console.error('❌ Firebase is not configured properly in .env');
    process.exit(1);
  }

  console.log(`🚨 Starting ${FDB._provider} + Auth reset (keeping admin)...`);

  // 1. Wipe data collections (users handled below to preserve admin)
  for (const c of COLLECTIONS_TO_WIPE.filter(c => c !== 'users')) {
    try { await wipeCollection(c); } catch (e) { console.error(`  ❌ ${c}: ${e.message}`); }
  }

  // 2. Delete all Auth users except admin
  console.log('👤 Cleaning Firebase Auth users...');
  let nextPageToken;
  const keepUids = new Set();
  try {
    const adminRec = await auth.getUserByEmail(ADMIN_EMAIL).catch(() => null);
    if (adminRec) keepUids.add(adminRec.uid);
  } catch (_) {}
  let deletedAuth = 0;
  do {
    const list = await auth.listUsers(1000, nextPageToken);
    for (const u of list.users) {
      if (keepUids.has(u.uid)) continue;
      await auth.deleteUser(u.uid).catch(() => {});
      deletedAuth++;
    }
    nextPageToken = list.pageToken;
  } while (nextPageToken);
  console.log(`  🧹 auth: deleted ${deletedAuth} user(s)`);

  // 3. Wipe users collection except admin doc
  const users = await FDB.getAll('users');
  let deletedDocs = 0;
  for (const u of users) {
    const email = String(u.email || '').toLowerCase();
    if (email === ADMIN_EMAIL || keepUids.has(u.id)) continue;
    await FDB.deleteDoc('users', u.id).catch(() => {});
    deletedDocs++;
  }
  console.log(`  🧹 users: deleted ${deletedDocs} doc(s), kept admin`);

  // 4. Ensure admin exists in Auth + the users table
  let adminRec;
  try {
    adminRec = await auth.getUserByEmail(ADMIN_EMAIL);
    console.log('  ℹ️ admin auth already exists:', adminRec.uid);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      adminRec = await auth.createUser({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, displayName: ADMIN_NAME });
      console.log('  ✅ created admin auth:', adminRec.uid);
    } else throw e;
  }
  await FDB.setDoc('users', adminRec.uid, {
    id: adminRec.uid,
    uid: adminRec.uid,
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    role: 'system_administrator',
    businesses: ['all'],
    status: 'active',
    lastLogin: 'Never',
    createdAt: new Date().toISOString(),
  }, true);

  // 5. Reset default settings (settings/taxes)
  await FDB.setDoc('settings', 'taxes', { id: 'taxes', AGRI: 0, NON_AGRI: 12, MAIN: 12 });
  console.log('  ✅ settings/taxes reset to defaults');

  // 6. Seed audit marker
  await FDB.addDoc('auditLogs', {
    action: 'SYSTEM_RESET',
    module: 'admin',
    details: `Full ${FDB._provider} + Auth reset executed (kept admin)`,
    logType: 'transaction',
    previousValue: null, newValue: null, businessId: null,
    userId: adminRec.uid, userName: ADMIN_NAME, userEmail: ADMIN_EMAIL,
    timestamp: new Date().toISOString(), isSuspicious: true,
  });

  console.log('\n=======================================');
  console.log('✅ Reset complete. Fresh state:');
  console.log(`   Admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log('   All other collections are empty.');
  console.log('=======================================\n');
  void firestore;
  process.exit(0);
}

main().catch(e => { console.error('❌ Reset failed:', e); process.exit(1); });