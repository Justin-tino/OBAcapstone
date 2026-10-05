/**
 * Diagnostic: identify exactly WHICH Firestore quota is exhausted.
 *
 * gRPC returns errorInfo with a reason:
 *   DAILY_LIMIT_EXCEEDED / DAILY_LIMIT_EXCEEDED_UNREGISTERED  → resets midnight PT
 *   RATE_LIMIT_EXCEEDED                                        → clears in seconds
 *   throughput / concurrent limits                             → clears in seconds
 *
 * Knowing which one decides whether waiting helps or Blaze is required.
 */
require('dotenv').config();
const admin = require('firebase-admin');

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

const fs = admin.firestore();

(async () => {
  console.log('\nAttempting one Firestore read and dumping the full error…\n');
  try {
    const snap = await fs.collection('users').limit(1).get();
    console.log('SUCCESS — reads are available right now. docs =', snap.size);
    process.exit(0);
  } catch (e) {
    console.log('code        :', e.code);
    console.log('message     :', (e.details || e.message || '').slice(0, 300));
    console.log('status      :', e.status);
    console.log('\nerrorInfo   :', JSON.stringify(e.errorInfo || e.metadata || {}, null, 2));
    const full = JSON.stringify(e, Object.getOwnPropertyNames(e));
    console.log('\nreason hints:', (full.match(/DAILY_LIMIT[A-Z_]*|RATE_LIMIT_EXCEEDED|THROUGHPUT|QUOTA_EXCEEDED/g) || ['(none found)']).join(', '));
  }

  // Is it project-wide or just this collection?
  console.log('\nProbing several collections to see if any read succeeds…');
  for (const c of ['users', 'businesses', 'inventory', 'settings', 'sales']) {
    try {
      const s = await fs.collection(c).limit(1).get();
      console.log(`  ${c.padEnd(12)} OK (${s.size})`);
    } catch (e2) {
      console.log(`  ${c.padEnd(12)} ${e2.code}`);
    }
  }
  process.exit(1);
})();