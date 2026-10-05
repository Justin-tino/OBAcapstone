require('dotenv').config();
const { auth, firestore } = require('./config/firebase');

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

    // Add admin role to Firestore (users/{uid})
    await firestore.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      name,
      email,
      role: 'system_administrator',
      businesses: ['all'],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString(),
    }, { merge: true });

    // Ensure default tax rates exist (settings/taxes)
    const taxesSnap = await firestore.collection('settings').doc('taxes').get();
    if (!taxesSnap.exists) {
      await firestore.collection('settings').doc('taxes').set({ AGRI: 0, NON_AGRI: 12, MAIN: 12 });
    }

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
