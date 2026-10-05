require('dotenv').config();
const admin = require('firebase-admin');

// Firebase Admin SDK initialization
// Replace .env values with your actual Firebase service account credentials
// NOTE: the Realtime Database was removed from this project. This app is
// Firestore-only (see config/db.js) and the legacy RTDB instance was empty.
let firestore = null; // Firestore (primary — Unified Firestore Database per CAPSTONE spec §5.1)
let auth = null;

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
    // Primary store: Firestore (flat collections, see config/db.js + firestore.rules)
    firestore = admin.firestore();
    auth = admin.auth();
    console.log('Firebase Admin SDK connected successfully (Firestore primary)');
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

module.exports = { firestore, auth, admin, firebaseClientConfig };
