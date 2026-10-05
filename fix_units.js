// Legacy one-off maintenance: clear numeric-only `unit` fields on inventory docs.
// Uses the shared data layer, so it works on whichever backend DB_PROVIDER selects.
// Run: node fix_units.js
require('dotenv').config();
const FDB = require('./config/db');

(async () => {
  const products = await FDB.getAll('inventory');
  if (!products.length) {
    console.log('No inventory docs found');
    process.exit(0);
  }
  const broken = products.filter(p =>
    p.unit === '10' || p.unit === 10 || String(parseInt(p.unit, 10)) === String(p.unit)
  );
  for (const p of broken) {
    await FDB.updateDoc('inventory', p.id, { unit: '' });
  }
  console.log(broken.length ? `Fixed unit data on ${broken.length} doc(s)` : 'No broken units found');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });