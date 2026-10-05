/**
 * config/db.js — Unified Firestore data layer (CAPSTONE §5.1)
 *
 * Flat collections (no nested category paths):
 *   users/{uid}, businesses/{bizId}, accessRequests/{id},
 *   sales/{id} (field businessCategory), inventory/{id} (field businessCategory),
 *   expenses/{id} (field businessCategory), inventoryMovements/{id},
 *   auditLogs/{id}, notifications/{id}, budgetLimits/{biz},
 *   settings/taxes, signupOtps/{emailKey}, passwordResets/{token},
 *   contactRequests/{id}, sent_reports/{id}, backupsHistory/{id}, backupsData/{id}
 *
 * All helpers are null-safe: when Firestore is not configured they resolve
 * to empty results so routes can fall back to mock stores.
 */
const { firestore } = require('./firebase');

function col(name) {
  if (!firestore) return null;
  return firestore.collection(name);
}

async function getAll(collection, orderByField = null, limit = null) {
  // Returns [{ id, ...data }] sorted newest-first when orderByField given.
  if (!firestore) return [];
  let q = firestore.collection(collection);
  if (orderByField) {
    try { q = q.orderBy(orderByField, 'desc'); } catch (_) { /* missing index → sort in memory below */ }
  }
  if (limit) { try { q = q.limit(limit); } catch (_) {} }
  const snap = await q.get();
  const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (orderByField && out.length > 1 && out[0][orderByField] !== undefined) {
    // Ensure desc order even if Firestore ordering was skipped
    out.sort((a, b) => String(b[orderByField] || '') < String(a[orderByField] || '') ? -1 : 1);
  }
  return out;
}

async function getWhere(collection, field, op, value) {
  if (!firestore) return [];
  const snap = await firestore.collection(collection).where(field, op, value).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getById(collection, id) {
  if (!firestore || !id) return null;
  const snap = await firestore.collection(collection).doc(String(id)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function addDoc(collection, data) {
  if (!firestore) return { id: `mock-${Date.now()}` };
  const ref = await firestore.collection(collection).add(data);
  return { id: ref.id };
}

async function setDoc(collection, id, data, merge = false) {
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).set(data, { merge });
}

async function updateDoc(collection, id, data) {
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).update(data);
}

async function deleteDoc(collection, id) {
  if (!firestore) return;
  await firestore.collection(collection).doc(String(id)).delete().catch(() => {});
}

async function deleteCollection(collection) {
  // Batched wipe of a whole collection (used by reset script)
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

module.exports = { col, getAll, getWhere, getById, addDoc, setDoc, updateDoc, deleteDoc, deleteCollection };
