/**
 * utils/stock-notifs.js
 * Shared stock-status notification helper.
 *
 * Sales-staff notification feed contract (types):
 *   restock       → "New Restock"
 *   low_stock     → "Low Stock Alert"
 *   high_stock    → "High Stock Alert"
 *   normal_stock  → "Stock Level Normal"
 *   out_of_stock  → "Out of Stock Alert"
 *
 * Every notification is stamped with the workspace entity it originated from
 * (entityId/entityName) so each business only sees ITS OWN notifications in
 * the per-business feed (routes/notifications.js filters on entityId).
 */
const FDB = require('../config/db');
const { dbReady } = require('../config/db');

// A product is considered HIGH STOCK when its quantity exceeds this
// multiple of its reorder level (e.g. reorder 10 → high at >100).
const HIGH_STOCK_MULTIPLIER = 10;

const NOTIF_COALESCE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Stock status buckets for the sales-staff feed
function computeStockStatus(stock, reorderLevel) {
  const qty = parseInt(stock || 0, 10);
  const reorder = Math.max(0, parseInt(reorderLevel || 10, 10));
  if (qty <= 0) return 'out_of_stock';
  if (qty <= reorder) return 'low_stock';
  if (qty > reorder * HIGH_STOCK_MULTIPLIER) return 'high_stock';
  return 'normal_stock';
}

const STATUS_META = {
  low_stock:    { title: 'Low Stock Alert',    priority: 'warning',  cls: 'low_stock' },
  high_stock:   { title: 'High Stock Alert',   priority: 'warning',  cls: 'high_stock' },
  normal_stock: { title: 'Stock Level Normal', priority: 'info',     cls: 'normal_stock' },
  out_of_stock: { title: 'Out of Stock Alert', priority: 'critical', cls: 'out_of_stock' },
};

// Resolve the workspace entity (business unit) a request came from.
function workspaceEntity(req) {
  const b = (req && req.body) || {};
  const q = (req && req.query) || {};
  return {
    entityId: String(b.entityId || b.entity || q.entity || '').trim(),
    entityName: String(b.entityName || q.entityName || '').trim(),
  };
}

// Upsert a coalesced notification: repeated events for the same key within
// the window refresh the existing document instead of creating duplicates.
async function upsertNotification({ coalesceKey, buildNotification, buildUpdate }) {
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
      await FDB.updateDoc('notifications', existing.id, {
        ...buildUpdate(existing),
        createdAt: nowIso,
        isRead: false,
      }).catch(() => {});
    } else {
      const notif = buildNotification(nowIso);
      await FDB.setDoc('notifications', notif.id, notif).catch(() => {});
    }
  } catch (_) {}
}

/**
 * Emit a stock-status notification for a product.
 * Emits only when the status is low/high/out of stock, or when the stock
 * has just TRANSITIONED back to normal (pass emitNormal: true for that).
 */
async function emitStockStatusNotification({
  productName, productId, newQty, reorderLevel, biz,
  entityId = '', entityName = '', actorName = 'System',
  emitNormal = false,
}) {
  try {
    if (!dbReady) return;
    const status = computeStockStatus(newQty, reorderLevel);
    if (status === 'normal_stock' && !emitNormal) return;
    const meta = STATUS_META[status];
    const entLabel = entityName ? ` — ${entityName}` : '';
    const message = status === 'out_of_stock'
      ? `${productName} is out of stock in ${biz}${entLabel}. Immediate replenishment needed.`
      : status === 'low_stock'
        ? `${productName} is at ${newQty} items in ${biz}${entLabel} (reorder at ${reorderLevel}).`
        : status === 'high_stock'
          ? `${productName} is at ${newQty} items in ${biz}${entLabel} — well above the reorder level of ${reorderLevel}. Consider prioritizing sales.`
          : `${productName} stock is back to a normal level (${newQty} items) in ${biz}${entLabel}.`;
    const notif = {
      id: `n-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: status,
      title: meta.title,
      message,
      coalesceKey: `stock:${biz}:${productId || productName}:${status}`,
      productId: productId || '',
      productName: productName || '',
      businessCategory: biz,
      businessId: biz,
      entityId: entityId || '',
      entityName: entityName || '',
      priority: meta.priority,
      isRead: false,
      createdAt: new Date().toISOString(),
      createdBy: 'system',
      createdByName: actorName || 'System',
    };
    await upsertNotification({
      coalesceKey: notif.coalesceKey,
      buildNotification: (nowIso) => ({ ...notif, createdAt: nowIso }),
      buildUpdate: () => ({ message, priority: meta.priority }),
    });
  } catch (_) {}
}

module.exports = {
  HIGH_STOCK_MULTIPLIER,
  computeStockStatus,
  workspaceEntity,
  upsertNotification,
  emitStockStatusNotification,
};
