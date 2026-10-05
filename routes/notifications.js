/**
 * routes/notifications.js
 * Sales-staff / employee notification feed (scoped to the user's business access)
 *
 * Employees must NEVER see the full admin notification feed. This router serves
 * only the notifications that belong to the business the logged-in employee is
 * currently working in (?biz=<category>&entity=<workspace entity id>).
 *
 * Notifications are stamped with entityId at creation time (utils/stock-notifs.js),
 * so a workspace for Business 1 never receives notifications generated inside
 * Business 2 — even when both businesses share the same top-level category.
 *
 * Feed contents for sales staff: New Restock, Low Stock, High Stock,
 * Normal Stock, Out of Stock (+ manager announcements).
 * Mounted at /api/employee in server.js.
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { firestore } = require('../config/firebase');
const { requireEmployee, accessCoversCategory, validateBizCategory, sanitizeString } = require('../middleware/auth.middleware');

// Notification types that are relevant to sales staff.
// Stock lifecycle: new restock, low stock, high stock, normal, out of stock.
// 'message' / 'system' are manager announcements (category-wide).
const EMPLOYEE_NOTIF_TYPES = [
  'restock', 'low_stock', 'high_stock', 'normal_stock', 'out_of_stock',
  'message', 'system',
];

function userCategories(user) {
  const access = user.businessAccess || [];
  // Business access holds category ids (AGRI) or entity ids (AGRI-slug-xxx).
  // Map each access entry to its top-level category for filtering.
  const cats = [];
  for (const a of access) {
    if (!a || a === 'all') continue;
    const s = String(a);
    const cat = s.startsWith('NON_AGRI') ? 'NON_AGRI' : s.startsWith('MAIN') ? 'MAIN' : s.startsWith('AGRI') ? 'AGRI' : s;
    if (!cats.includes(cat)) cats.push(cat);
  }
  return cats;
}

// Build the scope filter shared by the list & clear-all endpoints.
function scopeFilter({ user, bizFilter, entityFilter }) {
  const access = user.businessAccess || [];
  const isAll = access.includes('all');
  const cats = userCategories(user);
  return (n) => {
    // Type whitelist for the employee feed
    if (n.type && !EMPLOYEE_NOTIF_TYPES.includes(n.type)) return false;
    // Category scope: notification must belong to one of the user's categories
    const cat = n.businessCategory || n.businessId || null;
    if (cat) {
      if (bizFilter && cat !== bizFilter) return false;
      if (!bizFilter && !isAll && !cats.includes(cat) && !accessCoversCategory(access, cat)) return false;
    }
    // Per-business (entity) scope. Notifications stamped with an entityId are
    // only visible inside that business's workspace. Notifications WITHOUT an
    // entityId are category-wide (e.g. manager announcements) and stay visible
    // in every workspace of the category.
    if (entityFilter) {
      if (n.entityId) return n.entityId === entityFilter;
      if (cat && !['message', 'system'].includes(n.type)) return false;
    }
    return true;
  };
}

// GET /api/employee/notifications?biz=AGRI&entity=AGRI-slug-xxx — scoped feed
router.get('/notifications', requireEmployee, async (req, res) => {
  try {
    const user = req.session.user;
    const access = user.businessAccess || [];
    const isAll = access.includes('all');
    const cats = userCategories(user);

    // Optional narrowing: ?biz= must be within the user's access
    let bizFilter = null;
    if (req.query.biz) {
      bizFilter = validateBizCategory(req.query.biz);
      if (!isAll && !cats.includes(bizFilter)) {
        return res.status(403).json({ success: false, message: 'This account is not under this category.' });
      }
    }
    // Optional per-business narrowing: ?entity=<workspace entity id>
    const entityFilter = req.query.entity ? sanitizeString(String(req.query.entity)) : null;

    if (!firestore) return res.json({ success: true, data: [] });

    let all = await FDB.getAll('notifications', 'createdAt');
    const matches = scopeFilter({ user, bizFilter, entityFilter });
    all = all.filter(matches);
    res.json({ success: true, data: all.slice(0, 50) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/employee/notifications/:id/read — mark as read (scoped)
router.put('/notifications/:id/read', requireEmployee, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true });
    const user = req.session.user;
    const notif = await FDB.getById('notifications', req.params.id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found.' });
    const cat = notif.businessCategory || notif.businessId || null;
    const access = user.businessAccess || [];
    if (cat && !access.includes('all') && !accessCoversCategory(access, cat)) {
      return res.status(403).json({ success: false, message: 'Access denied to this notification.' });
    }
    await FDB.updateDoc('notifications', req.params.id, { isRead: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/employee/notifications/:id — delete a single notification (scoped)
router.delete('/notifications/:id', requireEmployee, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true });
    const user = req.session.user;
    const notif = await FDB.getById('notifications', req.params.id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found.' });
    const cat = notif.businessCategory || notif.businessId || null;
    const access = user.businessAccess || [];
    if (cat && !access.includes('all') && !accessCoversCategory(access, cat)) {
      return res.status(403).json({ success: false, message: 'Access denied to this notification.' });
    }
    await FDB.deleteDoc('notifications', req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/employee/notifications?biz=AGRI&entity=... — clear the whole scoped feed
router.delete('/notifications', requireEmployee, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, deleted: 0 });
    const user = req.session.user;
    const access = user.businessAccess || [];
    const isAll = access.includes('all');
    const cats = userCategories(user);

    let bizFilter = null;
    if (req.query.biz) {
      bizFilter = validateBizCategory(req.query.biz);
      if (!isAll && !cats.includes(bizFilter)) {
        return res.status(403).json({ success: false, message: 'This account is not under this category.' });
      }
    }
    const entityFilter = req.query.entity ? sanitizeString(String(req.query.entity)) : null;

    const all = await FDB.getAll('notifications', 'createdAt');
    const matches = scopeFilter({ user, bizFilter, entityFilter });
    const scoped = all.filter(matches).slice(0, 200);
    for (const n of scoped) {
      await FDB.deleteDoc('notifications', n.id).catch(() => {});
    }
    res.json({ success: true, deleted: scoped.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

module.exports = router;
