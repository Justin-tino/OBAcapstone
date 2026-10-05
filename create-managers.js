require('dotenv').config();
const { auth, firestore } = require('./config/firebase');
const FDB = require('./config/db');

const MANAGERS = [
  {
    email: 'agri_manager@psau.edu.ph',
    name: 'Agri Category Manager',
    businesses: ['AGRI']
  },
  {
    email: 'nonagri_manager@psau.edu.ph',
    name: 'Non-Agri Category Manager',
    businesses: ['NON_AGRI']
  },
  {
    email: 'main_manager@psau.edu.ph',
    name: 'Main Category Manager',
    businesses: ['MAIN']
  }
];

const DEFAULT_PASSWORD = 'managerPassword123';

async function createCategoryManagers() {
  if (!auth || !firestore) {
    console.error(' Firebase is not configured properly in .env');
    process.exit(1);
  }

  console.log(' Starting manager accounts creation...');

  for (const mgr of MANAGERS) {
    try {
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(mgr.email);
        console.log(`ℹ️ User ${mgr.email} already exists in Firebase Auth: ${userRecord.uid}`);
      } catch (e) {
        if (e.code === 'auth/user-not-found') {
          userRecord = await auth.createUser({
            email: mgr.email,
            password: DEFAULT_PASSWORD,
            displayName: mgr.name,
          });
          console.log(`✅ Successfully created ${mgr.name} in Firebase Auth: ${userRecord.uid}`);
        } else {
          throw e;
        }
      }

      // Add the app profile to the users collection (Supabase by default)
      await FDB.setDoc('users', userRecord.uid, {
        id: userRecord.uid,
        uid: userRecord.uid,
        name: mgr.name,
        email: mgr.email,
        role: 'manager',
        businesses: mgr.businesses,
        status: 'active',
        lastLogin: 'Never',
        createdAt: new Date().toISOString(),
      }, true);

      console.log(`✅ Successfully added DB permissions for ${mgr.name}`);
    } catch (error) {
      console.error(`❌ Error creating ${mgr.name}:`, error.message);
    }
  }

  console.log('\n=======================================');
  console.log('Successfully seeded all manager accounts!');
  console.log(`Default Password: ${DEFAULT_PASSWORD}`);
  console.log('Manager Accounts:');
  MANAGERS.forEach(m => {
    console.log(`- ${m.name} (${m.email}) -> Business Access: ${m.businesses.join(', ')}`);
  });
  console.log('=======================================\n');
  process.exit(0);
}

createCategoryManagers();
