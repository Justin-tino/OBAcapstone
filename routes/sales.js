/**
 * routes/sales.js
 * Sales transaction CRUD per business category
 * Uses Firestore flat collections (see config/db.js)
 * Categories: AGRI, NON_AGRI, MAIN
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { firestore } = require('../config/firebase');
const { requireEmployee, requireManager, requireViewer, validateBizCategory, validatePaymentMethod, sanitizeString, accessCoversCategory } = require('../middleware/auth.middleware');

async function writeAudit(req, action, details, businessCategory) {
  try {
    if (!firestore || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action,
      module: 'sales',
      details: details || '',
      logType: 'transaction',
      previousValue: null,
      newValue: null,
      businessId: businessCategory || null,
      userId: req.session.user.uid,
      userName: req.session.user.name,
      userEmail: req.session.user.email || '',
      timestamp: new Date().toISOString(),
      isSuspicious: action === 'DELETE_SALE',
    }).catch(() => {});
  } catch (_) {}
}

// GET /api/sales?biz=AGRI&entity=ENTITY_ID — list all sales for a category
router.get('/', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  const entityId = req.query.entity || '';
  try {
    if (!firestore) return res.json({ success: true, data: [] });
    let sales = await FDB.getWhere('sales', 'businessCategory', '==', biz);
    sales.sort((a, b) => (String(b.date || '') < String(a.date || '') ? -1 : 1));
    // Filter by entity if specified
    if (entityId) sales = sales.filter(s => s.entityId === entityId);
    res.json({ success: true, data: sales });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/sales — record a new sale (Module 2.2)
// Captures: Transaction ID, date/time, items, qty, unit prices, total,
// payment method (cash/credit/GCash/etc), customer, auto change/balance.
router.post('/', requireEmployee, async (req, res) => {
  const { items, total, paymentMethod, notes, businessCategory, entityId, entityName, subtotal, taxRate, taxAmount, amountPaid, customerName } = req.body;
  const biz = validateBizCategory(businessCategory || 'AGRI');

  // Verify employee has access to this business category
  // (entity-ID-based access like 'AGRI-rice-xxx' covers its parent category,
  // consistent with requireBusinessAccess / accessCoversCategory)
  const userAccess = req.session.user.businessAccess || [];
  if (!accessCoversCategory(userAccess, biz)) {
    return res.status(403).json({ success: false, message: 'Access denied to this business category.' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items in transaction.' });
  }

  const cleanPayment = validatePaymentMethod(paymentMethod);
  // Normalize items: always persist id/name/category/quantity/unitPrice/subtotal
  // so product-category filters (Module 2.4) actually work.
  const normalizedItems = (items || []).map((it) => {
    const qty = parseInt(it.quantity ?? it.qty ?? 1) || 1;
    const price = parseFloat(it.unitPrice ?? it.price ?? 0) || 0;
    return {
      id: it.id || '',
      name: sanitizeString(it.name || 'Item'),
      category: sanitizeString(it.category || ''),
      quantity: qty,
      qty,
      unitPrice: price,
      price,
      subtotal: parseFloat(it.subtotal) || qty * price,
    };
  });
  // Server-side recompute to prevent tampered totals. Client values are kept
  // only when they match the recomputed values within rounding tolerance.
  const recomputedSubtotal = normalizedItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
  const cleanTaxRate = Math.min(100, Math.max(0, parseFloat(taxRate || 0)));
  const recomputedTax = recomputedSubtotal * (cleanTaxRate / 100);
  const recomputedTotal = recomputedSubtotal + recomputedTax;
  const useClientTotals = Math.abs(parseFloat(total || 0) - recomputedTotal) < 0.06;

  const paid = amountPaid !== undefined && amountPaid !== null && amountPaid !== '' ? parseFloat(amountPaid) : null;
  const finalTotal = useClientTotals ? parseFloat(total || recomputedTotal) : recomputedTotal;
  // Credit sales may carry a balance; all other methods require full payment.
  let change = 0;
  let balanceDue = 0;
  if (paid !== null && !isNaN(paid)) {
    if (cleanPayment === 'credit') {
      change = Math.max(0, paid - finalTotal);
      balanceDue = Math.max(0, finalTotal - paid);
    } else {
      change = Math.max(0, paid - finalTotal);
      if (paid < finalTotal - 0.005) {
        return res.status(400).json({ success: false, message: 'Amount paid is less than the total.' });
      }
    }
  } else if (cleanPayment === 'credit') {
    balanceDue = finalTotal;
  }

  const now = new Date();
  const cleanCustomer = sanitizeString(customerName || req.body.customer || '') || 'Walk-in';
  const transaction = {
    date: now.toISOString(),
    time: now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    items: normalizedItems,
    subtotal: useClientTotals ? parseFloat(subtotal || recomputedSubtotal) : recomputedSubtotal,
    taxRate: cleanTaxRate,
    taxAmount: useClientTotals ? parseFloat(taxAmount || recomputedTax) : recomputedTax,
    total: finalTotal,
    amountPaid: paid !== null && !isNaN(paid) ? paid : (cleanPayment === 'credit' ? 0 : null),
    change: change || 0,
    balanceDue: balanceDue || 0,
    paymentMethod: cleanPayment,
    customerName: cleanCustomer,
    notes: sanitizeString(notes || ''),
    businessCategory: biz,
    recordedBy: req.session.user.uid,
    recordedByName: req.session.user.name,
    recordedByEmail: req.session.user.email || '',
    entityId: sanitizeString(entityId || ''),
    entityName: sanitizeString(entityName || ''),
    createdAt: now.toISOString(),
  };

  try {
    if (!firestore) return res.json({ success: true, data: transaction });
    // Recalculate total if not passed or zero
    if (!transaction.total && transaction.items.length > 0) {
      transaction.subtotal = transaction.items.reduce((sum, item) => sum + ((parseFloat(item.unitPrice) || 0) * (parseInt(item.quantity || item.qty) || 1)), 0);
      transaction.taxRate = transaction.taxRate || 0;
      transaction.taxAmount = transaction.subtotal * (transaction.taxRate / 100);
      transaction.total = transaction.subtotal + transaction.taxAmount;
    }

    const { id } = await FDB.addDoc('sales', transaction);
    transaction.id = id;
    transaction.transactionId = 'TXN-' + String(id).substring(0, 8).toUpperCase();
    await FDB.updateDoc('sales', id, { id, transactionId: transaction.transactionId, businessCategory: biz });

    // Audit log for COA traceability
    writeAudit(req, 'CREATE_SALE', `Sale ${transaction.transactionId} recorded in ${biz}: ${normalizedItems.length} item(s), total ${transaction.total}`, biz);

    // Deduct inventory quantities (Module 3.2 real-time stock tracking)
    // Enrich item category from inventory so sales filters keep working.
    for (const item of normalizedItems) {
      if (item.id) {
        const invData = await FDB.getById('inventory', item.id);
        if (invData && (!invData.businessCategory || invData.businessCategory === biz)) {
          if (!item.category && invData.category) item.category = invData.category;
          const deductQty = parseInt(item.quantity || 1);
          const oldQty = parseInt(invData.quantity || 0);
          if (oldQty < deductQty) {
            // Roll back the sale header to avoid phantom revenue on oversell.
            await FDB.deleteDoc('sales', transaction.id).catch(() => {});
            return res.status(400).json({ success: false, message: `Insufficient stock for ${invData.name || item.name}. Available: ${oldQty}.` });
          }
          const newQty = oldQty - deductQty;
          const reorder = parseInt(invData.reorderLevel || 10);

          let status = 'in-stock';
          if (newQty <= 0) status = 'out-of-stock';
          else if (newQty <= reorder) status = 'low-stock';

          await FDB.updateDoc('inventory', item.id, { quantity: newQty, status });

          // Log inventory movement for sale deduction
          await FDB.addDoc('inventoryMovements', {
            productId: item.id,
            productName: invData.name || '',
            businessCategory: biz,
            type: 'SALE_DEDUCTION',
            quantityChange: -deductQty,
            previousStock: parseInt(invData.quantity || 0),
            newStock: newQty,
            notes: `Deducted via Sale ${transaction.transactionId}`,
            createdAt: new Date().toISOString(),
            createdBy: req.session.user ? req.session.user.name : 'System POS',
            userId: req.session.user ? req.session.user.uid : 'system',
          }).catch(() => {});

          // Generate notification if low stock (consistent schema)
          if (status !== 'in-stock') {
            await FDB.addDoc('notifications', {
              type: 'low_stock',
              title: status === 'out-of-stock' ? 'Out of Stock Alert' : 'Low Stock Alert',
              message: `${invData.name} has dropped to ${newQty} items in ${biz}.`,
              businessCategory: biz,
              businessId: biz,
              priority: status === 'out-of-stock' ? 'critical' : 'warning',
              isRead: false,
              createdAt: new Date().toISOString(),
              createdByName: 'System',
            }).catch(() => {});
          }
        }
      }
    }

    // Persist enriched categories (filled from inventory lookup above)
    await FDB.updateDoc('sales', transaction.id, { items: normalizedItems }).catch(() => {});
    transaction.items = normalizedItems;

    // Auto-generate receipt response
    res.json({ success: true, data: transaction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ── Returns / Refunds ─────────────────────────────────────────────────────────
// Simple in-memory duplicate guard (same approach as inventory.js) so a
// double-clicked "Process Return" button can't refund twice.
const recentReturnRequests = [];
function isDuplicateReturn(key) {
  const now = Date.now();
  while (recentReturnRequests.length && now - recentReturnRequests[0].t > 10000) recentReturnRequests.shift();
  if (recentReturnRequests.some(r => r.key === key)) return true;
  recentReturnRequests.push({ key, t: now });
  return false;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// GET /api/sales/lookup?txnId=TXN-XXXX&biz=AGRI — find a sale to process a return
router.get('/lookup', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  const txnId = String(req.query.txnId || '').trim();
  if (!txnId) return res.status(400).json({ success: false, message: 'Transaction ID is required.' });
  try {
    if (!firestore) return res.status(404).json({ success: false, message: 'Sales storage unavailable.' });
    const sales = await FDB.getWhere('sales', 'businessCategory', '==', biz);
    const wanted = txnId.toUpperCase();
    const sale =
      sales.find(s => String(s.transactionId || '').toUpperCase() === wanted) ||
      sales.find(s => String(s.id || '').toUpperCase() === wanted) ||
      sales.find(s => String(s.transactionId || '').toUpperCase().includes(wanted));
    if (!sale) return res.status(404).json({ success: false, message: `No sale found for transaction "${txnId}" in ${biz}.` });
    if (sale.isReturnAdjustment) {
      return res.status(400).json({ success: false, message: 'This record is itself a return adjustment and cannot be returned.' });
    }
    // Include quantities already returned (from prior partial returns) so the
    // UI can cap each line at what is still returnable.
    const priorReturns = await FDB.getWhere('returns', 'originalSaleId', '==', sale.id);
    const returnedMap = {};
    (priorReturns || []).forEach(r => (r.items || []).forEach(it => {
      const key = it.id || it.name;
      returnedMap[key] = (returnedMap[key] || 0) + (parseInt(it.quantity) || 0);
    }));
    res.json({ success: true, data: { sale, returnedMap } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/sales/returns?biz=AGRI — Return History (Accounting / Sales staff)
router.get('/returns', requireViewer, async (req, res) => {
  const biz = validateBizCategory(req.query.biz || 'AGRI');
  try {
    if (!firestore) return res.json({ success: true, data: [] });
    let returns = await FDB.getWhere('returns', 'businessCategory', '==', biz);
    returns.sort((a, b) => (String(b.createdAt || '') < String(a.createdAt || '') ? -1 : 1));
    res.json({ success: true, data: returns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/sales/:id/return — process a Return / Refund against a recorded sale.
// Effects (mirrors a real refund):
//   1. Restocks returned quantities back into inventory + RETURN movement logs.
//   2. Writes a NEGATIVE sales adjustment record so dashboards/reports decrease
//      as if the sale never happened.
//   3. Stores a document in the `returns` collection for the Return History page.
router.post('/:id/return', requireEmployee, async (req, res) => {
  const { id } = req.params;
  const { items, reason, restock, customerName } = req.body;
  const userAccess = req.session.user.businessAccess || [];

  try {
    if (!firestore) return res.status(400).json({ success: false, message: 'Sales storage unavailable.' });
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No return items provided.' });
    }
    const sale = await FDB.getById('sales', id);
    if (!sale) return res.status(404).json({ success: false, message: 'Original sale not found.' });
    if (sale.isReturnAdjustment) {
      return res.status(400).json({ success: false, message: 'Return adjustments cannot be returned.' });
    }
    const biz = validateBizCategory(sale.businessCategory || req.body.businessCategory || 'AGRI');
    if (!accessCoversCategory(userAccess, biz)) {
      return res.status(403).json({ success: false, message: 'Access denied to this business category.' });
    }

    // Quantities already returned in previous partial returns of this sale
    const priorReturns = await FDB.getWhere('returns', 'originalSaleId', '==', id);
    const returnedMap = {};
    (priorReturns || []).forEach(r => (r.items || []).forEach(it => {
      const key = it.id || it.name;
      returnedMap[key] = (returnedMap[key] || 0) + (parseInt(it.quantity) || 0);
    }));

    const dupKey = `ret|${req.session.user.uid}|${id}|` + items.map(i => `${i.id || i.name}:${i.quantity}`).join(',') + `|${sanitizeString(reason || '')}`;
    if (isDuplicateReturn(dupKey)) {
      return res.status(429).json({ success: false, message: 'Duplicate return detected — this was already submitted a moment ago.' });
    }

    // Build validated return lines against the original sale items
    const returnItems = [];
    for (const raw of items) {
      const reqQty = parseInt(raw.quantity ?? raw.qty ?? 0);
      if (!reqQty || isNaN(reqQty) || reqQty <= 0) continue;
      const saleItem = (sale.items || []).find(it =>
        (raw.id && it.id === raw.id) || (!raw.id && String(it.name) === String(raw.name)));
      if (!saleItem) {
        return res.status(400).json({ success: false, message: `Item "${raw.name || raw.id}" was not part of sale ${sale.transactionId || id}.` });
      }
      const soldQty = parseInt(saleItem.quantity ?? saleItem.qty ?? 0);
      const already = returnedMap[saleItem.id || saleItem.name] || 0;
      const remaining = soldQty - already;
      if (reqQty > remaining) {
        return res.status(400).json({
          success: false,
          message: `Cannot return ${reqQty} × ${saleItem.name}. Only ${remaining} of ${soldQty} sold remain returnable.`
        });
      }
      returnItems.push({
        id: saleItem.id || '',
        name: saleItem.name,
        category: saleItem.category || '',
        quantity: reqQty,
        unitPrice: parseFloat(saleItem.unitPrice) || 0,
        unitCost: parseFloat(saleItem.unitCost) || 0,
        subtotal: round2((parseFloat(saleItem.unitPrice) || 0) * reqQty),
      });
      returnedMap[saleItem.id || saleItem.name] = already + reqQty;
    }
    if (returnItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Enter a return quantity of at least 1 for one or more items.' });
    }

    const refundSubtotal = round2(returnItems.reduce((sum, it) => sum + it.subtotal, 0));
    const taxRate = Math.min(100, Math.max(0, parseFloat(sale.taxRate || 0)));
    const refundTax = round2(refundSubtotal * (taxRate / 100));
    const refundTotal = round2(refundSubtotal + refundTax);
    const restockItems = restock !== false; // default: items go back on the shelf
    const cleanReason = sanitizeString(reason || '');
    const cleanCustomer = sanitizeString(customerName || sale.customerName || '');

    // 1) Restock inventory + movement logs
    if (restockItems) {
      for (const item of returnItems) {
        if (!item.id) continue;
        const inv = await FDB.getById('inventory', item.id);
        if (!inv || (inv.businessCategory && inv.businessCategory !== biz)) continue;
        const oldQty = parseInt(inv.quantity || 0);
        const newQty = oldQty + item.quantity;
        const reorder = parseInt(inv.reorderLevel || 10);
        const status = newQty <= 0 ? 'out-of-stock' : (newQty <= reorder ? 'low-stock' : 'in-stock');
        await FDB.updateDoc('inventory', item.id, { quantity: newQty, status, updatedAt: new Date().toISOString() });
        await FDB.addDoc('inventoryMovements', {
          productId: item.id,
          productName: inv.name || item.name,
          businessCategory: biz,
          type: 'RETURN',
          quantityChange: item.quantity,
          previousStock: oldQty,
          newStock: newQty,
          customerName: cleanCustomer,
          notes: cleanReason ? `Return from Sale ${sale.transactionId || id}: ${cleanReason}` : `Return from Sale ${sale.transactionId || id}`,
          createdAt: new Date().toISOString(),
          createdBy: req.session.user ? req.session.user.name : 'System POS',
          userId: req.session.user ? req.session.user.uid : 'system',
        }).catch(() => {});
      }
    }

    // 2) Negative sales adjustment — dashboard/reports treat it as reversed revenue
    const now = new Date();
    const returnSaleRecord = {
      date: now.toISOString(),
      time: now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
      items: returnItems.map(it => ({ ...it, subtotal: -it.subtotal })),
      subtotal: -refundSubtotal,
      taxRate,
      taxAmount: -refundTax,
      total: -refundTotal,
      amountPaid: 0,
      change: 0,
      balanceDue: 0,
      paymentMethod: 'RETURN_ADJUSTMENT',
      customerName: cleanCustomer,
      notes: cleanReason ? `Return adjustment for ${sale.transactionId || id}: ${cleanReason}` : `Return/refund adjustment for ${sale.transactionId || id}`,
      businessCategory: biz,
      entityId: sale.entityId || '',
      entityName: sale.entityName || '',
      recordedBy: req.session.user.uid,
      recordedByName: req.session.user.name,
      recordedByEmail: req.session.user.email || '',
      isReturnAdjustment: true,
      linkedSaleId: id,
      originalTransactionId: sale.transactionId || '',
      createdAt: now.toISOString(),
    };
    const { id: adjId } = await FDB.addDoc('sales', returnSaleRecord);
    await FDB.updateDoc('sales', adjId, { id: adjId }).catch(() => {});

    // 3) Return History record
    const returnRecord = {
      returnId: 'RTN-' + String(adjId).substring(0, 7).toUpperCase(),
      originalSaleId: id,
      originalTransactionId: sale.transactionId || '',
      adjustmentSaleId: adjId,
      items: returnItems,
      subtotal: refundSubtotal,
      taxRate,
      taxAmount: refundTax,
      refundTotal,
      reason: cleanReason,
      restocked: restockItems,
      paymentMethod: sale.paymentMethod || 'cash',
      customerName: cleanCustomer,
      businessCategory: biz,
      entityId: sale.entityId || '',
      entityName: sale.entityName || '',
      processedBy: req.session.user.uid,
      processedByName: req.session.user.name,
      createdAt: now.toISOString(),
    };
    const { id: retId } = await FDB.addDoc('returns', returnRecord);
    returnRecord.id = retId;
    await FDB.updateDoc('returns', retId, { id: retId }).catch(() => {});

    // Flag the original sale so staff can see it was (partially) refunded
    const prevReturned = parseFloat(sale.returnedTotal || 0);
    await FDB.updateDoc('sales', id, {
      hasReturn: true,
      returnedTotal: round2(prevReturned + refundTotal),
    }).catch(() => {});

    writeAudit(req, 'PROCESS_RETURN', `${returnRecord.returnId}: ${returnItems.map(i => `${i.quantity}x ${i.name}`).join(', ')} refunded PHP ${refundTotal} from ${sale.transactionId || id} in ${biz}${restockItems ? ' (restocked)' : ' (no restock)'}`, biz);

    res.json({ success: true, data: returnRecord });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/sales/:id
router.delete('/:id', requireManager, async (req, res) => {
  const { id } = req.params;
  try {
    if (existing) {
      await FDB.deleteDoc('sales', id);
      writeAudit(req, 'DELETE_SALE', `Sale ${existing.transactionId || id} deleted from ${existing.businessCategory || ''}`, existing.businessCategory);
      return res.json({ success: true });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

module.exports = router;
