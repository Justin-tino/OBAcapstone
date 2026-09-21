// Legacy one-off maintenance: clear numeric-only `unit` fields on inventory docs.
// Firestore version. Run: node fix_units.js
const { firestore } = require('./config/firebase.js');

if (!firestore) {
  console.log('No DB');
  process.exit(0);
}

(async () => {
  const snap = await firestore.collection('inventory').get();
  let fixed = 0;
  const batch = firestore.batch();
  snap.docs.forEach(d => {
    const prod = d.data() || {};
    if (prod.unit === '10' || prod.unit === 10 || String(parseInt(prod.unit, 10)) === String(prod.unit)) {
      batch.update(d.ref, { unit: '' });
      fixed++;
    }
  });
  if (fixed > 0) {
    await batch.commit();
    console.log(`Fixed unit data on ${fixed} doc(s)`);
  } else {
    console.log('No broken units found');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
