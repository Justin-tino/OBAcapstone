/**
 * routes/admin.js
 * System Administrator routes: user management, business management,
 * audit logs, notifications, database backup, push KPI
 */
const express = require('express');
const router = express.Router();
const { db, auth } = require('../config/firebase');
const { requireSuperAdmin, requireManager, requireViewer } = require('../middleware/auth.middleware');

// Custom middleware: manager only (excludes super_admin from write operations)
function requireManagerOnly(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'manager') {
    return res.status(403).json({ success: false, message: 'Only managers can add/edit business entities.' });
  }
  next();
}

// ─── Business Categories (5 main categories) ──────────────────────────────────
const BUSINESS_CATEGORIES = [
  { id: 'RENTAL', name: 'Rental', type: 'Rental', description: 'Rental services and property management', color: '#6B3FA0' },
  { id: 'BUSINESS', name: 'Business', type: 'Business', description: 'Commercial and trading operations', color: '#2d6a2e' },
  { id: 'AGRI', name: 'Agriculture', type: 'Agriculture', description: 'Agricultural produce and farming operations', color: '#D4A915' },
  { id: 'NON_AGRI', name: 'Non-Agriculture', type: 'Non-Agriculture', description: 'Non-agricultural products and services', color: '#1A1A1A' },
  { id: 'MAIN', name: 'Main', type: 'Main', description: 'Main business operations and services', color: '#0D6EFD' },
];

// Mock business entities (sub-businesses under each category)
const mockBusinesses = [];

// Mock users store
const mockUsers = [];
const mockRequests = [];
const mockAuditLogs = [];
const mockNotifications = [];

// ═══════════════════════════════════════════════════════════════════
// BUSINESS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/business-categories — list 4 main categories
router.get('/business-categories', requireViewer, (req, res) => {
  res.json({ success: true, data: BUSINESS_CATEGORIES });
});

// GET /api/admin/businesses — list all business entities
router.get('/businesses', requireViewer, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, data: mockBusinesses, categories: BUSINESS_CATEGORIES });
    const snap = await db.ref('businesses').once('value');
    const val = snap.val() || {};
    const businesses = Object.keys(val).map(k => ({ id: k, ...val[k] }));
    res.json({ success: true, data: businesses, categories: BUSINESS_CATEGORIES });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/businesses — register new business entity (manager only)
router.post('/businesses', requireManagerOnly, async (req, res) => {
  const { name, categoryId, type, location, manager, description } = req.body;
  if (!name || !categoryId) {
    return res.status(400).json({ success: false, message: 'Business name and category are required.' });
  }
  const count = mockBusinesses.filter(b => b.categoryId === categoryId).length;
  const newBiz = {
    id: `${categoryId}-${count + 1}`,
    categoryId, name, type: type || categoryId,
    location: location || '',
    manager: manager || '',
    description: description || '',
    status: 'active',
    createdAt: new Date().toISOString().split('T')[0],
    createdBy: req.session.user.name,
  };
  try {
    if (!db) {
      mockBusinesses.push(newBiz);
      return res.json({ success: true, data: newBiz });
    }
    await db.ref(`businesses/${newBiz.id}`).set(newBiz);
    res.json({ success: true, data: newBiz });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/businesses/:id — update business profile (manager only)
router.put('/businesses/:id', requireManagerOnly, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  try {
    if (!db) {
      const biz = mockBusinesses.find(b => b.id === id);
      if (biz) Object.assign(biz, updates);
      return res.json({ success: true });
    }
    await db.ref(`businesses/${id}`).update(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// USER MANAGEMENT (Active / Inactive instead of delete)
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/users
router.get('/users', requireSuperAdmin, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, data: mockUsers });
    const snap = await db.ref('users').once('value');
    const val = snap.val() || {};
    res.json({ success: true, data: Object.keys(val).map(k => ({ uid: k, ...val[k] })) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/users — create user
router.post('/users', requireSuperAdmin, async (req, res) => {
  const { name, email, role, businesses, password } = req.body;
  let uid = `user-${Date.now()}`;
  
  try {
    if (auth) {
      try {
        const userRecord = await auth.createUser({
          email,
          password: password || '12345678',
          displayName: name,
        });
        uid = userRecord.uid;
      } catch (authErr) {
        if (authErr.code === 'auth/email-already-exists') {
          return res.json({ success: false, message: 'An account with this email already exists.' });
        }
        throw authErr;
      }
    }

    const newUser = {
      uid,
      name, email, role,
      businesses: businesses || ['all'],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString().split('T')[0],
      createdBy: req.session.user.name,
    };

    if (!db) {
      mockUsers.push(newUser);
      return res.json({ success: true, data: newUser });
    }
    
    await db.ref(`users/${uid}`).set(newUser);
    res.json({ success: true, data: newUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/users/:uid — update role/status/password
router.put('/users/:uid', requireSuperAdmin, async (req, res) => {
  const { uid } = req.params;
  const { password, ...dbUpdates } = req.body;

  try {
    // If a new password is provided, update it in Firebase Auth first
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      }
      if (auth) {
        await auth.updateUser(uid, { password });
      }
    }

    if (!db) {
      const u = mockUsers.find(u => u.uid === uid);
      if (u) Object.assign(u, dbUpdates);
      return res.json({ success: true });
    }

    // Do NOT store the plain-text password in the database
    await db.ref(`users/${uid}`).update(dbUpdates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/users/:uid/reset-password — super admin resets user password
router.post('/users/:uid/reset-password', requireSuperAdmin, async (req, res) => {
  const { uid } = req.params;
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }
  try {
    if (auth) {
      await auth.updateUser(uid, { password });
    }
    if (db) {
      await db.ref(`auditLogs`).push({
        action: 'PASSWORD_RESET_BY_ADMIN',
        module: 'users',
        details: `Password reset for user UID: ${uid}`,
        logType: 'user_activity',
        userId: req.session.user.uid,
        userName: req.session.user.name,
        userEmail: req.session.user.email || '',
        timestamp: new Date().toISOString()
      });
    }
    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/users/:uid — delete user permanently
router.delete('/users/:uid', requireSuperAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    if (auth) {
      try {
        await auth.deleteUser(uid);
      } catch (e) {
        console.warn('Could not delete user from Auth (may not exist):', e);
      }
    }
    if (!db) {
      const idx = mockUsers.findIndex(u => u.uid === uid);
      if (idx !== -1) mockUsers.splice(idx, 1);
      return res.json({ success: true, message: 'User deleted.' });
    }
    await db.ref(`users/${uid}`).remove();
    res.json({ success: true, message: 'User deleted permanently.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MANAGER: EMPLOYEE MANAGEMENT (managers manage employees in their business)
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/employees — get employees under manager's business
router.get('/employees', requireManager, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, data: [] });
    const managerBiz = req.session.user.businessAccess || [];
    const snap = await db.ref('users').once('value');
    const val = snap.val() || {};
    let employees = Object.keys(val).map(k => ({ uid: k, ...val[k] }));
    // Only return employees whose business matches manager's access
    employees = employees.filter(u => {
      if (u.role !== 'employee') return false;
      const userBiz = u.businesses || [];
      return userBiz.some(b => managerBiz.includes(b) || managerBiz.includes('all'));
    });
    res.json({ success: true, data: employees });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/employees — create employee (only employee role, auto-biz)
router.post('/employees', requireManager, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }
  const managerBiz = req.session.user.businessAccess || [];
  const biz = managerBiz.includes('all') ? 'RENTAL' : managerBiz[0];
  let uid = `user-${Date.now()}`;
  try {
    if (auth) {
      try {
        const userRecord = await auth.createUser({
          email,
          password: password || '12345678',
          displayName: name,
        });
        uid = userRecord.uid;
      } catch (authErr) {
        if (authErr.code === 'auth/email-already-exists') {
          return res.json({ success: false, message: 'An account with this email already exists.' });
        }
        throw authErr;
      }
    }
    const newUser = {
      uid, name, email,
      role: 'employee',
      businesses: [biz],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString().split('T')[0],
      createdBy: req.session.user.name,
    };
    if (!db) return res.json({ success: true, data: newUser });
    await db.ref(`users/${uid}`).set(newUser);
    res.json({ success: true, data: newUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/employees/:uid — update employee (only name/status/businesses)
router.put('/employees/:uid', requireManager, async (req, res) => {
  const { uid } = req.params;
  const allowed = ['name', 'status', 'businesses'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, message: 'No valid fields to update.' });
  }
  try {
    if (!db) return res.json({ success: true });
    // Verify the target user is an employee in this manager's business
    const snap = await db.ref(`users/${uid}`).once('value');
    const target = snap.val();
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    if (target.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'You can only manage employees.' });
    }
    const managerBiz = req.session.user.businessAccess || [];
    const targetBiz = target.businesses || [];
    if (!managerBiz.includes('all') && !targetBiz.some(b => managerBiz.includes(b))) {
      return res.status(403).json({ success: false, message: 'This employee is not in your business.' });
    }
    await db.ref(`users/${uid}`).update(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/employees/:uid — delete employee
router.delete('/employees/:uid', requireManager, async (req, res) => {
  const { uid } = req.params;
  try {
    if (!db) return res.json({ success: true, message: 'User deleted.' });
    const snap = await db.ref(`users/${uid}`).once('value');
    const target = snap.val();
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    if (target.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'You can only delete employees.' });
    }
    const managerBiz = req.session.user.businessAccess || [];
    const targetBiz = target.businesses || [];
    if (!managerBiz.includes('all') && !targetBiz.some(b => managerBiz.includes(b))) {
      return res.status(403).json({ success: false, message: 'This employee is not in your business.' });
    }
    if (auth) {
      try { await auth.deleteUser(uid); } catch (e) { /* ignore */ }
    }
    await db.ref(`users/${uid}`).remove();
    res.json({ success: true, message: 'User deleted permanently.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ACCESS REQUESTS
// ═══════════════════════════════════════════════════════════════════

router.get('/access-requests', requireSuperAdmin, getAccessRequests);
router.get('/requests', requireSuperAdmin, getAccessRequests);

async function getAccessRequests(req, res) {
  try {
    if (!db) return res.json({ success: true, data: mockRequests });
    const snap = await db.ref('accessRequests').orderByChild('createdAt').once('value');
    const val = snap.val() || {};
    const data = Object.keys(val).map(k => ({ id: k, ...val[k] })).reverse();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

router.post('/requests/:id/approve', requireSuperAdmin, handleRequest);
router.post('/requests/:id/reject', requireSuperAdmin, handleRequest);
router.put('/access-requests/:id/approve', requireSuperAdmin, handleRequest);

async function handleRequest(req, res) {
  const { id } = req.params;
  const action = req.path.includes('approve') ? 'approved' : 'rejected';
  const { role, businesses } = req.body;
  try {
    if (!db) {
      const req_ = mockRequests.find(r => r.id === id);
      if (req_) req_.status = action;
      return res.json({ success: true });
    }
    const update = { status: action, [`${action}By`]: req.session.user.uid, [`${action}At`]: new Date().toISOString() };
    if (action === 'approved' && role) { update.role = role; update.businesses = businesses; }
    await db.ref(`accessRequests/${id}`).update(update);
    if (action === 'approved') {
      const reqSnap = await db.ref(`accessRequests/${id}`).once('value');
      const reqData = reqSnap.val();
      if (reqData && reqData.uid) {
        await db.ref(`users/${reqData.uid}`).update({ status: 'active', role: role || 'viewer' });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT TRAIL (Enhanced: edit history, suspicious changes, user activity)
// ═══════════════════════════════════════════════════════════════════

router.get('/audit-logs', requireSuperAdmin, getAuditLogs);
router.get('/audit', requireSuperAdmin, getAuditLogs);

async function getAuditLogs(req, res) {
  const { limit = 100, type } = req.query;
  try {
    if (!db) {
      let data = mockAuditLogs.slice(-parseInt(limit)).reverse();
      if (type) data = data.filter(l => l.logType === type);
      return res.json({ success: true, data });
    }
    const snap = await db.ref('auditLogs').orderByChild('timestamp').limitToLast(parseInt(limit)).once('value');
    const val = snap.val() || {};
    let data = Object.keys(val).map(k => ({ id: k, ...val[k] })).reverse();
    if (type) data = data.filter(l => l.logType === type);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// POST /api/admin/audit-log — record an action
router.post('/audit-log', requireSuperAdmin, async (req, res) => {
  const { action, module, details, logType, previousValue, newValue, businessId } = req.body;
  const log = {
    action, module, details,
    logType: logType || 'transaction', // transaction | edit_history | user_activity
    previousValue: previousValue || null,
    newValue: newValue || null,
    businessId: businessId || null,
    userId: req.session.user.uid,
    userName: req.session.user.name,
    userEmail: req.session.user.email || '',
    timestamp: new Date().toISOString(),
    isSuspicious: false,
  };

  // Detect suspicious changes
  if (action === 'DELETE' || action === 'BULK_EDIT' ||
      (previousValue && newValue && action === 'EDIT')) {
    log.isSuspicious = true;
  }

  try {
    if (!db) { mockAuditLogs.push(log); return res.json({ success: true }); }
    await db.ref('auditLogs').push(log);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/user-activity — user activity monitoring
router.get('/user-activity', requireSuperAdmin, async (req, res) => {
  try {
    if (!db) {
      const activity = mockUsers.map(u => ({
        uid: u.uid, name: u.name, email: u.email, role: u.role,
        status: u.status, lastLogin: u.lastLogin,
        actions: mockAuditLogs.filter(l => l.userId === u.uid).length,
      }));
      return res.json({ success: true, data: activity });
    }
    const usersSnap = await db.ref('users').once('value');
    const val = usersSnap.val() || {};
    const activity = Object.keys(val).map(uid => {
      const u = val[uid];
      return { uid, name: u.name, email: u.email, role: u.role, status: u.status, lastLogin: u.lastLogin || 'Never', actions: 0 };
    });
    res.json({ success: true, data: activity });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATIONS / ALERTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/notifications
router.get('/notifications', requireViewer, async (req, res) => {
  try {
    if (!db) {
      // Generate mock notifications
      const now = new Date();
      const defaultAlerts = [];
      return res.json({ success: true, data: defaultAlerts });
    }
    const snap = await db.ref('notifications').orderByChild('createdAt').limitToLast(50).once('value');
    const val = snap.val() || {};
    const data = Object.keys(val).map(k => ({ id: k, ...val[k] })).reverse();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/notifications/:id/read
router.put('/notifications/:id/read', requireViewer, async (req, res) => {
  try {
    if (!db) {
      const n = mockNotifications.find(n => n.id === req.params.id);
      if (n) n.isRead = true;
      return res.json({ success: true });
    }
    await db.ref(`notifications/${req.params.id}`).update({ isRead: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/notifications — create a notification
router.post('/notifications', requireSuperAdmin, async (req, res) => {
  const { type, title, message, businessId, priority } = req.body;
  const notif = {
    id: `n-${Date.now()}`,
    type: type || 'system',
    title, message,
    businessId: businessId || null,
    priority: priority || 'info',
    isRead: false,
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.uid,
  };
  try {
    if (!db) { mockNotifications.push(notif); return res.json({ success: true, data: notif }); }
    await db.ref(`notifications/${notif.id}`).set(notif);
    res.json({ success: true, data: notif });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BACKUP & RECOVERY
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/backup — export all data as JSON download
router.get('/backup', requireSuperAdmin, async (req, res) => {
  try {
    if (!db) return res.status(400).json({ success: false, message: 'Database not connected' });

    const paths = ['sales', 'inventory', 'expenses', 'businesses', 'users', 'auditLogs', 'notifications', 'accessRequests'];
    const backup = { exportedAt: new Date().toISOString(), version: '1.0', data: {} };

    for (const p of paths) {
      const snap = await db.ref(p).once('value');
      backup.data[p] = snap.val() || {};
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=oba-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json({ success: true, backup });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/restore — import backup data
router.post('/restore', requireSuperAdmin, async (req, res) => {
  const { backup } = req.body;
  if (!backup || !backup.data) {
    return res.status(400).json({ success: false, message: 'Invalid backup data' });
  }

  try {
    if (!db) return res.status(400).json({ success: false, message: 'Database not connected' });

    const paths = Object.keys(backup.data);
    for (const p of paths) {
      const data = backup.data[p];
      if (typeof data === 'object' && Object.keys(data).length > 0) {
        await db.ref(p).set(data);
      }
    }

    await db.ref('auditLogs').push({
      action: 'RESTORE',
      module: 'backup',
      details: `System restored from backup dated ${backup.exportedAt || 'unknown'}`,
      userId: req.session.user.uid,
      userName: req.session.user.name,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'System restored successfully from backup' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/backup/info — info about last backup
router.get('/backup/info', requireSuperAdmin, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, data: { lastBackup: 'Never', size: 0 } });

    const [sSnap, iSnap, eSnap, bSnap, uSnap] = await Promise.all([
      db.ref('sales').once('value'),
      db.ref('inventory').once('value'),
      db.ref('expenses').once('value'),
      db.ref('businesses').once('value'),
      db.ref('users').once('value'),
    ]);

    const totalRecords = [sSnap, iSnap, eSnap, bSnap, uSnap].reduce((acc, snap) => {
      const val = snap.val() || {};
      let count = 0;
      // For nested data (sales/RENTAL), count deeper keys
      Object.values(val).forEach(v => { if (typeof v === 'object') count += Object.keys(v).length; else count++; });
      return acc + count;
    }, 0);

    res.json({ success: true, data: { lastBackup: 'Manual export only', totalRecords, timestamp: new Date().toISOString() } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/taxes — list tax rates for each category (available to all logged in users)
const defaultTaxes = { RENTAL: 12, BUSINESS: 12, AGRI: 0, NON_AGRI: 12, MAIN: 12 };
router.get('/taxes', requireViewer, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, data: defaultTaxes });
    const snap = await db.ref('settings/taxes').once('value');
    if (!snap.exists()) {
      await db.ref('settings/taxes').set(defaultTaxes);
      return res.json({ success: true, data: defaultTaxes });
    }
    res.json({ success: true, data: snap.val() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/taxes — update tax rates (Super Admin / Admin only)
router.post('/taxes', requireSuperAdmin, async (req, res) => {
  const { taxes } = req.body;
  if (!taxes) return res.status(400).json({ success: false, message: 'Taxes object is required.' });
  try {
    if (!db) {
      Object.assign(defaultTaxes, taxes);
      return res.json({ success: true, data: defaultTaxes });
    }
    await db.ref('settings/taxes').update(taxes);
    await db.ref('auditLogs').push({
      action: 'UPDATE_TAX_RATES',
      module: 'settings',
      details: `Tax rates updated: ${JSON.stringify(taxes)}`,
      userId: req.session.user.uid,
      userName: req.session.user.name,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Tax rates updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
