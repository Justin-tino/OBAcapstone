/**
 * scripts/test-datalayer.js — unit tests for config/db.js
 *
 * Intercepts @supabase/supabase-js with a fake client so the layer's query
 * building, column mapping, merge semantics and doc shape can be verified
 * without a live database. This catches the class of bugs that would otherwise
 * only surface once tables exist.
 *
 * Run: node scripts/test-datalayer.js
 */
const assert = require('assert');
const path = require('path');

// ── Install a fake supabase-js BEFORE config/db.js is required ───────────────
const calls = [];
let store = {};       // table -> { id: row }
let failNext = null;

function makeQuery(table) {
  const q = {
    _table: table,
    _filters: [],
    _order: null,
    _limit: null,
    _single: false,
    select(_cols, opts) {
      if (opts && opts.head) { q._head = true; }
      return q;
    },
    eq(col, val) { q._filters.push({ type: 'eq', col, val }); return q; },
    neq(col, val) { q._filters.push({ type: 'neq', col, val }); return q; },
    in(col, vals) { q._filters.push({ type: 'in', col, vals }); return q; },
    order(col, opts) { q._order = { col, ...opts }; return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() { q._maybe = true; return q; },
    single() { q._single = true; return q; },
    upsert(rows, opts) {
      const arr = [].concat(rows);
      calls.push({ op: 'upsert', table, rows: arr, opts });
      for (const r of arr) {
        store[table] = store[table] || {};
        store[table][String(r.id)] = { ...(store[table][String(r.id)] || {}), ...r };
      }
      // supabase-js allows .insert(...).select('id').single()
      const chain = {
        select: () => chain,
        single: () => Promise.resolve({ data: { id: String(arr[0].id) }, error: null }),
        maybeSingle: () => Promise.resolve({ data: { id: String(arr[0].id) }, error: null }),
        then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
      };
      return chain;
    },
    insert(rows) {
      const arr = [].concat(rows);
      calls.push({ op: 'insert', table, rows: arr });
      for (const r of arr) store[table][String(r.id)] = { ...r };
      const chain = {
        select: () => chain,
        single: () => Promise.resolve({ data: { id: String(arr[0].id) }, error: null }),
        maybeSingle: () => Promise.resolve({ data: { id: String(arr[0].id) }, error: null }),
        then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
      };
      return chain;
    },
    // delete() must be chainable (.delete().eq(...) / .in(...)) and awaitable
    delete() {
      const filters = [];
      const del = {
        eq: (col, val) => { filters.push({ type: 'eq', col, val }); return del; },
        neq: (col, val) => { filters.push({ type: 'neq', col, val }); return del; },
        in: (col, vals) => { filters.push({ type: 'in', col, vals }); return del; },
        select: () => del,
        then(resolve, reject) {
          calls.push({ op: 'delete', table, filters });
          for (const f of filters) {
            if (f.type === 'neq') {
              // DELETE ... WHERE col <> val  → keep only val
              store[table] = Object.fromEntries(
                Object.entries(store[table] || {}).filter(([id]) => id === String(f.val))
              );
            } else if (f.type === 'eq') {
              // DELETE ... WHERE col = val → remove that one row
              delete (store[table] || {})[String(f.val)];
            } else if (f.type === 'in') {
              const drop = new Set(f.vals.map(String));
              store[table] = Object.fromEntries(
                Object.entries(store[table] || {}).filter(([id]) => !drop.has(id))
              );
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return del;
    },
    then(resolve, reject) {
      // Execute the accumulated query
      let rows = Object.values(store[table] || {}).map(r => ({ ...r }));
      for (const f of q._filters) {
        if (f.type === 'eq') rows = rows.filter(r => r[f.col] === f.val);
        else if (f.type === 'neq') rows = rows.filter(r => r[f.col] !== f.val);
        else if (f.type === 'in') {
          const keep = new Set(f.vals.map(String));
          rows = rows.filter(r => keep.has(String(r.id)));
        }
      }
      if (q._order) {
        rows.sort((a, b) => {
          const av = a[q._order.col], bv = b[q._order.col];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return q._order.ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
        });
      }
      if (q._limit) rows = rows.slice(0, q._limit);
      calls.push({ op: 'select', table, filters: q._filters, order: q._order, limit: q._limit });
      if (failNext) { const e = failNext; failNext = null; return Promise.reject(e); }
      const out = q._maybe ? (rows[0] || null) : rows;
      return Promise.resolve({ data: q._head ? null : out, error: null, count: rows.length })
        .then(resolve, reject);
    },
  };
  return q;
}

const fakeClient = {
  from(table) { store[table] = store[table] || {}; return makeQuery(table); },
  rpc() { return Promise.resolve({ data: null, error: { message: 'no rpc in test' } }); },
};

// Intercept the module load itself — caching the package root is not enough,
// because supabase-js loads through its own entry point.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => fakeClient };
  }
  return origLoad.apply(this, arguments);
};

process.env.DB_PROVIDER = 'supabase';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';

const FDB = require('../config/db');

// ═══════════════════════════════════════════════════════════════════════════
let passed = 0;
let failed = 0;
// test() awaits async assertions so a failing promise is reported, not thrown
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
  })();
}

console.log('\nData layer unit tests\n');

(async () => {
  // ── 1. Table name mapping ────────────────────────────────────────────────
  await test('collection → snake_case table', () => {
    assert.strictEqual(FDB._tables.inventoryMovements, 'inventory_movements');
    assert.strictEqual(FDB._tables.auditLogs, 'audit_logs');
    assert.strictEqual(FDB._tables.accessRequests, 'access_requests');
    assert.strictEqual(FDB._tables.budgetLimits, 'budget_limits');
  });
  await test('provider is supabase', () => {
    assert.strictEqual(FDB._useSupabase, true);
  });

  const { id } = await FDB.addDoc('inventory', {
    name: 'Kwek-kwek', category: 'Frozen', businessCategory: 'AGRI',
    entityId: 'B8', entityName: 'Rice', quantity: 50, unitCost: 12.5,
    sellingPrice: 15, reorderLevel: 10, isArchived: false,
  });
 await test('addDoc returns an id', () => assert.ok(id && id.length > 5, 'id was ' + id));
 await test('addDoc mirrored business_category column', () =>
    assert.strictEqual(calls.find(c => c.op === 'insert').rows[0].business_category, 'AGRI'));
 await test('addDoc kept full doc in data jsonb', () => {
    const d = calls.find(c => c.op === 'insert').rows[0].data;
    assert.strictEqual(d.name, 'Kwek-kwek');
    assert.strictEqual(d.unitCost, 12.5);
    assert.strictEqual(d.quantity, 50);
  });

  // ── 3. getById returns the merged doc shape ───────────────────────────────
  const got = await FDB.getById('inventory', id);
 await test('getById returns { id, ...fields }', () => {
    assert.strictEqual(got.id, id);
    assert.strictEqual(got.name, 'Kwek-kwek');
    assert.strictEqual(got.businessCategory, 'AGRI');
    assert.strictEqual(got.sellingPrice, 15);
    assert.strictEqual(got.entityName, 'Rice');
  });
 await test('numbers stay numbers (no string coercion)', () => {
    assert.strictEqual(typeof got.unitCost, 'number');
    assert.strictEqual(typeof got.quantity, 'number');
  });
 await test('booleans stay booleans', () => assert.strictEqual(got.isArchived, false));

  // ── 4. getWhere maps camelCase field → snake_case column ─────────────────
  await FDB.addDoc('inventory', { name: 'Adobo', businessCategory: 'MAIN', quantity: 5 });
  const where = await FDB.getWhere('inventory', 'businessCategory', '==', 'AGRI');
 await test('getWhere filters on the mirrored column', () => {
    assert.strictEqual(where.length, 1);
    assert.strictEqual(where[0].name, 'Kwek-kwek');
  });
 await test('getWhere emits snake_case eq filter', () =>
    assert.strictEqual(calls.at(-1).filters[0].col, 'business_category'));

  // ── 5. getAll ordering newest-first ───────────────────────────────────────
  await FDB.addDoc('sales', { businessCategory: 'AGRI', createdAt: '2026-01-01T00:00:00.000Z', total: 10 });
  await FDB.addDoc('sales', { businessCategory: 'AGRI', createdAt: '2026-03-01T00:00:00.000Z', total: 30 });
  await FDB.addDoc('sales', { businessCategory: 'AGRI', createdAt: '2026-02-01T00:00:00.000Z', total: 20 });
  const sales = await FDB.getAll('sales', 'createdAt');
 await test('getAll(orderBy) returns newest first', () => {
    assert.deepStrictEqual(sales.map(s => s.total), [30, 20, 10]);
  });
 await test('getAll(orderBy) maps createdAt → created_at column', () =>
    assert.strictEqual(calls.at(-1).order.col, 'created_at'));

  const limited = await FDB.getAll('sales', 'createdAt', 2);
 await test('getAll respects limit', () => assert.strictEqual(limited.length, 2));

  // ── 6. updateDoc patches only supplied keys (Firestore semantics) ────────
  await FDB.updateDoc('inventory', id, { quantity: 99 });
  const afterUpdate = await FDB.getById('inventory', id);
 await test('updateDoc patches the given field', () => assert.strictEqual(afterUpdate.quantity, 99));
 await test('updateDoc leaves other fields intact', () => {
    assert.strictEqual(afterUpdate.name, 'Kwek-kwek');
    assert.strictEqual(afterUpdate.sellingPrice, 15);
    assert.strictEqual(afterUpdate.entityId, 'B8');
  });
 await test('updateDoc re-mirrors the changed column', async () => {
    const c = calls.filter(x => x.op === 'upsert' && x.table === 'inventory').at(-1);
    assert.strictEqual(c.rows[0].data.quantity, 99);
    assert.strictEqual(c.rows[0].name, 'Kwek-kwek');
  });

  // ── 7. updateDoc on a missing doc must throw (routes rely on this) ───────
  let threw = false;
  try { await FDB.updateDoc('inventory', 'nope-not-here', { quantity: 1 }); }
  catch (_) { threw = true; }
 await test('updateDoc throws on missing document', () => assert.ok(threw, 'expected a throw'));

  // ── 8. setDoc merge=true patches, merge=false replaces ───────────────────
  await FDB.setDoc('settings', 'taxes', { AGRI: 0, NON_AGRI: 12, MAIN: 12 });
  await FDB.setDoc('settings', 'taxes', { MAIN: 10 }, true);
  const taxes = await FDB.getById('settings', 'taxes');
 await test('setDoc merge=true keeps other keys', () => {
    assert.strictEqual(taxes.AGRI, 0);
    assert.strictEqual(taxes.NON_AGRI, 12);
    assert.strictEqual(taxes.MAIN, 10);
  });

  // ── 9. deleteDoc ─────────────────────────────────────────────────────────
  const victim = (await FDB.addDoc('inventory', { name: 'Temp', businessCategory: 'AGRI' })).id;
  await FDB.deleteDoc('inventory', victim);
 await test('deleteDoc removes the row', async () => {
    const gone = await FDB.getById('inventory', victim);
    assert.strictEqual(gone, null);
  });

  // ── 10. deleteCollection ─────────────────────────────────────────────────
  await FDB.deleteCollection('sales');
 await test('deleteCollection empties the table', async () => {
    const left = await FDB.getAll('sales');
    assert.strictEqual(left.length, 0);
  });

  // ── 11. Nested/array fields survive the round trip ──────────────────────
  const nestedId = (await FDB.addDoc('sales', {
    businessCategory: 'AGRI',
    items: [{ id: 'a', name: 'Rice', quantity: 2, unitPrice: 10.5 }],
    paymentMethod: 'cash',
    notes: 'multi\nline note with | pipe',
  })).id;
  const nested = await FDB.getById('sales', nestedId);
 await test('array field round-trips', () => {
    assert.ok(Array.isArray(nested.items));
    assert.strictEqual(nested.items[0].name, 'Rice');
    assert.strictEqual(nested.items[0].unitPrice, 10.5);
  });
 await test('string with newline + pipe round-trips', () => {
    assert.strictEqual(nested.notes, 'multi\nline note with | pipe');
  });

  // ── 12. Every mapped table is reachable and case-correct ────────────────
 await test('all mapped collections resolve to a table', () => {
    for (const [coll, table] of Object.entries(FDB._tables)) {
      assert.ok(table && /^[a-z0-9_]+$/.test(table), `${coll} → ${table} is not snake_case`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  void path;
  process.exit(failed ? 1 : 0);
})();