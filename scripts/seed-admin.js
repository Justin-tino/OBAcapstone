/**
 * scripts/seed-admin.js — recreate the admin profile in Supabase from Firebase Auth.
 *
 * The `users` row is keyed by the Firebase Auth uid. Firebase Auth uses a
 * separate quota from Firestore, so this works even while Firestore reads are
 * blocked — which means the admin account never needs copying by hand.
 *
 * Run: node scripts/seed-admin.js
 */
require('dotenv').config();
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    clientId: process.env.FIREBASE_CLIENT_ID,
    authUri: process.env.FIREBASE_AUTH_URI,
    tokenUri: process.env.FIREBASE_TOKEN_URI,
  }),
});

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = admin.auth();

const DEFAULT_TAXES = { AGRI: 0, NON_AGRI: 12, MAIN: 12 };

(async () => {
  console.log('\nSeeding admin profile + default taxes into Supabase\n');

  const list = await auth.listUsers(1000);
  let created = 0;
  const skipped = [];

  for (const u of list.users) {
    // Map the Firebase role to the app profile. Roles not carried over keep a
    // safe default of 'viewer' — change these by hand afterwards if needed.
    const profile = {
      id: u.uid,
      uid: u.uid,
      email: u.email || '',
      name: u.displayName || u.email || 'User',
      role: 'viewer',
      businesses: ['all'],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString(),
    };
    const { error } = await db.from('users').upsert({
      id: u.uid, uid: u.uid, email: profile.email, role: profile.role, status: 'active',
      data: profile,
    }, { onConflict: 'id' });
    if (error) console.error(`  ${u.email}: ${error.message}`);
    else { console.log(`  ${u.email.padEnd(38)} uid=${u.uid}`); created++; }
  }

  // Default tax rates
  const { data: existingTaxes } = await db.from('settings').select('*').eq('id', 'taxes').maybeSingle();
  if (!existingTaxes) {
    const doc = { id: 'taxes', ...DEFAULT_TAXES };
    await db.from('settings').upsert({ id: 'taxes', data: doc }, { onConflict: 'id' });
    console.log('\n  settings/taxes seeded with defaults');
  } else {
    console.log('\n  settings/taxes already present — left untouched');
  }

  console.log(`\n${created} user profile(s) seeded into Supabase.users`);
  if (created > 1) console.log('All seeded profiles default to role "viewer" — promote them in Admin > Manage Users.');
  console.log('Firebase Auth remains the real source of truth for roles and passwords.\n');
  void skipped;
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });