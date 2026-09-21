/**
 * routes/notifications.js
 * Sales-staff / employee notification feed (scoped to the user's business access)
 *
 * Employees must NEVER see the full admin notification feed. This router serves
 * only the notifications that belong to the business categories the logged-in
 * employee has access to (low-stock alerts, inventory updates, messages sent
 * to their category). Mounted at /api/employee in server.js.
 */
const express = require('express');
const router = express.Router();
const FDB = require('../config/db');
const { firestore } = require('../config/firebase');
const { requireEmployee, accessCoversCategory, validateBizCategory } = require('../middleware/auth.middleware');

// Notification types that are relevant to sales staff.
// Admin-only operational alerts (backups, user management, audit, etc.) are
// never pushed to employees anyway, but we whitelist defensively so new
// internal admin types can't leak into the employee feed.
const EMPLOYEE_NOTIF_TYPES = ['low_stock', 'inventory', 'sale', 'sale_completed', 'message', 'system'];

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

// GET /api/employee/notifications?biz=AGRI — scoped notification feed
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

    if (!firestore) return res.json({ success: true, data: [] });

    let all = await FDB.getAll('notifications', 'createdAt');
    all = all.filter(n => {
      // Type whitelist for the employee feed
      if (n.type && !EMPLOYEE_NOTIF_TYPES.includes(n.type)) return false;
      // Category scope: notification must belong to one of the user's categories
      const cat = n.businessCategory || n.businessId || null;
      if (!cat) return true; // system-wide messages (e.g. announcements) still visible
      if (bizFilter) return cat === bizFilter;
      if (isAll) return true;
      return accessCoversCategory(access, cat);
    });
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

module.exports = router;
