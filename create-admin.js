require('dotenv').config();
const { auth, firestore } = require('./config/firebase');
const FDB = require('./config/db');

async function createDefaultAdmin() {
  if (!auth || !firestore) {
    console.error('❌ Firebase is not configured properly in .env');
    process.exit(1);
  }

  const email = 'admin@psau.edu.ph';
  const password = 'adminPassword123';
  const name = 'Default Admin';

  try {
    let userRecord;
    try {
      // Check if user already exists
      userRecord = await auth.getUserByEmail(email);
      console.log('User already exists in Firebase Auth:', userRecord.uid);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // Create new user in Firebase Auth
        userRecord = await auth.createUser({
          email,
          password,
          displayName: name,
        });
        console.log('✅ Successfully created new admin user in Firebase Auth:', userRecord.uid);
      } else {
        throw e;
      }
    }

    // Add admin role to the users collection (Supabase by default)
    await FDB.setDoc('users', userRecord.uid, {
      id: userRecord.uid,
      uid: userRecord.uid,
      name,
      email,
      role: 'system_administrator',
      businesses: ['all'],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString(),
    }, true);

    // Ensure default tax rates exist (settings/taxes)
    const existingTaxes = await FDB.getById('settings', 'taxes');
    if (!existingTaxes) {
      await FDB.setDoc('settings', 'taxes', { id: 'taxes', AGRI: 0, NON_AGRI: 12, MAIN: 12 });
    }
    void firestore;

    console.log('✅ Successfully added admin permissions to Firestore!');
    console.log('\n=======================================');
    console.log('You can now log in with:');
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
    console.log('=======================================\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }
}

createDefaultAdmin();
