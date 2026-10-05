require('dotenv').config();
const admin = require('firebase-admin');

// Firebase Admin SDK initialization
// Replace .env values with your actual Firebase service account credentials
// Firebase is now the IDENTITY provider only. The primary datastore is Supabase
// Postgres (see config/db.js, which picks the backend from DB_PROVIDER).
// `firestore` stays null unless DB_PROVIDER=firestore, so every `if (!firestore)`
// guard in routes/ correctly reports "no database" on the Supabase path.
let firestore = null; // Firestore — legacy rollback path only
let auth = null;      // Firebase Auth — primary (users still sign in here)

try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== 'your-firebase-project-id') {
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
    // Auth is always on. Firestore is only opened for the rollback path.
    const dbProvider = (process.env.DB_PROVIDER || '').toLowerCase();
    if (dbProvider === 'firestore') {
      firestore = admin.firestore();
      console.log('Firebase Admin SDK connected (Firestore — legacy rollback mode)');
    } else {
      console.log('Firebase Admin SDK connected (Auth only; datastore is Supabase)');
    }
    auth = admin.auth();
  } else {
    console.log('Firebase credentials not configured. Running in demo/mock mode.');
    console.log('Fill in your .env file with actual Firebase credentials to connect.');
  }
} catch (err) {
  console.error('Firebase initialization error:', err.message);
}

// Firebase Client SDK config (for frontend use)
const firebaseClientConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'PLACEHOLDER',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'PLACEHOLDER',
  projectId: process.env.FIREBASE_PROJECT_ID || 'PLACEHOLDER',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'PLACEHOLDER',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || 'PLACEHOLDER',
  appId: process.env.FIREBASE_APP_ID || 'PLACEHOLDER',
};

// Supabase client config for the frontend (mirrors the Firebase pattern).
// Only the PUBLIC anon key is ever exposed — the service-role key is
// server-side only, and RLS is enabled with zero policies so the anon key
// cannot read any table.
const supabaseClientConfig = {
  url: process.env.SUPABASE_URL || 'PLACEHOLDER',
  anonKey: process.env.SUPABASE_ANON_KEY || 'PLACEHOLDER',
};

module.exports = { firestore, auth, admin, firebaseClientConfig, supabaseClientConfig };
