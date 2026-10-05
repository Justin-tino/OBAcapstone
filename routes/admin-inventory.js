/**
 * routes/admin-inventory.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TEMPORARY LOCAL ADMIN TOOL — "All Businesses Inventory Manager"
 *
 * Purpose: let the System Administrator add / edit / view products for EVERY
 * business workspace from ONE screen, instead of logging in as each business
 * account one by one. Data is written to the SAME `inventory` collection used
 * by the normal per-business flow, so nothing is special-cased downstream:
 * POS, sales, reports and movement logs all pick the products up normally.
 *
 * Scope guard rails (this tool is deliberately hard to expose):
 *   1. Super Admin / Admin / System Administrator role only.
 *   2. Requests must originate from localhost (127.0.0.1 / ::1 / localhost).
 *      Set ADMIN_INVENTORY_ALLOW_REMOTE=true to lift guard #2 temporarily
 *      while testing on a LAN machine.
 *
 * TO REMOVE THIS FEATURE LATER:
 *   - delete routes/admin-inventory.js
 *   - delete views/admin/all-inventory.html
 *   - remove the two `adminInventoryRoutes` lines + the page route in server.js
 *   - remove the "Business Inventory" nav item in views/admin/*.html
 * Nothing else in the app depends on this file.
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { firestore } = require('../config/firebase');
const { sanitizeString, validateBizCategory } = require('../middleware/auth.middleware');

const VALID_CATS = ['AGRI', 'NON_AGRI', 'MAIN'];
const CAT_META = {
  AGRI: { name: 'Agriculture', color: '#D4A915', bg: '#FFF8E1' },
  NON_AGRI: { name: 'Non-Agriculture', color: '#1A1A1A', bg: '#F5F5F5' },
  MAIN: { name: 'Main', color: '#0D6EFD', bg: '#E3F2FD' },
};

function computeStatus(stock, reorderLevel) {
  if (stock <= 0) return 'out-of-stock';
  if (stock <= reorderLevel) return 'low-stock';
  return 'in-stock';
}

// ── Guard #1: admin role ─────────────────────────────────────────────────────
function requireAdminRole(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const allowed = ['super_admin', 'admin', 'system_administrator'];
  if (!allowed.includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. The All Businesses Inventory tool is restricted to System Administrators.',
    });
  }
  next();
}

// ── Guard #2: localhost only ─────────────────────────────────────────────────
// Checks the real TCP peer address (req.socket.remoteAddress), never a
// client-supplied header, so a remote caller cannot spoof their way in.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackRequest(req) {
  if (process.env.ADMIN_INVENTORY_ALLOW_REMOTE === 'true') return true;
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return LOOPBACK.has(peer) || peer === '127.0.0.1';
}

function requireLocalhost(req, res, next) {
  if (isLoopbackRequest(req)) return next();
  return res.status(403).json({
    success: false,
    message: 'The All Businesses Inventory tool only works on localhost.',
  });
}

const guard = [requireAdminRole, requireLocalhost];

// Page-level guard (used by server.js so an unauthenticated/remote visit
// never even receives the HTML shell).
function guardPage(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const allowed = ['super_admin', 'admin', 'system_administrator'];
  if (!allowed.includes(req.session.user.role)) {
    return res.status(403).send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff">` +
      `<h1 style="color:#F5C518">403</h1><p>Access denied. System Administrator only.</p>` +
      `<a href="/" style="color:#6B8C6B">Go Home</a></body></html>`
    );
  }
  if (!isLoopbackRequest(req)) {
    return res.status(403).send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff">` +
      `<h1 style="color:#F5C518">403</h1><p>This tool only works on localhost.</p>` +
      `<a href="/admin/dashboard" style="color:#6B8C6B">Back to Dashboard</a></body></html>`
    );
  }
  next();
}

// ── Audit + notification helpers ────────────────────────────────────────────
async function writeAudit(req, action, details, businessId, isSuspicious = false) {
  try {
    if (!firestore || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action, module: 'inventory', details: details || '', logType: 'transaction',
      previousValue: null, newValue: null, businessId: businessId || null,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '', timestamp: new Date().toISOString(),
      isSuspicious,
    }).catch(() => {});
  } catch (_) {}
}

async function notify(req, { title, message, biz, entityId, entityName, priority = 'info', type = 'inventory' }) {
  try {
    if (!firestore) return;
    const notif = {
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type, title, message,
      businessCategory: biz,
      businessId: biz,
      entityId: entityId || '',
      entityName: entityName || '',
      priority, isRead: false,
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.uid,
      createdByName: req.session.user.name,
    };
    await FDB.setDoc('notifications', notif.id, notif).catch(() => {});
  } catch (_) {}
}

// ── Business catalogue (cached per request, cheap to rebuild) ────────────────
async function loadBusinesses() {
  if (!firestore) return [];
  const docs = await FDB.getAll('businesses').catch(() => []);
  return docs.map(b => ({
    id: b.id,
    name: b.name || b.id,
    categoryId: VALID_CATS.includes(b.categoryId) ? b.categoryId : (VALID_CATS.includes(b.type) ? b.type : 'AGRI'),
    location: b.location || '',
    manager: b.manager || '',
    status: b.status || 'active',
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/admin-inventory/overview
// One request returns: the 3 categories → every business → its products.
// (Grouping happens client-side so switching businesses needs no round trip.)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/overview', guard, async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const businesses = await loadBusinesses();
    const products = firestore ? await FDB.getAll('inventory').catch(() => []) : [];
    const visible = includeArchived ? products : products.filter(p => !p.isArchived);

    // Businesses that only exist as an entityId on products (legacy data)
    const known = new Set(businesses.map(b => b.id));
    const orphans = [];
    for (const p of visible) {
      if (p.entityId && !known.has(p.entityId)) {
        known.add(p.entityId);
        orphans.push({
          id: p.entityId,
          name: p.entityName || p.entityId,
          categoryId: VALID_CATS.includes(p.businessCategory) ? p.businessCategory : 'AGRI',
          location: '', manager: '', status: 'active', isOrphan: true,
        });
      }
    }

    res.json({
      success: true,
      categories: VALID_CATS.map(id => ({ id, ...CAT_META[id] })),
      businesses: [...businesses, ...orphans],
      products: visible,
    });
  } catch (err) {
    console.error('admin-inventory overview error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Product normalisation shared by the create / copy / bulk endpoints
// ═════════════════════════════════════════════════════════════════════════════
function normalizeProductInput(input) {
  const name = sanitizeString(input.name || '');
  if (!name) return { error: 'Product name is required.' };
  const quantity = parseInt(input.quantity, 10);
  if (isNaN(quantity) || quantity < 0) return { error: `Invalid quantity for "${name}".` };
  const sellingPrice = parseFloat(input.sellingPrice);
  if (isNaN(sellingPrice) || sellingPrice < 0) return { error: `Invalid selling price for "${name}".` };
  const unitCostRaw = parseFloat(input.unitCost);
  const reorderRaw = parseInt(input.reorderLevel, 10);
  return {
    value: {
      name,
      category: sanitizeString(input.category || ''),
      unit: sanitizeString(input.unit || 'pcs'),
      unitCost: isNaN(unitCostRaw) || unitCostRaw < 0 ? 0 : unitCostRaw,
      sellingPrice,
      quantity,
      reorderLevel: isNaN(reorderRaw) || reorderRaw < 0 ? 10 : reorderRaw,
      supplier: sanitizeString(input.supplier || ''),
      description: sanitizeString(input.description || ''),
      status: computeStatus(quantity, isNaN(reorderRaw) || reorderRaw < 0 ? 10 : reorderRaw),
    },
  };
}

async function createProductDocument(req, product, biz, entityId, entityName) {
  const doc = {
    ...product,
    businessCategory: biz,
    entityId: entityId || '',
    entityName: entityName || '',
    isArchived: false,
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.name,
    createdByRole: 'admin_inventory_tool',
  };
  const { id: newId } = await FDB.addDoc('inventory', doc);
  const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${newId}`;
  await FDB.updateDoc('inventory', newId, { id: newId, qrCode });

  await FDB.addDoc('inventoryMovements', {
    productId: newId,
    productName: product.name,
    businessCategory: biz,
    entityId: entityId || '',
    entityName: entityName || '',
    type: 'INITIAL',
    quantityChange: product.quantity,
    previousStock: 0,
    newStock: product.quantity,
    supplier: product.supplier || '',
    unitCost: product.unitCost,
    notes: 'Initial product stock created (admin bulk tool)',
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.name,
    userId: req.session.user.uid,
  }).catch(() => {});

  return { id: newId, qrCode };
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin-inventory/products — add one product to one business
// ═════════════════════════════════════════════════════════════════════════════
router.post('/products', guard, async (req, res) => {
  const { businessId, businessCategory } = req.body || {};
  const entityId = sanitizeString(businessId || '');
  const biz = validateBizCategory(businessCategory || 'AGRI');
  if (!entityId) return res.status(400).json({ success: false, message: 'A target business is required.' });

  const { value, error } = normalizeProductInput(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    if (!firestore) return res.json({ success: true, data: { ...value, businessCategory: biz, entityId } });
    const businesses = await loadBusinesses();
    const target = businesses.find(b => b.id === entityId);
    const entityName = target ? target.name : entityId;

    const { id } = await createProductDocument(req, value, biz, entityId, entityName);
    await notify(req, {
      title: 'New Product Added',
      message: `${req.session.user.name} added "${value.name}" to ${entityName} (Qty: ${value.quantity})`,
      biz, entityId, entityName,
    });
    await writeAudit(req, 'CREATE_PRODUCT', `Product "${value.name}" added to ${entityName} (${biz})`, entityId);
    res.json({ success: true, data: { id, ...value, businessCategory: biz, entityId, entityName } });
  } catch (err) {
    console.error('admin-inventory create error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin-inventory/products/bulk
// Paste many products for ONE business in a single request.
// Each item accepts either a ready object or a `|` / tab separated line:
//   name | category | quantity | unitCost | sellingPrice | unit | reorderLevel | supplier
// ═════════════════════════════════════════════════════════════════════════════
const BULK_FIELDS = ['name', 'category', 'quantity', 'unitCost', 'sellingPrice', 'unit', 'reorderLevel', 'supplier'];

function parseBulkLine(line) {
  const parts = String(line).split(/\s*\|\s*|\t+/).map(s => s.trim());
  if (parts.length < 3) return null;
  const obj = {};
  BULK_FIELDS.forEach((f, i) => { if (parts[i] !== undefined && parts[i] !== '') obj[f] = parts[i]; });
  return obj.name ? obj : null;
}

router.post('/products/bulk', guard, async (req, res) => {
  const { businessId, businessCategory, items, lines } = req.body || {};
  const entityId = sanitizeString(businessId || '');
  const biz = validateBizCategory(businessCategory || 'AGRI');
  if (!entityId) return res.status(400).json({ success: false, message: 'A target business is required.' });

  let parsed = Array.isArray(items) ? items.slice() : [];
  if (!parsed.length) {
    const rawLines = typeof lines === 'string'
      ? lines.split(/\r?\n/)
      : (Array.isArray(lines) ? lines : []);
    parsed = rawLines.map(l => String(l).trim()).filter(Boolean).map(parseBulkLine).filter(Boolean);
  }
  if (!parsed.length) {
    return res.status(400).json({ success: false, message: 'No products to add. Paste at least one line in "name | category | qty | cost | price | unit" format.' });
  }
  if (parsed.length > 500) {
    return res.status(400).json({ success: false, message: 'Please add at most 500 products per batch.' });
  }

  // Validate everything up-front so a bad line does not leave a half-batch.
  const normalized = [];
  const errors = [];
  for (const item of parsed) {
    const { value, error } = normalizeProductInput(item);
    if (error) errors.push(error);
    else normalized.push(value);
  }
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0], errors, added: 0 });
  }

  try {
    if (!firestore) {
      return res.json({ success: true, added: normalized.length, data: normalized.map((p, i) => ({ id: `mock-${i}`, ...p })) });
    }
    const businesses = await loadBusinesses();
    const target = businesses.find(b => b.id === entityId);
    const entityName = target ? target.name : entityId;

    const created = [];
    for (const product of normalized) {
      const { id } = await createProductDocument(req, product, biz, entityId, entityName);
      created.push({ id, ...product });
    }
    await notify(req, {
      title: 'Products Added In Bulk',
      message: `${req.session.user.name} added ${created.length} product(s) to ${entityName}`,
      biz, entityId, entityName,
    });
    await writeAudit(req, 'BULK_CREATE_PRODUCTS', `${created.length} product(s) added to ${entityName} (${biz})`, entityId);
    res.json({ success: true, added: created.length, data: created });
  } catch (err) {
    console.error('admin-inventory bulk error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/admin-inventory/products/:id/copy
// Replicate an existing product into other businesses (one request).
// ═════════════════════════════════════════════════════════════════════════════
router.post('/products/:id/copy', guard, async (req, res) => {
  const { id } = req.params;
  const { targets } = req.body || {};
  const targetList = (Array.isArray(targets) ? targets : [])
    .map(t => (typeof t === 'string' ? { id: t } : t))
    .filter(t => t && t.id);
  if (!targetList.length) {
    return res.status(400).json({ success: false, message: 'Select at least one business to copy this product into.' });
  }
  if (targetList.length > 100) {
    return res.status(400).json({ success: false, message: 'Please copy to at most 100 businesses at a time.' });
  }

  try {
    if (!firestore) return res.json({ success: true, copied: 0 });
    const source = await FDB.getById('inventory', id);
    if (!source) return res.status(404).json({ success: false, message: 'Source product not found.' });

    const businesses = await loadBusinesses();
    const byId = new Map(businesses.map(b => [b.id, b]));

    const base = {
      name: source.name || '',
      category: source.category || '',
      unit: source.unit || 'pcs',
      unitCost: parseFloat(source.unitCost) || 0,
      sellingPrice: parseFloat(source.sellingPrice) || 0,
      quantity: parseInt(source.quantity, 10) || 0,
      reorderLevel: parseInt(source.reorderLevel, 10) || 10,
      supplier: source.supplier || '',
      description: source.description || '',
      status: computeStatus(parseInt(source.quantity, 10) || 0, parseInt(source.reorderLevel, 10) || 10),
    };

    const created = [];
    for (const t of targetList) {
      const entityId = sanitizeString(t.id);
      const biz = validateBizCategory(t.businessCategory || (byId.get(entityId) || {}).categoryId || 'AGRI');
      if (!entityId) continue;
      const entityName = (byId.get(entityId) || {}).name || t.name || entityId;
      const { id: newId } = await createProductDocument(req, base, biz, entityId, entityName);
      created.push({ id: newId, entityId, entityName, name: base.name });
    }

    await notify(req, {
      title: 'Products Copied To Businesses',
      message: `${req.session.user.name} copied "${base.name}" into ${created.length} business workspace(s)`,
      biz: source.businessCategory || 'AGRI',
      entityId: source.entityId || '',
      entityName: source.entityName || '',
    });
    await writeAudit(req, 'COPY_PRODUCT', `"${base.name}" copied into ${created.length} business workspace(s)`, source.entityId || null);
    res.json({ success: true, copied: created.length, data: created });
  } catch (err) {
    console.error('admin-inventory copy error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/admin-inventory/products/:id — edit a product
// ═════════════════════════════════════════════════════════════════════════════
router.put('/products/:id', guard, async (req, res) => {
  const { id } = req.params;
  const allowedFields = ['name', 'category', 'unit', 'unitCost', 'sellingPrice', 'quantity',
    'reorderLevel', 'supplier', 'description', 'entityId', 'entityName', 'businessCategory', 'isArchived'];

  const updates = { updatedAt: new Date().toISOString(), updatedByRole: 'admin_inventory_tool' };
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = typeof req.body[key] === 'string' ? sanitizeString(req.body[key]) : req.body[key];
    }
  }
  if (updates.quantity !== undefined) {
    const q = parseInt(updates.quantity, 10);
    if (isNaN(q) || q < 0) return res.status(400).json({ success: false, message: 'Quantity must be zero or a positive number.' });
    updates.quantity = q;
  }
  if (updates.reorderLevel !== undefined) {
    const r = parseInt(updates.reorderLevel, 10);
    if (isNaN(r) || r < 0) return res.status(400).json({ success: false, message: 'Reorder level must be zero or a positive number.' });
    updates.reorderLevel = r;
  }
  if (updates.sellingPrice !== undefined) {
    const s = parseFloat(updates.sellingPrice);
    if (isNaN(s) || s < 0) return res.status(400).json({ success: false, message: 'Selling price must be zero or a positive number.' });
    updates.sellingPrice = s;
  }
  if (updates.unitCost !== undefined) {
    const c = parseFloat(updates.unitCost);
    updates.unitCost = isNaN(c) || c < 0 ? 0 : c;
  }

  try {
    if (!firestore) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found.' });

    const oldQty = parseInt(existing.quantity, 10) || 0;
    const newQty = updates.quantity !== undefined ? updates.quantity : oldQty;
    const newReorder = updates.reorderLevel !== undefined ? updates.reorderLevel : (parseInt(existing.reorderLevel, 10) || 10);
    updates.status = computeStatus(newQty, newReorder);

    await FDB.updateDoc('inventory', id, updates);
    await writeAudit(req, 'UPDATE_PRODUCT', `Product "${existing.name || id}" updated (admin inventory tool)`, existing.entityId || null);

    if (newQty !== oldQty) {
      await FDB.addDoc('inventoryMovements', {
        productId: id,
        productName: updates.name || existing.name || id,
        businessCategory: updates.businessCategory || existing.businessCategory || 'AGRI',
        entityId: updates.entityId !== undefined ? updates.entityId : (existing.entityId || ''),
        entityName: updates.entityName !== undefined ? updates.entityName : (existing.entityName || ''),
        type: newQty > oldQty ? 'RESTOCK' : 'MANUAL_ADJUSTMENT',
        quantityChange: newQty - oldQty,
        previousStock: oldQty,
        newStock: newQty,
        notes: 'Stock updated via All Businesses Inventory tool',
        createdAt: new Date().toISOString(),
        createdBy: req.session.user.name,
        userId: req.session.user.uid,
      }).catch(() => {});

      await notify(req, {
        title: 'Stock Updated',
        message: `${req.session.user.name} updated stock of "${updates.name || existing.name}": ${oldQty} → ${newQty}`,
        biz: existing.businessCategory || 'AGRI',
        entityId: existing.entityId || '',
        entityName: existing.entityName || '',
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('admin-inventory update error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/admin-inventory/products/:id — archive (soft) or hard delete
//   ?hard=true removes the document permanently.
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/products/:id', guard, async (req, res) => {
  const { id } = req.params;
  const hard = req.query.hard === 'true' || (req.body && req.body.hard === true);
  try {
    if (!firestore) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found.' });

    if (hard) {
      await FDB.deleteDoc('inventory', id);
      await writeAudit(req, 'DELETE_PRODUCT', `Product "${existing.name || id}" permanently deleted (admin inventory tool)`, existing.entityId || null, true);
    } else {
      await FDB.updateDoc('inventory', id, { isArchived: true, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await FDB.addDoc('inventoryMovements', {
        productId: id, productName: existing.name || id,
        businessCategory: existing.businessCategory || 'AGRI',
        entityId: existing.entityId || '', entityName: existing.entityName || '',
        type: 'ARCHIVE', quantityChange: 0,
        previousStock: existing.quantity || 0, newStock: existing.quantity || 0,
        notes: 'Product archived (admin inventory tool)',
        createdAt: new Date().toISOString(),
        createdBy: req.session.user.name, userId: req.session.user.uid,
      }).catch(() => {});
      await writeAudit(req, 'ARCHIVE_PRODUCT', `Product "${existing.name || id}" archived (admin inventory tool)`, existing.entityId || null);
    }
    res.json({ success: true, archived: !hard });
  } catch (err) {
    console.error('admin-inventory delete error:', err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

router.guardPage = guardPage;
module.exports = router;