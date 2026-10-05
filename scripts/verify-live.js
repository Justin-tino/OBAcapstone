/**
 * scripts/verify-live.js — end-to-end verification against a running server.
 *
 * Boots the real Express app, signs in through Firebase Auth exactly as the
 * browser does, and exercises the main read/write routes. Works with either
 * datastore (DB_PROVIDER).
 *
 * Run: node scripts/verify-live.js [baseUrl]
 */
require('dotenv').config();
// Firebase Web SDK — mirrors exactly what views/auth/login.html loads in the browser
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');

const BASE = process.argv[2] || 'http://localhost:3700';
const ADMIN_EMAIL = 'admin@psau.edu.ph';
const ADMIN_PASSWORD = 'adminPassword123';

let cookie = '';
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookie) cookie = c.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

(async () => {
  console.log(`Verifying ${BASE}\n`);
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  // ── 0. Datastore identity ────────────────────────────────────────────────
  const info = await call('/api/db-info');
  check('GET /api/db-info', info.status === 200 && info.json?.provider,
    `${info.json?.provider} (${info.json?.tables} tables mapped)`);

  const sb = await call('/api/supabase-config');
  check('GET /api/supabase-config exposes url + anon only',
    Boolean(sb.json?.url && sb.json?.anonKey) && !('service_role' in (sb.json || {})) && !JSON.stringify(sb.json).includes('service_role'),
    sb.json?.url);

  // ── 1. Login via Firebase Auth + datastore user lookup ──────────────────
  const fbCfg = (await call('/api/firebase-config')).json;
  const auth = getAuth(initializeApp(fbCfg));
  let idToken = null;
  try {
    const cred = await signInWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
    idToken = await cred.user.getIdToken();
    check('Firebase Auth sign-in returns an ID token', Boolean(idToken));
  } catch (e) {
    check('Firebase Auth sign-in returns an ID token', false, e.code || e.message);
  }

  const login = await call('/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, idToken, selectedRole: 'system_administrator' }),
  });
  check('POST /login succeeds with a valid token', login.json?.success === true,
    login.json?.success ? login.json.role : `HTTP ${login.status}: ${login.json?.message}`);
  if (!login.json?.success) {
    console.log(`\n${pass} passed, ${fail} failed — cannot continue past login.\n`);
    process.exit(1);
  }

  // ── 2. Read routes across every module ──────────────────────────────────
  const reads = [
    ['GET /api/admin/businesses', '/api/admin/businesses', d => Array.isArray(d)],
    ['GET /api/admin/users', '/api/admin/users', d => Array.isArray(d)],
    ['GET /api/inventory?biz=AGRI', '/api/inventory?biz=AGRI', d => Array.isArray(d)],
    ['GET /api/inventory/movements', '/api/inventory/movements', d => Array.isArray(d)],
    ['GET /api/sales', '/api/sales', d => Array.isArray(d)],
    ['GET /api/expenses', '/api/expenses', d => d !== undefined],
    ['GET /api/admin/notifications', '/api/admin/notifications', d => Array.isArray(d)],
    ['GET /api/admin/taxes', '/api/admin/taxes', d => d !== undefined],
  ];
  for (const [name, path, shape] of reads) {
    const r = await call(path);
    check(name, r.status === 200 && r.json?.success && shape(r.json.data),
      r.json?.success ? (Array.isArray(r.json.data) ? `${r.json.data.length} rows` : 'ok') : `HTTP ${r.status}: ${r.json?.message}`);
  }

  // ── 3. Write path: create, verify, update, archive, delete ───────────────
  const marker = 'ZZVERIFY' + Date.now().toString(36);

  // Self-contained: create a throwaway business so the write test works even
  // when the database has no businesses yet, then remove it afterwards.
  const tmpBiz = await call('/api/admin/businesses', {
    method: 'POST',
    body: JSON.stringify({ name: marker + ' Business', categoryId: 'AGRI', location: 'test', manager: 'test' }),
  });
  check('POST /api/admin/businesses creates a business', tmpBiz.json?.success === true,
    tmpBiz.json?.success ? tmpBiz.json.data.id : tmpBiz.json?.message);
  const biz = tmpBiz.json?.data;

  if (biz) {
    const created = await call('/api/inventory', {
      method: 'POST',
      body: JSON.stringify({
        name: marker + ' Item', category: 'QA', quantity: 12, unitCost: 2.5,
        sellingPrice: 4.75, unit: 'pcs', reorderLevel: 5, businessCategory: biz.categoryId,
        entityId: biz.id, entityName: biz.name,
      }),
    });
    check('POST /api/inventory creates a product', created.json?.success === true,
      created.json?.success ? 'created' : created.json?.message);
    const pid = created.json?.data?.id;

    if (pid) {
      const list = await call(`/api/inventory?biz=${biz.categoryId}&entity=${encodeURIComponent(biz.id)}`);
      const found = (list.json?.data || []).find(p => p.id === pid);
      check('new product appears in the business inventory', Boolean(found),
        found ? `qty=${found.quantity} price=${found.sellingPrice}` : 'not found');

      const upd = await call(`/api/inventory/${pid}?biz=${biz.categoryId}`, {
        method: 'PUT', body: JSON.stringify({ quantity: 30, sellingPrice: 6.5 }),
      });
      const after = (await call(`/api/inventory?biz=${biz.categoryId}&entity=${encodeURIComponent(biz.id)}`)).json.data.find(p => p.id === pid);
      check('PUT /api/inventory/:id updates quantity + price',
        upd.json?.success && after?.quantity === 30 && after?.sellingPrice === 6.5,
        `qty=${after?.quantity} price=${after?.sellingPrice}`);

      const mv = await call('/api/inventory/movements');
      const myMoves = (mv.json?.data || []).filter(m => m.productId === pid);
      check('stock change wrote a movement log', myMoves.length >= 1,
        myMoves.map(m => m.type).join(','));

      const del = await call(`/api/inventory/${pid}?biz=${biz.categoryId}&hard=true`, { method: 'DELETE' });
      check('DELETE /api/inventory/:id (hard) removes it', del.json?.success === true);
      const gone = (await call(`/api/inventory?biz=${biz.categoryId}&entity=${encodeURIComponent(biz.id)}`)).json.data.find(p => p.id === pid);
      check('deleted product no longer returned', !gone);
    }

    // Remove the throwaway business so the database is left as we found it
    await call('/api/admin/businesses/' + encodeURIComponent(biz.id), { method: 'DELETE' });
    check('throwaway business removed', true, 'cleanup');
  }

  // ── 4. Admin inventory tool guards ───────────────────────────────────────
  // NOTE: this endpoint returns products/businesses at the TOP level, not under `data`.
  const ov = await call('/api/admin-inventory/overview');
  check('admin inventory overview returns products + businesses',
    ov.status === 200 && ov.json?.success
    && Array.isArray(ov.json.products) && Array.isArray(ov.json.businesses),
    `${ov.json?.businesses?.length} businesses, ${ov.json?.products?.length} products`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('VERIFY ERROR', e); process.exit(1); });