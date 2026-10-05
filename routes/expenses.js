/**
 * routes/expenses.js
 * Income & Expense tracking per business category
 * Uses Firestore flat collections (see config/db.js)
 * Categories: AGRI, NON_AGRI, MAIN
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { firestore } = require('../config/firebase');
const { requireEmployee, requireManager, requireViewer, validateBizCategory, sanitizeString, accessCoversCategory } = require('../middleware/auth.middleware');

const VALID_EXPENSE_TYPES = ['income', 'expense'];
const VALID_EXPENSE_CATEGORIES = ['utilities', 'suppliers', 'salaries', 'maintenance', 'marketing', 'other', 'supplies', 'rent', 'equipment', 'general'];

async function writeAudit(req, action, details, businessCategory, isSuspicious = false) {
  try {
    if (!firestore || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action, module: 'expenses', details: details || '', logType: 'transaction',
      previousValue: null, newValue: null, businessId: businessCategory || null,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '', timestamp: new Date().toISOString(), isSuspicious,
    }).catch(() => {});
  } catch (_) {}
}

// Canonical budget path is `budgetLimits/{biz}` (doc id = biz, single source).
async function readBudget(biz) {
  if (!firestore) return { totalBudget: 500000, categoryBudgets: {} };
  const doc = await FDB.getById('budgetLimits', biz);
  if (doc) return doc;
  return { totalBudget: 500000, categoryBudgets: {} };
}

async function writeBudget(biz, payload) {
  if (!firestore) return;
  await FDB.setDoc('budgetLimits', biz, payload);
}

// GET /api/expenses?biz=AGRI&entity=ENTITY_ID — list all income/expense entries
router.get('/', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  const entityId = req.query.entity || '';
  try {
    if (!firestore) return res.json({ success: true, data: [] });
    let data = await FDB.getWhere('expenses', 'businessCategory', '==', biz);
    data.sort((a, b) => String(b.date || '') < String(a.date || '') ? -1 : 1);
    if (entityId) data = data.filter(e => e.entityId === entityId);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/expenses — record income or expense
router.post('/', requireEmployee, async (req, res) => {
  const { type, description: rawDesc, amount, date, category: rawCat, notes: rawNotes, businessCategory, entityId, entityName } = req.body;
  const biz = validateBizCategory(businessCategory || 'AGRI');
  const description = sanitizeString(rawDesc || '');
  const category = sanitizeString((rawCat || 'other').toLowerCase());
  const notes = sanitizeString(rawNotes || '');

  // Verify employee has access to this business category
  // (entity-ID-based access like 'AGRI-rice-xxx' covers its parent category,
  // consistent with requireBusinessAccess / accessCoversCategory)
  const userAccess = req.session.user.businessAccess || [];
  if (!accessCoversCategory(userAccess, biz)) {
    return res.status(403).json({ success: false, message: 'Access denied to this business category.' });
  }
  if (!description || !amount) {
    return res.status(400).json({ success: false, message: 'Description and amount are required.' });
  }
  const cleanType = (type || 'expense').toLowerCase();
  if (!VALID_EXPENSE_TYPES.includes(cleanType)) {
    return res.status(400).json({ success: false, message: 'Type must be income or expense.' });
  }
  const cleanAmount = parseFloat(amount);
  if (isNaN(cleanAmount) || cleanAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
  }
  let bizDate = new Date().toISOString().split('T')[0];
  if (date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid date.' });
    bizDate = d.toISOString().split('T')[0];
  }
  const entry = {
    type: cleanType,
    description,
    amount: cleanAmount,
    date: bizDate,
    category: VALID_EXPENSE_CATEGORIES.includes(category) ? category : 'other',
    notes,
    businessCategory: biz,
    entityId: sanitizeString(entityId || ''),
    entityName: sanitizeString(entityName || ''),
    recordedBy: req.session.user.name,
    recordedById: req.session.user.uid,
    createdAt: new Date().toISOString(),
  };
  try {
    if (!firestore) return res.json({ success: true, data: entry });
    const { id } = await FDB.addDoc('expenses', { ...entry, businessCategory: biz });
    entry.id = id;
    await FDB.updateDoc('expenses', id, { id });
    writeAudit(req, cleanType === 'income' ? 'CREATE_INCOME' : 'CREATE_EXPENSE', `${cleanType} "${description}" amount ${cleanAmount} in ${biz} (${bizDate})`, biz);
    res.json({ success: true, data: entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/expenses/:id — update entry
router.put('/:id', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const { businessCategory } = req.body;
  const biz = validateBizCategory(businessCategory || req.query.biz || 'AGRI');

  // Allowlist of fields that can be updated (prevents mass assignment)
  const allowedFields = ['type', 'description', 'amount', 'date', 'category', 'notes', 'entityId', 'entityName', 'businessCategory'];
  const updates = { updatedAt: new Date().toISOString() };
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      if (typeof req.body[key] === 'string') {
        if (key === 'type') {
          const t = req.body[key].toLowerCase();
          if (!VALID_EXPENSE_TYPES.includes(t)) return res.status(400).json({ success: false, message: 'Type must be income or expense.' });
          updates[key] = t;
        } else if (key === 'amount') {
          updates[key] = req.body[key];
        } else if (key === 'date') {
          const d = new Date(req.body[key]);
          if (isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid date.' });
          updates[key] = d.toISOString().split('T')[0];
        } else {
          updates[key] = sanitizeString(req.body[key]);
        }
      } else {
        updates[key] = req.body[key];
      }
    }
  }
  if (updates.amount !== undefined) {
    const a = parseFloat(updates.amount);
    if (isNaN(a) || a <= 0) return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
    updates.amount = a;
  }
  try {
    if (!firestore) return res.json({ success: true });
    const existing = await FDB.getById('expenses', id);
    if (!existing) return res.json({ success: true });
    await FDB.updateDoc('expenses', id, updates);
    writeAudit(req, 'UPDATE_EXPENSE', `Expense/income ${id} updated in ${biz}`, biz);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', requireManager, async (req, res) => {
  const { id } = req.params;
  try {
    if (!firestore) return res.json({ success: true });
    const existing = await FDB.getById('expenses', id);
    if (existing) {
      await FDB.deleteDoc('expenses', id);
      writeAudit(req, 'DELETE_EXPENSE', `Expense/income ${id} deleted from ${existing.businessCategory || 'UNKNOWN'}`, existing.businessCategory || null, true);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/expenses/budget-limits?biz=AGRI
router.get('/budget-limits', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  try {
    const val = await readBudget(biz);
    res.json({ success: true, data: val });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/expenses/budget-limits — set budget allocations
router.post('/budget-limits', requireEmployee, async (req, res) => {
  const { businessCategory, totalBudget, categoryBudgets } = req.body;
  const biz = validateBizCategory(businessCategory || 'AGRI');
  try {
    const cleanTotal = parseFloat(totalBudget || 500000);
    if (isNaN(cleanTotal) || cleanTotal < 0) return res.status(400).json({ success: false, message: 'Total budget must be zero or positive.' });
    const payload = {
      totalBudget: cleanTotal,
      categoryBudgets: categoryBudgets && typeof categoryBudgets === 'object' ? categoryBudgets : {},
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user ? req.session.user.name : 'System'
    };
    if (firestore) {
      await writeBudget(biz, payload);
      writeAudit(req, 'UPDATE_BUDGET', `Budget for ${biz} set to ${cleanTotal}`, biz);
    }
    res.json({ success: true, data: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

module.exports = router;
