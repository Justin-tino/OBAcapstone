/**
 * functions/index.js — Cloud Functions for the OBA System.
 *
 * ⚠️ DISABLED — the primary datastore is now Supabase Postgres, not Firestore.
 *
 * These triggers fire on Firestore document writes. Since inventory writes now
 * go to Postgres, they will never fire again, and enabling them would create
 * an orphaned second datastore. The Express app already covers both behaviours
 * on the Supabase path:
 *   - low stock / out-of-stock alerts → utils/stock-notifs.js
 *     (emitStockStatusNotification, called from routes/inventory.js)
 *   - daily backup snapshot → routes/admin.js executeAutoBackup()
 *
 * Both functions are kept, commented out, for reference. Do not deploy them
 * unless the project is deliberately rolled back to Firestore
 * (DB_PROVIDER=firestore).
 *
 * Deploy with: firebase deploy --only functions   (only after rollback)
 */

/*
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const firestore = admin.firestore();

function computeStatus(stock, reorderLevel) {
  if (stock <= 0) return 'out-of-stock';
  if (stock <= reorderLevel) return 'low-stock';
  return 'in-stock';
}

exports.inventoryLowStockMonitor = onDocumentWritten(
  { document: 'inventory/{productId}', region: 'asia-southeast1' },
  async (event) => {
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return null;
    const qty = parseInt(after.quantity || 0, 10);
    const reorder = parseInt(after.reorderLevel || 10, 10);
    const status = computeStatus(qty, reorder);
    if (status === 'in-stock') return null;
    const category = after.businessCategory || 'AGRI';
    const name = after.name || event.params.productId;
    return firestore.collection('notifications').add({
      type: 'low_stock',
      title: status === 'out-of-stock' ? 'Out of Stock Alert' : 'Low Stock Alert',
      message: `${name} is at ${qty} items in ${category} (reorder at ${reorder}).`,
      businessCategory: category,
      businessId: category,
      priority: status === 'out-of-stock' ? 'critical' : 'warning',
      isRead: false,
      createdAt: new Date().toISOString(),
      createdByName: 'Cloud Function',
    });
  }
);

exports.dailyBackupHeartbeat = onSchedule(
  { schedule: 'every 24 hours', region: 'asia-southeast1' },
  async () => {
    return firestore.collection('backupsHistory').add({
      id: `b-${Date.now()}`,
      timestamp: new Date().toISOString(),
      triggeredBy: 'CLOUD_SCHEDULER_DAILY',
      status: 'SUCCESS',
      totalRecords: 0,
      pathsCount: 0,
      note: 'Scheduled heartbeat; full snapshot is written by the Express backup job.',
    });
  }
);
*/
