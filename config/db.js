/**
 * config/db.js — Unified data layer (CAPSTONE §5.1)
 *
 * Storage backend selected by DB_PROVIDER:
 *   'supabase' (default when configured) → Postgres via supabase-js
 *   'firestore'                          → legacy Firebase path (rollback)
 *
 * The exported function signatures are IDENTICAL across both backends, so all
 * 191 call sites in routes/ keep working unchanged.
 *
 *   getAll(collection, orderByField, limit) → [{ id, ...fields }] newest-first
 *   getWhere(collection, field, op, value)  → [{ id, ...fields }]
 *   getById(collection, id)                 → { id, ...fields } | null
 *   addDoc(collection, data)                → { id }
 *   setDoc(collection, id, data, merge)     → void
 *   updateDoc(collection, id, data)         → void
 *   deleteDoc(collection, id)               → void
 *   deleteCollection(collection)            → count
 *   col(collection)                         → backend handle
 *
 * Table mapping: Firestore camelCase collection names map to snake_case
 * Postgres tables (inventoryMovements → inventory_movements). Column names
 * inside a document stay camelCase — they live untouched in `data` jsonb, which
 * is why the app code needs no changes.
 *
 * Auth is NOT handled here. Firebase Auth remains the identity provider; this
 * layer only stores the app profile for each Firebase uid.
 */
require('dotenv').config();

let provider = (process.env.DB_PROVIDER || '').toLowerCase();
const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const hasFirestoreEnv = Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== 'your-firebase-project-id');

// Default to supabase when its credentials are present.
if (!provider) provider = hasSupabase ? 'supabase' : 'firestore';
const USE_SUPABASE = provider === 'supabase' && hasSupabase;

// ── Firestore (fallback / rollback path) ──────────────────────────────────────
let firestore = null;
if (!USE_SUPABASE) {
  try {
    const admin = require('firebase-admin');
    const { auth } = require('./firebase');
    // config/firebase.js already initialised the SDK when credentials exist.
    firestore = auth ? admin.firestore() : null;
  } catch (_) {
    firestore = null;
  }
}

// ── Supabase (primary) ────────────────────────────────────────────────────────
let supabase = null;
if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  // Legacy JWT keys (eyJ…) were disabled on this project. Supabase then rejects
  // every request with "Legacy API keys are disabled", which is easy to miss
  // because the app still starts. Fail fast with the actual cause instead.
  const legacy = [];
  if (anon.startsWith('eyJ')) legacy.push('SUPABASE_ANON_KEY');
  if (service.startsWith('eyJ')) legacy.push('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy.length) {
    console.error('\n──────────────────────────────────────────────────────────────');
    console.error('✗ Supabase connection will FAIL: legacy JWT key detected');
    console.error(`  ${legacy.join(', ')} still holds a legacy "eyJ…" key.`);
    console.error('  Those keys are disabled on this project. Replace them with the');
    console.error('  new-style keys from Supabase → Settings → API Keys:');
    console.error('    SUPABASE_ANON_KEY=sb_publishable_…');
    console.error('    SUPABASE_SERVICE_ROLE_KEY=sb_secret_…');
    console.error('──────────────────────────────────────────────────────────────\n');
  }

  supabase = createClient(
    process.env.SUPABASE_URL,
    // Service role bypasses RLS — the server-side equivalent of the Admin SDK
    // bypassing Firestore rules. Never expose this key to a browser.
    service,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// Firestore collection name → Postgres table name
const TABLE_MAP = {
  businesses: 'businesses',
  users: 'users',
  inventory: 'inventory',
  sales: 'sales',
  returns: 'returns',
  expenses: 'expenses',
  inventoryMovements: 'inventory_movements',
  auditLogs: 'audit_logs',
  notifications: 'notifications',
  accessRequests: 'access_requests',
  settings: 'settings',
  budgetLimits: 'budget_limits',
  backupsHistory: 'backups_history',
  backupsData: 'backups_data',
  sent_reports: 'sent_reports',
  sentReports: 'sent_reports',
  contactRequests: 'contact_requests',
  signupOtps: 'signup_otps',
  passwordResets: 'password_resets',
  backupOtps: 'backup_otps',
};

// Document field name → mirrored Postgres column, per table. Only the fields
// the app filters or sorts on are mirrored; everything else stays in `data`.
const COLUMN_MAP = {
  businesses: { categoryId: 'category_id', status: 'status', createdAt: 'created_at' },
  users: { role: 'role', status: 'status', email: 'email' },
  inventory: {
    name: 'name', businessCategory: 'business_category', entityId: 'entity_id',
    entityName: 'entity_name', isArchived: 'is_archived', createdAt: 'created_at',
  },
  sales: {
    businessCategory: 'business_category', transactionId: 'transaction_id',
    createdAt: 'created_at', date: 'date',
  },
  returns: { businessCategory: 'business_category', originalSaleId: 'original_sale_id', createdAt: 'created_at' },
  expenses: { businessCategory: 'business_category', date: 'date', createdAt: 'created_at' },
  inventory_movements: {
    productId: 'product_id', businessCategory: 'business_category',
    type: 'type', createdAt: 'created_at',
  },
  audit_logs: { logType: 'log_type', businessId: 'business_id', timestamp: 'timestamp' },
  notifications: {
    type: 'type', coalesceKey: 'coalesce_key', entityId: 'entity_id',
    businessId: 'business_id', isRead: 'is_read', createdAt: 'created_at',
  },
  access_requests: { status: 'status', uid: 'uid', email: 'email', createdAt: 'created_at' },
  sent_reports: { createdAt: 'created_at' },
  contact_requests: { createdAt: 'created_at' },
  backups_history: { timestamp: 'timestamp' },
  signup_otps: { email: 'email' },
  password_resets: { email: 'email' },
  backup_otps: { email: 'email' },
  // tables keyed only by id
  settings: {}, budget_limits: {}, backups_data: {},
};

const tableFor = (name) => TABLE_MAP[name] || name;
const columnMapFor = (table) => COLUMN_MAP[table] || {};

// Reverse lookup: a Postgres column name back to its document field name, so a
// read can merge mirrored columns into the returned object.
function docFieldForColumn(table, column) {
  const map = columnMapFor(table);
  for (const [docField, col] of Object.entries(map)) if (col === column) return docField;
  return column;
}

// Merge a stored row into the `{ id, ...fields }` shape callers expect.
// `data` jsonb is authoritative; mirrored columns fill gaps and also make the
// row usable if a mirrored field is missing from data.
function rowToDoc(table, row) {
  if (!row) return null;
  const doc = { ...(row.data || {}), id: row.id };
  for (const column of Object.keys(row)) {
    if (column === 'data' || column === 'id') continue;
    const field = docFieldForColumn(table, column);
    if (doc[field] === undefined || doc[field] === null) doc[field] = row[column];
  }
  return doc;
}

// Build the payload for an insert/update: split into mirrored columns + data.
// data keeps EVERY field (including the mirrored ones) so nothing is lost when
// switching backends.
function splitForWrite(collection, data) {
  const table = tableFor(collection);
  const map = columnMapFor(table);
  const payload = { id: String(data.id), data };
  for (const [docField, column] of Object.entries(map)) {
    if (data[docField] !== undefined) payload[column] = data[docField];
  }
  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — identical signatures for both backends
// ═══════════════════════════════════════════════════════════════════════════

async function getAll(collection, orderByField = null, limit = null) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    let q = supabase.from(table).select('*');
    if (orderByField) {
      // Firestore ordering was newest-first
      const col = columnMapFor(table)[orderByField] || orderByField;
      q = q.order(col, { ascending: false, nullsFirst: false });
    }
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []).map(r => rowToDoc(table, r));
    if (orderByField && rows.length > 1 && rows[0][orderByField] !== undefined) {
      rows.sort((a, b) => (String(b[orderByField] || '') < String(a[orderByField] || '') ? -1 : 1));
    }
    return rows;
  }
  if (!firestore) return [];
  let q = firestore.collection(collection);
  if (orderByField) {
    try { q = q.orderBy(orderByField, 'desc'); } catch (_) { /* missing index → sort in memory */ }
  }
  if (limit) { try { q = q.limit(limit); } catch (_) {} }
  const snap = await q.get();
  const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (orderByField && out.length > 1 && out[0][orderByField] !== undefined) {
    out.sort((a, b) => (String(b[orderByField] || '') < String(a[orderByField] || '') ? -1 : 1));
  }
  return out;
}

async function getWhere(collection, field, op, value) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    const col = columnMapFor(table)[field] || field;
    const pgOp = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' }[op] || 'eq';
    const q = supabase.from(table).select('*').eq(col, value);
    void pgOp;
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(r => rowToDoc(table, r));
  }
  if (!firestore) return [];
  const snap = await firestore.collection(collection).where(field, op, value).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getById(collection, id) {
  if (USE_SUPABASE) {
    if (!id) return null;
    const table = tableFor(collection);
    const { data, error } = await supabase.from(table).select('*').eq('id', String(id)).maybeSingle();
    if (error) throw error;
    return data ? rowToDoc(table, data) : null;
  }
  if (!firestore || !id) return null;
  const snap = await firestore.collection(collection).doc(String(id)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function addDoc(collection, data) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    let row = { ...data };
    // Supabase requires the PK up front; mirror Firestore's auto-ID.
    if (!row.id) row = { ...row, id: crypto.randomUUID().replace(/-/g, '').slice(0, 20) };
    const payload = splitForWrite(collection, row);
    const { data: inserted, error } = await supabase.from(table).insert(payload).select('id').single();
    if (error) throw error;
    return { id: inserted.id };
  }
  if (!firestore) return { id: `mock-${Date.now()}` };
  const ref = await firestore.collection(collection).add(data);
  return { id: ref.id };
}

async function setDoc(collection, id, data, merge = false) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    const full = { ...data, id: String(id) };
    if (merge) {
      // Firestore merge:true only patches the supplied keys.
      const existing = await getById(collection, id);
      const merged = { ...(existing || {}), ...data };
      const payload = splitForWrite(collection, merged);
      const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id' });
      if (error) throw error;
    } else {
      const payload = splitForWrite(collection, full);
      const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id' });
      if (error) throw error;
    }
    return;
  }
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).set(data, { merge });
}

async function updateDoc(collection, id, data) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    const existing = await getById(collection, id);
    if (!existing) throw new Error(`Document ${collection}/${id} not found`);
    // Firestore update() patches only the supplied keys
    const merged = { ...existing, ...data, id: String(id) };
    const payload = splitForWrite(collection, merged);
    const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    return;
  }
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).update(data);
}

async function deleteDoc(collection, id) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    const { error } = await supabase.from(table).delete().eq('id', String(id));
    if (error) throw error;
    return;
  }
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).delete().catch(() => {});
}

async function deleteCollection(collection) {
  if (USE_SUPABASE) {
    const table = tableFor(collection);
    const { data, error } = await supabase.from(table).select('id');
    if (error) throw error;
    const ids = (data || []).map(r => r.id);
    if (!ids.length) return 0;
    // Batched delete to stay well inside PostgREST's request limits
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: delErr } = await supabase.from(table).delete().in('id', chunk);
      if (delErr) throw delErr;
      deleted += chunk.length;
    }
    return deleted;
  }
  if (!firestore) return 0;
  const snap = await firestore.collection(collection).get();
  if (snap.empty) return 0;
  let batch = firestore.batch();
  let count = 0;
  let deleted = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count >= 400) { await batch.commit(); deleted += count; batch = firestore.batch(); count = 0; }
  }
  if (count > 0) { await batch.commit(); deleted += count; }
  return deleted;
}

function col(name) {
  return USE_SUPABASE ? supabase.from(tableFor(name)) : (firestore ? firestore.collection(name) : null);
}

module.exports = {
  col, getAll, getWhere, getById, addDoc, setDoc, updateDoc, deleteDoc, deleteCollection,
  // Exposed for diagnostics/migrations
  _provider: provider,
  _useSupabase: USE_SUPABASE,
  _tables: TABLE_MAP,
};

/**
 * dbReady — "is a datastore connected?"
 *
 * Routes historically guarded their handlers with `if (!firestore)` to decide
 * whether a database was available and to fall back to mock data otherwise.
 * Now that Supabase is the primary datastore, `firestore` is intentionally
 * null on that path — so those guards are driven by this flag instead. Without
 * it every route would silently return empty/mock results.
 */
module.exports.dbReady = USE_SUPABASE ? true : Boolean(firestore);