/**
 * routes/inventory.js
 * Inventory management CRUD per business category
 * Uses Firestore flat collections (see config/db.js)
 * Categories: AGRI, NON_AGRI, MAIN
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { dbReady } = require('../config/db');
const { requireEmployee, requireManager, requireViewer, validateBizCategory, sanitizeString, accessCoversCategory } = require('../middleware/auth.middleware');
const { computeStockStatus, workspaceEntity, emitStockStatusNotification } = require('../utils/stock-notifs');

function computeStatus(stock, reorderLevel) {
  if (stock <= 0) return 'out-of-stock';
  if (stock <= reorderLevel) return 'low-stock';
  return 'in-stock';
}

async function writeAudit(req, action, details, businessCategory, isSuspicious = false) {
  try {
    if (!dbReady || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action, module: 'inventory', details: details || '', logType: 'transaction',
      previousValue: null, newValue: null, businessId: businessCategory || null,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '', timestamp: new Date().toISOString(),
      isSuspicious,
    }).catch(() => {});
  } catch (_) {}
}
// ── Notification coalescing ──────────────────────────────────────────
// Repeated inventory events on the SAME product (e.g. several restocks
// in a row) should UPDATE one existing notification instead of piling
// up a new banner for every event. The most recent notification with
// the same coalesceKey created within the window below is updated in
// place; anything older stays as history.
const NOTIF_COALESCE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

async function upsertInventoryNotification({ coalesceKey, buildNotification, buildUpdate }) {
  try {
    if (!dbReady) return;
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - NOTIF_COALESCE_WINDOW_MS).toISOString();
    let existing = null;
    try {
      const candidates = await FDB.getWhere('notifications', 'coalesceKey', '==', coalesceKey);
      existing = candidates
        .filter(n => (n.createdAt || '') >= cutoff)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    } catch (_) { existing = null; }
    if (existing) {
      // Refresh the existing notification instead of creating a duplicate
      await FDB.updateDoc('notifications', existing.id, {
        ...buildUpdate(existing),
        createdAt: nowIso,          // bump so it moves back to the top
        isRead: false,              // re-surface the updated count
      }).catch(() => {});
    } else {
      const notif = buildNotification(nowIso);
      await FDB.setDoc('notifications', notif.id, notif).catch(() => {});
    }
  } catch (_) {}
}

// GET /api/inventory?biz=AGRI&entity=ENTITY_ID&includeArchived=true

// GET /api/inventory?biz=AGRI&entity=ENTITY_ID&includeArchived=true
router.get('/', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  const entityId = req.query.entity || '';
  const includeArchived = req.query.includeArchived === 'true';
  try {
    if (!dbReady) return res.json({ success: true, data: [] });
    let products = await FDB.getWhere('inventory', 'businessCategory', '==', biz);
    if (!includeArchived) products = products.filter(p => !p.isArchived);
    if (entityId) products = products.filter(p => p.entityId === entityId);
    products.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json({ success: true, data: products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/inventory/movements — audit trail of stock changes
// Supports filters: ?biz=AGRI&productId=xxx&type=SALE_DEDUCTION&startDate=2026-01-01&endDate=2026-12-31
router.get('/movements', requireViewer, async (req, res) => {
  try {
    if (!dbReady) return res.json({ success: true, data: [] });
    const { biz, productId, type, startDate, endDate } = req.query;
    let movements = await FDB.getAll('inventoryMovements', 'createdAt');
    if (biz) movements = movements.filter(m => m.businessCategory === biz);
    if (productId) movements = movements.filter(m => m.productId === productId);
    if (type) movements = movements.filter(m => m.type === type);
    if (startDate) movements = movements.filter(m => (m.createdAt || '') >= startDate);
    if (endDate) movements = movements.filter(m => (m.createdAt || '') <= endDate + 'T23:59:59.999Z');
    movements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: movements });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});
// POST /api/inventory/backfill-qr — guarantee EVERY product has a unique QR code.
// The QR payload is the product's unique identifier (its Firestore document ID).
// Any product missing a QR code (legacy products) gets one generated, and any
// duplicate/colliding QR payload is regenerated from the product's unique ID.
// Called automatically by the POS page and can also be triggered manually.
function extractQrData(qrValue) {
  // QR codes are generated via api.qrserver.com with the payload in ?data=
  if (!qrValue || typeof qrValue !== 'string') return '';
  const m = qrValue.match(/[?&]data=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : qrValue;
}

router.post('/backfill-qr', requireEmployee, async (req, res) => {
  try {
    if (!dbReady) return res.json({ success: true, updated: 0, total: 0, stillMissing: [] });
    const products = await FDB.getAll('inventory');
    const payloads = new Map(); // qr payload -> docId (uniqueness tracking)
    const toFix = [];
    const stillMissing = [];

    // First pass — find products with no QR code or a colliding QR payload
    for (const p of products) {
      const payload = extractQrData(p.qrCode) || String(p.qrCode || '');
      if (!p.qrCode || !payload || payloads.has(payload)) {
        toFix.push(p);
      } else {
        payloads.set(payload, p.id);
      }
    }

    // Second pass — assign a QR derived from the product's unique ID
    for (const p of toFix) {
      const uid = p.id; // Firestore doc ID — unique by design
      if (!uid) { stillMissing.push({ id: null, name: p.name || 'Unknown' }); continue; }
      const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${uid}`;
      try {
        await FDB.updateDoc('inventory', uid, { id: uid, qrCode });
        payloads.set(uid, uid);
      } catch (e) {
        console.error('backfill-qr: failed to update', uid, e.message);
        stillMissing.push({ id: uid, name: p.name || 'Unknown' });
      }
    }

    if (toFix.length) await writeAudit(req, 'QR_BACKFILL', `Backfilled unique QR codes on ${toFix.length} product(s)`);
    res.json({ success: true, updated: toFix.length - stillMissing.length, total: products.length, stillMissing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ── Duplicate-submission guard (server-side safety net) ─────────────
// If the same user sends an identical restock/return request within a few
// seconds (double-click / flaky network retry), only the first one is
// processed. This protects data integrity even if the client is bypassed.
const recentWriteRequests = new Map(); // key -> timestamp (ms)
const DUPLICATE_WINDOW_MS = 3000;
function isDuplicateWrite(map, key) {
  const now = Date.now();
  const last = map.get(key);
  if (last && now - last < DUPLICATE_WINDOW_MS) return true;
  map.set(key, now);
  // Periodic cleanup so the map cannot grow unbounded
  if (map.size > 500) {
    for (const [k, t] of map) {
      if (now - t > 60000) map.delete(k);
    }
  }
  return false;
}

// POST /api/inventory/restock — Restock product & log movement
router.post('/restock', requireEmployee, async (req, res) => {
  const { productId, businessCategory, quantityAdded, supplier, unitCost, notes, dateReceived } = req.body;
  if (!productId || !quantityAdded || isNaN(quantityAdded) || parseInt(quantityAdded) <= 0) {
    return res.status(400).json({ success: false, message: 'Product ID and a valid positive quantity added are required.' });
  }
  const biz = validateBizCategory(businessCategory || 'AGRI');
  const qtyToAdd = parseInt(quantityAdded);
  // Reject identical restock requests fired twice within a few seconds
  if (isDuplicateWrite(recentWriteRequests, `restock|${req.session.user.uid}|${productId}|${qtyToAdd}|${biz}`)) {
    return res.status(429).json({ success: false, message: 'Duplicate restock detected — this was already submitted a moment ago.' });
  }
  const cleanSupplier = sanitizeString(supplier || '');
  const cleanNotes = sanitizeString(notes || 'Restock received');
  let receivedAt = new Date().toISOString();
  if (dateReceived) {
    const d = new Date(dateReceived);
    if (!isNaN(d.getTime())) receivedAt = d.toISOString();
  }
  const cleanUnitCost = unitCost !== undefined && unitCost !== '' && !isNaN(unitCost) ? parseFloat(unitCost) : null;

  try {
    if (!dbReady) return res.json({ success: true });
    const currentData = await FDB.getById('inventory', productId);
    if (!currentData || (currentData.businessCategory && currentData.businessCategory !== biz)) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    const oldQty = parseInt(currentData.quantity || 0);
    const newQty = oldQty + qtyToAdd;
    const reorder = parseInt(currentData.reorderLevel || 10);
    const status = computeStatus(newQty, reorder);
    // Stock-status bucket transition (low / high / normal / out of stock)
    const oldStockStatus = computeStockStatus(oldQty, reorder);
    const newStockStatus = computeStockStatus(newQty, reorder);

    const updatePayload = {
      quantity: newQty,
      status: status,
      updatedAt: new Date().toISOString(),
      lastRestockAt: receivedAt,
    };
    if (cleanSupplier) updatePayload.supplier = cleanSupplier;
    if (cleanUnitCost !== null) updatePayload.unitCost = cleanUnitCost;
    const effectiveUnitCost = cleanUnitCost !== null ? cleanUnitCost : parseFloat(currentData.unitCost || 0);
    updatePayload.lastRestockCost = effectiveUnitCost;
    updatePayload.lastRestockTotalCost = effectiveUnitCost * qtyToAdd;

    await FDB.updateDoc('inventory', productId, updatePayload);

    // Record movement
    const movement = {
      productId: productId,
      productName: currentData.name || '',
      businessCategory: biz,
      type: 'RESTOCK',
      quantityChange: qtyToAdd,
      previousStock: oldQty,
      newStock: newQty,
      supplier: cleanSupplier || currentData.supplier || '',
      unitCost: effectiveUnitCost,
      totalPurchaseCost: effectiveUnitCost * qtyToAdd,
      dateReceived: receivedAt,
      notes: cleanNotes,
      createdAt: receivedAt,
      createdBy: req.session.user.name,
      userId: req.session.user.uid,
    };
    await FDB.addDoc('inventoryMovements', movement).catch(() => {});
    writeAudit(req, 'RESTOCK', `Restocked "${currentData.name}" +${qtyToAdd} (total ${newQty}) in ${biz}`, biz);

    const ws = workspaceEntity(req);

    // Stock-status notification — fires when the stock enters low / high /
    // out-of-stock territory, or transitions back to normal.
    await emitStockStatusNotification({
      productName: currentData.name || productId,
      productId,
      newQty,
      reorderLevel: reorder,
      biz,
      entityId: ws.entityId,
      entityName: ws.entityName,
      actorName: req.session.user.name,
      emitNormal: newStockStatus !== oldStockStatus && newStockStatus === 'normal_stock',
    });

    // Notification — coalesced: repeated restocks of the same product
    // update the existing notification instead of creating a new one.
    await upsertInventoryNotification({
      coalesceKey: `restock:${biz}:${productId}`,
      buildNotification: (nowIso) => ({
        id: `n-${Date.now()}`,
        type: 'restock',
        title: 'New Restock',
        message: `${req.session.user.name} restocked "${currentData.name}" (+${qtyToAdd} units, New Total: ${newQty})`,
        coalesceKey: `restock:${biz}:${productId}`,
        productId: productId,
        productName: currentData.name || '',
        eventUnits: qtyToAdd,
        businessCategory: biz,
        businessId: biz,
        entityId: ws.entityId,
        entityName: ws.entityName,
        priority: 'info',
        isRead: false,
        createdAt: nowIso,
        createdBy: req.session.user.uid,
        createdByName: req.session.user.name,
      }),
      buildUpdate: (existing) => {
        const totalUnits = parseInt(existing.eventUnits || 0, 10) + qtyToAdd;
        return {
          title: 'New Restock',
          message: `${req.session.user.name} restocked "${currentData.name}" (+${qtyToAdd} more units, ${totalUnits} total today, New Total: ${newQty})`,
          eventUnits: totalUnits,
          createdBy: req.session.user.uid,
          createdByName: req.session.user.name,
        };
      },
    });

    res.json({ success: true, data: { productId, newQty, status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/inventory/return — Process return / refund & log movement
router.post('/return', requireEmployee, async (req, res) => {
  const { productId, businessCategory, quantityReturned, reason, customerName } = req.body;
  if (!productId || !quantityReturned || isNaN(quantityReturned) || parseInt(quantityReturned) <= 0) {
    return res.status(400).json({ success: false, message: 'Product ID and a valid positive quantity returned are required.' });
  }
  const biz = validateBizCategory(businessCategory || 'AGRI');
  const qtyToReturn = parseInt(quantityReturned);
  // Reject identical return requests fired twice within a few seconds
  if (isDuplicateWrite(recentWriteRequests, `return|${req.session.user.uid}|${productId}|${qtyToReturn}|${biz}`)) {
    return res.status(429).json({ success: false, message: 'Duplicate return detected — this was already submitted a moment ago.' });
  }

  try {
    if (!dbReady) return res.json({ success: true });
    const currentData = await FDB.getById('inventory', productId);
    if (!currentData || (currentData.businessCategory && currentData.businessCategory !== biz)) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    const oldQty = parseInt(currentData.quantity || 0);
    const newQty = oldQty + qtyToReturn;
    const reorder = parseInt(currentData.reorderLevel || 10);
    const status = computeStatus(newQty, reorder);
    // Stock-status bucket transition (low / high / normal / out of stock)
    const oldStockStatus = computeStockStatus(oldQty, reorder);
    const newStockStatus = computeStockStatus(newQty, reorder);

    await FDB.updateDoc('inventory', productId, {
      quantity: newQty,
      status: status,
      updatedAt: new Date().toISOString()
    });
    writeAudit(req, 'STOCK_RETURN', `Return for "${currentData.name}" +${qtyToReturn} (total ${newQty}) in ${biz}`, biz);

    // Record movement for return
    const movement = {
      productId: productId,
      productName: currentData.name || '',
      businessCategory: biz,
      type: 'RETURN',
      quantityChange: qtyToReturn,
      previousStock: oldQty,
      newStock: newQty,
      customerName: customerName || '',
      notes: reason ? `Return: ${reason}` : 'Item returned by customer',
      createdAt: new Date().toISOString(),
      createdBy: req.session.user ? req.session.user.name : 'System POS',
      userId: req.session.user ? req.session.user.uid : 'system',
    };
    await FDB.addDoc('inventoryMovements', movement).catch(() => {});

    // ── Create a NEGATIVE sales adjustment so dashboard/reports reflect the return ──
    const sellingPrice = parseFloat(currentData.sellingPrice || 0);
    const unitCost = parseFloat(currentData.unitCost || 0);
    const returnTotal = sellingPrice * qtyToReturn;
    // Compute proportional tax using the business tax rate
    const DEFAULT_TAX_RATES = { AGRI: 0, NON_AGRI: 12, MAIN: 12 };
    let taxRate = DEFAULT_TAX_RATES[biz] || 0;
    try {
      const rates = await FDB.getById('settings', 'taxes') || DEFAULT_TAX_RATES;
      taxRate = rates[biz] || DEFAULT_TAX_RATES[biz] || 0;
    } catch (_) {}
    const returnTaxAmount = taxRate > 0 ? returnTotal * (taxRate / (100 + taxRate)) : 0;

    const returnSaleRecord = {
      date: new Date().toISOString(),
      items: [{
        id: productId,
        name: currentData.name || '',
        category: currentData.category || '',
        quantity: qtyToReturn,
        unitPrice: sellingPrice,
        unitCost: unitCost,
        subtotal: -returnTotal,
      }],
      subtotal: -returnTotal,
      taxRate: taxRate,
      taxAmount: -returnTaxAmount,
      total: -returnTotal,
      paymentMethod: 'RETURN_ADJUSTMENT',
      notes: reason ? `Return adjustment: ${reason}` : 'Return/refund adjustment',
      businessCategory: biz,
      recordedBy: req.session.user.uid,
      recordedByName: req.session.user.name,
      customerName: customerName || '',
      isReturnAdjustment: true,
      linkedReturnProductId: productId,
      createdAt: new Date().toISOString(),
    };
    const { id: saleId } = await FDB.addDoc('sales', { ...returnSaleRecord, businessCategory: biz });
    returnSaleRecord.id = saleId;
    returnSaleRecord.transactionId = 'RTN-' + String(saleId).substring(0, 7).toUpperCase();
    await FDB.updateDoc('sales', saleId, { id: saleId, transactionId: returnSaleRecord.transactionId }).catch(() => {});

    // Notification — coalesced: repeated returns of the same product
    // update the existing notification instead of creating a new one.
    const ws = workspaceEntity(req);
    await upsertInventoryNotification({
      coalesceKey: `return:${biz}:${productId}`,
      buildNotification: (nowIso) => ({
        id: `n-${Date.now()}`,
        type: 'restock',
        title: 'Product Returned',
        message: `${req.session.user.name} processed a return for "${currentData.name}" (+${qtyToReturn} units, New Total: ${newQty}). Revenue adjusted by -₱${returnTotal.toFixed(2)}`,
        coalesceKey: `return:${biz}:${productId}`,
        productId: productId,
        productName: currentData.name || '',
        eventUnits: qtyToReturn,
        businessCategory: biz,
        businessId: biz,
        entityId: ws.entityId,
        entityName: ws.entityName,
        priority: 'info',
        isRead: false,
        createdAt: nowIso,
        createdBy: req.session.user.uid,
        createdByName: req.session.user.name,
      }),
      buildUpdate: (existing) => {
        const totalUnits = parseInt(existing.eventUnits || 0, 10) + qtyToReturn;
        return {
          title: 'Product Returned',
          message: `${req.session.user.name} processed a return for "${currentData.name}" (+${qtyToReturn} more units, ${totalUnits} total today, New Total: ${newQty}). Revenue adjusted by -₱${returnTotal.toFixed(2)}`,
          eventUnits: totalUnits,
          createdBy: req.session.user.uid,
          createdByName: req.session.user.name,
        };
      },
    });

    // Stock-status notification — fires when the return moves the stock
    // between low / high / normal / out-of-stock buckets.
    await emitStockStatusNotification({
      productName: currentData.name || productId,
      productId,
      newQty,
      reorderLevel: reorder,
      biz,
      entityId: ws.entityId,
      entityName: ws.entityName,
      actorName: req.session.user.name,
      emitNormal: newStockStatus !== oldStockStatus && newStockStatus === 'normal_stock',
    });

    res.json({ success: true, data: { productId, newQty, status, revenueAdjusted: -returnTotal } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/inventory — add product
router.post('/', requireEmployee, async (req, res) => {
  const { name: rawName, category: rawCat, unit, unitCost, quantity, sellingPrice, reorderLevel, supplier: rawSup, description: rawDesc, businessCategory, entityId, entityName } = req.body;
  const name = sanitizeString(rawName || '');
  const category = sanitizeString(rawCat || '');
  const supplier = sanitizeString(rawSup || '');
  const description = sanitizeString(rawDesc || '');
  if (!name || !category || quantity === undefined || isNaN(quantity) || sellingPrice === undefined || isNaN(sellingPrice)) {
    return res.status(400).json({ success: false, message: 'Product Name, Category, Quantity, and Selling Price are mandatory fields.' });
  }
  const biz = validateBizCategory(businessCategory || 'AGRI');

  // Verify employee has access to this business category
  // (entity-ID-based access like 'AGRI-rice-xxx' covers its parent category,
  // consistent with requireBusinessAccess / accessCoversCategory)
  const userAccess = req.session.user.businessAccess || [];
  if (!accessCoversCategory(userAccess, biz)) {
    return res.status(403).json({ success: false, message: 'Access denied to this business category.' });
  }

  const stock = parseInt(quantity || 0);
  const reorder = parseInt(reorderLevel || 10);

  const product = {
    name, category: category || '', unit: sanitizeString(unit || 'pcs'),
    unitCost: parseFloat(unitCost || 0),
    sellingPrice: parseFloat(sellingPrice || 0),
    quantity: stock,
    reorderLevel: reorder,
    supplier: supplier || '',
    description: description || '',
    businessCategory: biz,
    entityId: sanitizeString(entityId || ''),
    entityName: sanitizeString(entityName || ''),
    status: computeStatus(stock, reorder),
    isArchived: false,
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.name,
  };

  try {
    if (!dbReady) {
      product.id = 'prod-' + Date.now();
      product.qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${product.id}`;
      return res.json({ success: true, data: product });
    }
    const { id: newId } = await FDB.addDoc('inventory', { ...product, businessCategory: biz });
    product.id = newId;
    product.qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${newId}`;
    await FDB.updateDoc('inventory', newId, { id: newId, qrCode: product.qrCode });

    // Log initial inventory movement
    await FDB.addDoc('inventoryMovements', {
      productId: newId,
      productName: name,
      businessCategory: biz,
      type: 'INITIAL',
      quantityChange: stock,
      previousStock: 0,
      newStock: stock,
      supplier: supplier || '',
      unitCost: parseFloat(unitCost || 0),
      notes: 'Initial product stock created',
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.name,
      userId: req.session.user.uid,
    }).catch(() => {});

    // Notify admins about new product
    const notif = {
      id: `n-${Date.now()}`,
      type: 'inventory',
      title: 'New Product Added',
      message: `${req.session.user.name} added "${name}" to ${biz} inventory (Qty: ${stock})`,
      businessCategory: biz,
      entityId: entityId || '',
      entityName: entityName || '',
      priority: 'info',
      isRead: false,
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.uid,
      createdByName: req.session.user.name,
    };
    await FDB.setDoc('notifications', notif.id, notif).catch(() => {});
    writeAudit(req, 'CREATE_PRODUCT', `Product "${name}" added to ${biz} (Qty: ${stock})`, biz);

    res.json({ success: true, data: product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/inventory/:id — update product
router.put('/:id', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const { businessCategory } = req.body;
  const biz = validateBizCategory(businessCategory || req.query.biz || 'AGRI');

  // Allowlist of fields that can be updated (prevents mass assignment)
  const allowedFields = ['name', 'category', 'unit', 'unitCost', 'sellingPrice', 'quantity', 'reorderLevel', 'supplier', 'description', 'entityId', 'entityName', 'businessCategory'];
  const updates = { updatedAt: new Date().toISOString() };
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = typeof req.body[key] === 'string' ? sanitizeString(req.body[key]) : req.body[key];
    }
  }
  if (updates.quantity !== undefined) {
    const q = parseInt(updates.quantity);
    if (isNaN(q) || q < 0) return res.status(400).json({ success: false, message: 'Quantity must be zero or a positive number.' });
    updates.quantity = q;
  }
  if (updates.reorderLevel !== undefined) {
    const r = parseInt(updates.reorderLevel);
    if (isNaN(r) || r < 0) return res.status(400).json({ success: false, message: 'Reorder level must be zero or a positive number.' });
    updates.reorderLevel = r;
  }
  if (updates.quantity !== undefined && updates.reorderLevel !== undefined) {
    updates.status = computeStatus(parseInt(updates.quantity), parseInt(updates.reorderLevel));
  }

  try {
    if (!dbReady) return res.json({ success: true });

    // Check stock change for notification
    const oldData = await FDB.getById('inventory', id);
    if (!oldData || (oldData.businessCategory && oldData.businessCategory !== biz)) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    const oldQty = parseInt(oldData.quantity || 0);
    const newQty = parseInt(updates.quantity !== undefined ? updates.quantity : oldQty);

    await FDB.updateDoc('inventory', id, updates);
    writeAudit(req, 'UPDATE_PRODUCT', `Product "${oldData.name || id}" updated in ${biz}`, biz);

    if (newQty !== oldQty) {
      await FDB.addDoc('inventoryMovements', {
        productId: id,
        productName: oldData.name || updates.name || id,
        businessCategory: biz,
        type: newQty > oldQty ? 'RESTOCK' : 'MANUAL_ADJUSTMENT',
        quantityChange: newQty - oldQty,
        previousStock: oldQty,
        newStock: newQty,
        notes: 'Stock updated via product edit',
        createdAt: new Date().toISOString(),
        createdBy: req.session.user.name,
        userId: req.session.user.uid,
      }).catch(() => {});

      const notif = {
        id: `n-${Date.now()}`,
        type: 'inventory',
        title: 'Stock Updated',
        message: `${req.session.user.name} updated stock of "${oldData.name || updates.name || id}": ${oldQty} → ${newQty} (${biz})`,
        businessCategory: biz,
        entityId: updates.entityId || oldData.entityId || '',
        entityName: updates.entityName || oldData.entityName || '',
        priority: 'info',
        isRead: false,
        createdAt: new Date().toISOString(),
        createdBy: req.session.user.uid,
        createdByName: req.session.user.name,
      };
      await FDB.setDoc('notifications', notif.id, notif).catch(() => {});
      // Stock-status notification when an edit moves stock between buckets
      // (e.g. drops to low stock / out of stock, or back to normal / high).
      const effReorder = parseInt(updates.reorderLevel !== undefined ? updates.reorderLevel : oldData.reorderLevel || 10);
      const oldReorder = parseInt(oldData.reorderLevel || 10);
      const oldStockStatus = computeStockStatus(oldQty, oldReorder);
      const newStockStatus = computeStockStatus(newQty, effReorder);
      if (newStockStatus !== oldStockStatus) {
        const ws = workspaceEntity(req);
        await emitStockStatusNotification({
          productName: oldData.name || updates.name || id,
          productId: id,
          newQty,
          reorderLevel: effReorder,
          biz,
          entityId: updates.entityId || oldData.entityId || ws.entityId,
          entityName: updates.entityName || oldData.entityName || ws.entityName,
          actorName: req.session.user.name,
          emitNormal: newStockStatus === 'normal_stock',
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/inventory/:id/archive — archive product (soft delete, restorable)
router.put('/:id/archive', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const biz = validateBizCategory(req.body.businessCategory || req.query.biz || 'AGRI');
  try {
    if (!dbReady) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (!existing || (existing.businessCategory && existing.businessCategory !== biz)) return res.status(404).json({ success: false, message: 'Product not found.' });
    await FDB.updateDoc('inventory', id, { isArchived: true, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await FDB.addDoc('inventoryMovements', {
      productId: id, productName: existing.name || id, businessCategory: biz,
      type: 'ARCHIVE', quantityChange: 0, previousStock: existing.quantity || 0, newStock: existing.quantity || 0,
      notes: 'Product archived', createdAt: new Date().toISOString(),
      createdBy: req.session.user.name, userId: req.session.user.uid,
    }).catch(() => {});
    writeAudit(req, 'ARCHIVE_PRODUCT', `Product "${existing.name || id}" archived in ${biz}`, biz);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/inventory/:id/restore — restore archived product
router.put('/:id/restore', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const biz = validateBizCategory(req.body.businessCategory || req.query.biz || 'AGRI');
  try {
    if (!dbReady) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (!existing || (existing.businessCategory && existing.businessCategory !== biz)) return res.status(404).json({ success: false, message: 'Product not found.' });
    await FDB.updateDoc('inventory', id, { isArchived: false, archivedAt: null, updatedAt: new Date().toISOString() });
    writeAudit(req, 'RESTORE_PRODUCT', `Product "${existing.name || id}" restored in ${biz}`, biz);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/inventory/:id — archive by default (soft delete); ?hard=true for permanent (manager+)
router.delete('/:id', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const hard = req.query.hard === 'true';
  try {
    if (!dbReady) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (existing) {
      const cat = existing.businessCategory || 'AGRI';
      if (hard) {
        const role = req.session.user.role;
        if (!['super_admin', 'admin', 'system_administrator', 'manager', 'accounting_officer'].includes(role)) {
          return res.status(403).json({ success: false, message: 'Permanent delete requires manager or higher.' });
        }
        await FDB.deleteDoc('inventory', id);
        writeAudit(req, 'DELETE_PRODUCT', `Product "${existing.name || id}" permanently deleted from ${cat}`, cat, true);
      } else {
        await FDB.updateDoc('inventory', id, { isArchived: true, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        writeAudit(req, 'ARCHIVE_PRODUCT', `Product "${existing.name || id}" archived in ${cat}`, cat);
      }
      return res.json({ success: true, archived: !hard });
    }
    res.json({ success: false, message: 'Product not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/inventory/:id/delete — archive by default for reliability
router.post('/:id/delete', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const hard = req.query.hard === 'true' || req.body.hard === true;
  try {
    if (!dbReady) return res.json({ success: true });
    const existing = await FDB.getById('inventory', id);
    if (existing) {
      const cat = existing.businessCategory || 'AGRI';
      if (hard) {
        const role = req.session.user.role;
        if (!['super_admin', 'admin', 'system_administrator', 'manager', 'accounting_officer'].includes(role)) {
          return res.status(403).json({ success: false, message: 'Permanent delete requires manager or higher.' });
        }
        await FDB.deleteDoc('inventory', id);
        writeAudit(req, 'DELETE_PRODUCT', `Product "${existing.name || id}" permanently deleted from ${cat}`, cat, true);
      } else {
        await FDB.updateDoc('inventory', id, { isArchived: true, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        writeAudit(req, 'ARCHIVE_PRODUCT', `Product "${existing.name || id}" archived in ${cat}`, cat);
      }
      return res.json({ success: true, archived: !hard });
    }
    res.json({ success: false, message: 'Product not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/inventory/:id/comment — Accounting Officer stock reminder/comment to staff
router.post('/:id/comment', requireManager, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  const sanitizedComment = sanitizeString(comment || '');
  if (!sanitizedComment) {
    return res.status(400).json({ success: false, message: 'Comment or reminder message is required.' });
  }

  try {
    if (!dbReady) return res.json({ success: true, data: { accountingComment: sanitizedComment } });
    const product = await FDB.getById('inventory', id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const cat = product.businessCategory || 'AGRI';
    const authorName = req.session.user.name || 'Accounting Officer';
    const now = new Date().toISOString();

    const updates = {
      accountingComment: sanitizedComment,
      accountingCommentBy: authorName,
      accountingCommentAt: now,
      updatedAt: now,
    };

    await FDB.updateDoc('inventory', id, updates);

    // Create notification for staff under this business category
    const qty = parseInt(product.quantity || product.stock || 0);
    const unit = product.unit || 'units';
    await FDB.addDoc('notifications', {
      type: 'message',
      title: `Accounting Stock Notice: ${product.name}`,
      message: `${authorName}: "${sanitizedComment}" (Current stock: ${qty} ${unit})`,
      businessCategory: cat,
      businessId: cat,
      entityId: product.entityId || '',
      entityName: product.entityName || '',
      priority: 'warning',
      isRead: false,
      createdAt: now,
      createdByName: authorName,
    }).catch(err => console.warn('Failed to emit reminder notification:', err));

    writeAudit(req, 'ACCOUNTING_INVENTORY_COMMENT', `Added reminder on "${product.name}": "${sanitizedComment}"`, cat);

    res.json({ success: true, data: { ...product, ...updates } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/inventory/:id/comment — Clear reminder on inventory item
router.delete('/:id/comment', requireManager, async (req, res) => {
  const { id } = req.params;
  try {
    if (!dbReady) return res.json({ success: true });
    const product = await FDB.getById('inventory', id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const cat = product.businessCategory || 'AGRI';
    const now = new Date().toISOString();

    const updates = {
      accountingComment: null,
      accountingCommentBy: null,
      accountingCommentAt: null,
      updatedAt: now,
    };

    await FDB.updateDoc('inventory', id, updates);
    writeAudit(req, 'CLEAR_INVENTORY_COMMENT', `Cleared accounting reminder on "${product.name}"`, cat);

    res.json({ success: true, message: 'Reminder cleared.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

module.exports = router;
