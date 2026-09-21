/* Temp integration test for the Return/Refund endpoints. Safe cleanup at end. */
process.env.PORT = '3998';
const express = require('express');
const FDB = require('./config/db');

async function main() {
  const app = express();
  app.use(express.json());
  // Fake authenticated session (Sales Staff-like with full access)
  app.use((req, res, next) => {
    req.session = { user: { uid: 'test-uid', name: 'Test Runner', email: 'test@test.local', role: 'sales_staff', businessAccess: ['all'] } };
    next();
  });
  app.use('/api/sales', require('./routes/sales'));
  const server = app.listen(3998);

  const B = 'AGRI';
  // 1) create test product
  const inv = await FDB.addDoc('inventory', {
    name: '__TEST_RETURN_PRODUCT__', category: 'test', quantity: 10, reorderLevel: 3,
    sellingPrice: 100, unitCost: 50, businessCategory: B, status: 'in-stock'
  });
  // 2) create a sale of 2 units (like POS would have recorded)
  const sale = await FDB.addDoc('sales', {
    date: new Date().toISOString(), items: [{ id: inv.id, name: '__TEST_RETURN_PRODUCT__', category: 'test', quantity: 2, qty: 2, unitPrice: 100, subtotal: 200 }],
    subtotal: 200, taxRate: 0, taxAmount: 0, total: 200, paymentMethod: 'cash',
    customerName: 'Walk-in', businessCategory: B, createdAt: new Date().toISOString()
  });
  await FDB.updateDoc('sales', sale.id, { id: sale.id, transactionId: 'TXN-' + String(sale.id).substring(0, 8).toUpperCase() });
  const txnId = 'TXN-' + String(sale.id).substring(0, 8).toUpperCase();

  const call = (path, opts) => fetch('http://localhost:3998' + path, opts).then(r => r.json().then(b => ({ status: r.status, body: b })));

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra || ''); } };

  // 3) lookup
  const lookup = await call(`/api/sales/lookup?txnId=${txnId}&biz=${B}`);
  check('lookup finds sale', lookup.status === 200 && lookup.body.success && lookup.body.data.sale.id === sale.id, JSON.stringify(lookup.body));
  check('lookup remaining qty', (lookup.body.data.sale.items[0].quantity) === 2);

  // 4) process return of 1 unit
  const ret = await call(`/api/sales/${sale.id}/return`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: inv.id, name: '__TEST_RETURN_PRODUCT__', quantity: 1 }], reason: 'test return', restock: true })
  });
  check('return processed', ret.status === 200 && ret.body.success, JSON.stringify(ret.body));
  if (ret.body.success) {
    check('return id prefix', String(ret.body.data.returnId).startsWith('RTN-'), ret.body.data.returnId);
    check('refund total = 100', ret.body.data.refundTotal === 100, ret.body.data.refundTotal);
  }
  const invAfter = await FDB.getById('inventory', inv.id);
  check('inventory restocked 10 -> 11', parseInt(invAfter.quantity) === 11, invAfter.quantity);
  const movement = await FDB.getWhere('inventoryMovements', 'productId', '==', inv.id);
  check('RETURN movement logged', movement.some(m => m.type === 'RETURN' && m.quantityChange === 1));

  // 5) over-return should fail (only 1 remaining)
  const over = await call(`/api/sales/${sale.id}/return`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: inv.id, name: '__TEST_RETURN_PRODUCT__', quantity: 2 }], reason: 'over' })
  });
  check('over-return rejected', over.status === 400, JSON.stringify(over.body));

  // 6) second partial return OK (remaining 1)
  const ret2 = await call(`/api/sales/${sale.id}/return`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: inv.id, name: '__TEST_RETURN_PRODUCT__', quantity: 1 }], reason: 'second' })
  });
  check('second partial return OK', ret2.status === 200 && ret2.body.success, JSON.stringify(ret2.body));

  // 7) fully returned -> lookup shows returnedMap
  const lookup2 = await call(`/api/sales/lookup?txnId=${txnId}&biz=${B}`);
  check('returnedMap updated', lookup2.body.data.returnedMap[inv.id] === 2, JSON.stringify(lookup2.body.data.returnedMap));

  // 8) returns list contains both
  const list = await call(`/api/sales/returns?biz=${B}`);
  const mine = (list.body.data || []).filter(r => r.originalSaleId === sale.id);
  check('return history lists 2', mine.length === 2, mine.length);

  // 9) negative adjustment sales records exist
  const adjSales = await FDB.getWhere('sales', 'linkedSaleId', '==', sale.id);
  check('2 negative adjustment sales', adjSales.length === 2 && adjSales.every(s => s.total < 0 && s.paymentMethod === 'RETURN_ADJUSTMENT'), adjSales.length);

  // ── cleanup ──
  await FDB.deleteDoc('inventory', inv.id);
  await FDB.deleteDoc('sales', sale.id);
  for (const r of mine) await FDB.deleteDoc('returns', r.id);
  for (const a of adjSales) await FDB.deleteDoc('sales', a.id);
  for (const m of movement.filter(x => x.productName === '__TEST_RETURN_PRODUCT__')) await FDB.deleteDoc('inventoryMovements', m.id);
  const logs = await FDB.getWhere('auditLogs', 'action', '==', 'PROCESS_RETURN');
  for (const l of logs.filter(x => (x.details || '').includes(txnId) || (x.details || '').includes('__TEST_RETURN_PRODUCT__'))) await FDB.deleteDoc('auditLogs', l.id).catch(() => {});

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
