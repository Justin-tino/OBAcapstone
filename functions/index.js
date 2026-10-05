/**
 * functions/index.js — Cloud Functions for the OBA System (Firestore).
 *
 * - Low-stock monitor: watches inventory docs and creates a
 *   low_stock / out-of-stock notification when quantity falls
 *   at or below the reorder level.
 * - Scheduled backup marker: records a daily backup heartbeat
 *   (the Express app performs the full snapshot; this marker
 *   keeps the schedule visible in Firebase console).
 *
 * Deploy with: firebase deploy --only functions
 */
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
