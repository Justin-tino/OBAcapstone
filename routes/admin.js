/**
 * routes/admin.js
 * System Administrator routes: user management, business management,
 * audit logs, notifications, database backup, push KPI
 * Firestore flat model (see config/db.js)
 */
const express = require('express');
const router = express.Router();
const { firestore, auth } = require('../config/firebase');
const FDB = require('../config/db');
const { requireSuperAdmin, requireManager, requireViewer, sanitizeString, BUSINESS_UNITS } = require('../middleware/auth.middleware');

async function writeAudit(req, action, module, details, businessId = null, isSuspicious = false) {
  try {
    if (!firestore || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action, module, details: details || '', logType: 'transaction',
      previousValue: null, newValue: null, businessId,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '',
      timestamp: new Date().toISOString(), isSuspicious,
    }).catch(() => {});
  } catch (_) {}
}

// Custom middleware: manager or higher can write business entities
function requireManagerOnly(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const writeAllowed = ['manager', 'super_admin', 'admin', 'system_administrator', 'accounting_officer'];
  if (!writeAllowed.includes(req.session.user.role)) {
    return res.status(403).json({ success: false, message: 'Only managers or higher can add/edit business entities.' });
  }
  next();
}

// ─── Business Categories (3 main categories) ──────────────────────────────────
const BUSINESS_CATEGORIES = [
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

// GET /api/admin/business-categories — list 3 main categories
router.get('/business-categories', requireViewer, (req, res) => {
  res.json({ success: true, data: BUSINESS_CATEGORIES });
});

// GET /api/admin/business-units — list B8-B17 sub-units
router.get('/business-units', requireViewer, (req, res) => {
  res.json({ success: true, data: BUSINESS_UNITS });
});

// GET /api/admin/businesses — list all business entities
router.get('/businesses', requireViewer, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, data: mockBusinesses, categories: BUSINESS_CATEGORIES });
    const businesses = await FDB.getAll('businesses');
    res.json({ success: true, data: businesses, categories: BUSINESS_CATEGORIES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/businesses — create a new business workspace (manager+)
// Each business is an isolated workspace: { id, name, categoryId (AGRI/NON_AGRI/MAIN as label only), location, manager, description }
router.post('/businesses', requireManagerOnly, async (req, res) => {
  const { name: rawName, categoryId, type, location: rawLoc, manager: rawMgr, description: rawDesc } = req.body;
  const name = sanitizeString(rawName || '');
  const location = sanitizeString(rawLoc || '');
  const manager = sanitizeString(rawMgr || '');
  const description = sanitizeString(rawDesc || '');
  const VALID_CATS = ['AGRI', 'NON_AGRI', 'MAIN'];
  if (!name || !categoryId) {
    return res.status(400).json({ success: false, message: 'Business name and category are required.' });
  }
  if (!VALID_CATS.includes(categoryId)) {
    return res.status(400).json({ success: false, message: 'Invalid category. Choose Agriculture, Non-Agriculture or Main.' });
  }
  try {
    // Duplicate-name check (case-insensitive)
    let existing = [];
    if (!firestore) {
      existing = mockBusinesses;
    } else {
      existing = await FDB.getAll('businesses');
    }
    if (existing.some(b => (b.name || '').toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'A business with this name already exists.' });
    }
    // Unique id: CATEGORY-slug-timestamp (avoids old count+1 collision)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'biz';
    const newId = `${categoryId}-${slug}-${Date.now().toString(36)}`;
    const newBiz = {
      id: newId,
      categoryId, name, type: type || categoryId,
      location: location || '',
      manager: manager || '',
      description: description || '',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.name,
    };
    if (!firestore) {
      mockBusinesses.push(newBiz);
      return res.json({ success: true, data: newBiz });
    }
    await FDB.setDoc('businesses', newId, newBiz);
    writeAudit(req, 'CREATE_BUSINESS', `Business workspace "${name}" created under ${categoryId}`, newId);
    res.json({ success: true, data: newBiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/admin/businesses/:id — deactivate (soft delete) a business workspace
router.delete('/businesses/:id', requireManagerOnly, async (req, res) => {
  const { id } = req.params;
  try {
    if (!firestore) {
      const idx = mockBusinesses.findIndex(b => b.id === id);
      if (idx >= 0) mockBusinesses[idx].status = 'inactive';
      return res.json({ success: true });
    }
    await FDB.updateDoc('businesses', id, { status: 'inactive' });
    writeAudit(req, 'DEACTIVATE_BUSINESS', `Business ${id} deactivated`, id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/admin/businesses/:id — update business profile (manager only)
router.put('/businesses/:id', requireManagerOnly, async (req, res) => {
  const { id } = req.params;
  const updates = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    updates[k] = typeof v === 'string' ? sanitizeString(v) : v;
  }
  try {
    if (!firestore) {
      const biz = mockBusinesses.find(b => b.id === id);
      if (biz) Object.assign(biz, updates);
      return res.json({ success: true });
    }
    await FDB.updateDoc('businesses', id, updates);
    writeAudit(req, 'UPDATE_BUSINESS', `Business ${id} updated`, null);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// USER MANAGEMENT (Active / Inactive instead of delete)
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/users
router.get('/users', requireSuperAdmin, async (req, res) => {
  try {
    const cleanUsers = (arr) => {
      const seenUid = new Set();
      const seenEmail = new Set();
      const out = [];
      for (const u of arr || []) {
        if (!u || !u.email) continue;
        // Rejected signups are not accounts — hide them (they stay in accessRequests history)
        if ((u.status || '').toLowerCase() === 'rejected') continue;
        const uidKey = String(u.uid || '');
        const emailKey = String(u.email || '').toLowerCase();
        if (uidKey && seenUid.has(uidKey)) continue;
        if (seenEmail.has(emailKey)) continue;
        if (uidKey) seenUid.add(uidKey);
        seenEmail.add(emailKey);
        out.push(u);
      }
      return out;
    };
    if (!firestore) return res.json({ success: true, data: cleanUsers(mockUsers) });
    const docs = await FDB.getAll('users');
    const raw = docs.map(d => ({ ...d, uid: d.uid || d.id }));
    res.json({ success: true, data: cleanUsers(raw) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/users — create user
router.post('/users', requireSuperAdmin, async (req, res) => {
  const { name: rawName, email: rawEmail, role, businesses, password } = req.body;
  const name = sanitizeString(rawName || '');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!name || !email) return res.status(400).json({ success: false, message: 'Name and email are required.' });
  const allowedRoles = ['system_administrator', 'accounting_officer', 'sales_staff', 'employee', 'manager', 'viewer', 'super_admin'];
  const cleanRole = allowedRoles.includes(role) ? role : 'sales_staff';
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
      name, email, role: cleanRole,
      businesses: Array.isArray(businesses) && businesses.length ? businesses : ['all'],
      status: 'active',
      lastLogin: 'Never',
      createdAt: new Date().toISOString().split('T')[0],
      createdBy: req.session.user.name,
    };

    if (!firestore) {
      mockUsers.push(newUser);
      return res.json({ success: true, data: newUser });
    }

    await FDB.setDoc('users', uid, newUser);
    writeAudit(req, 'CREATE_USER', `User "${name}" (${email}) created with role ${cleanRole}`, null);
    res.json({ success: true, data: newUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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

    if (!firestore) {
      const u = mockUsers.find(u => u.uid === uid);
      if (u) Object.assign(u, dbUpdates);
      return res.json({ success: true });
    }

    // Do NOT store the plain-text password in the database
    try {
      await FDB.updateDoc('users', uid, dbUpdates);
    } catch (_) {
      await FDB.setDoc('users', uid, { uid, ...dbUpdates }, true);
    }
    writeAudit(req, 'UPDATE_USER', `User ${uid} updated: ${Object.keys(dbUpdates).join(', ')}`, null);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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
    if (firestore) {
      await FDB.addDoc('auditLogs', {
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
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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
    if (!firestore) {
      const idx = mockUsers.findIndex(u => u.uid === uid);
      if (idx !== -1) mockUsers.splice(idx, 1);
      return res.json({ success: true, message: 'User deleted.' });
    }
    await FDB.deleteDoc('users', uid);
    writeAudit(req, 'DELETE_USER', `User ${uid} deleted permanently`, null, true);
    res.json({ success: true, message: 'User deleted permanently.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MANAGER: EMPLOYEE MANAGEMENT (managers manage employees in their business)
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/employees — get employees under manager's business
router.get('/employees', requireManager, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, data: [] });
    const managerBiz = req.session.user.businessAccess || [];
    const docs = await FDB.getAll('users');
    let employees = docs.map(d => ({ ...d, uid: d.uid || d.id }));
    // Only return employees whose business matches manager's access
    employees = employees.filter(u => {
      if (u.role !== 'employee') return false;
      const userBiz = u.businesses || [];
      return userBiz.some(b => managerBiz.includes(b) || managerBiz.includes('all'));
    });
    res.json({ success: true, data: employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/employees — create employee (only employee role, auto-biz)
router.post('/employees', requireManager, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }
  const managerBiz = req.session.user.businessAccess || [];
  const biz = managerBiz.includes('all') ? 'AGRI' : managerBiz[0];
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
    if (!firestore) return res.json({ success: true, data: newUser });
    await FDB.setDoc('users', uid, newUser);
    res.json({ success: true, data: newUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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
    if (!firestore) return res.json({ success: true });
    // Verify the target user is an employee in this manager's business
    const target = await FDB.getById('users', uid);
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    if (target.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'You can only manage employees.' });
    }
    const managerBiz = req.session.user.businessAccess || [];
    const targetBiz = target.businesses || [];
    if (!managerBiz.includes('all') && !targetBiz.some(b => managerBiz.includes(b))) {
      return res.status(403).json({ success: false, message: 'This employee is not in your business.' });
    }
    await FDB.updateDoc('users', uid, updates);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/admin/employees/:uid — delete employee
router.delete('/employees/:uid', requireManager, async (req, res) => {
  const { uid } = req.params;
  try {
    if (!firestore) return res.json({ success: true, message: 'User deleted.' });
    const target = await FDB.getById('users', uid);
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
    await FDB.deleteDoc('users', uid);
    res.json({ success: true, message: 'User deleted permanently.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ACCESS REQUESTS
// ═══════════════════════════════════════════════════════════════════

router.get('/access-requests', requireSuperAdmin, getAccessRequests);
router.get('/requests', requireSuperAdmin, getAccessRequests);

async function getAccessRequests(req, res) {
  try {
    if (!firestore) return res.json({ success: true, data: mockRequests });
    const data = await FDB.getAll('accessRequests', 'createdAt');
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
}

router.post('/requests/:id/approve', requireSuperAdmin, handleRequest);
router.post('/requests/:id/reject', requireSuperAdmin, handleRequest);
router.put('/access-requests/:id/approve', requireSuperAdmin, handleRequest);
router.put('/access-requests/:id/reject', requireSuperAdmin, handleRequest);

async function handleRequest(req, res) {
  const { id } = req.params;
  const action = req.path.includes('approve') ? 'approved' : 'rejected';
  const { role, businesses, businessUnit } = req.body;
  const allowedRoles = ['system_administrator', 'accounting_officer', 'sales_staff', 'employee', 'manager', 'viewer'];
  const cleanRole = allowedRoles.includes(role) ? role : undefined;
  try {
    if (!firestore) {
      const req_ = mockRequests.find(r => r.id === id);
      if (req_) req_.status = action;
      return res.json({ success: true });
    }
    const update = { status: action, [`${action}By`]: req.session.user.uid, [`${action}At`]: new Date().toISOString() };
    const before = await FDB.getById('accessRequests', id) || {};
    if (action === 'approved') {
      if (cleanRole) update.role = cleanRole;
      else if (before.requestedRole && allowedRoles.includes(before.requestedRole)) update.role = before.requestedRole;
      const bizList = Array.isArray(businesses) && businesses.length ? businesses
        : (businessUnit ? [businessUnit] : (before.businessUnit ? [before.businessUnit] : null));
      if (bizList) update.businesses = bizList;
    }
    await FDB.updateDoc('accessRequests', id, update);
    if (action === 'approved') {
      const reqData = await FDB.getById('accessRequests', id);
      if (reqData && reqData.uid) {
        const finalRole = cleanRole || reqData.requestedRole || reqData.role || 'sales_staff';
        const finalBiz = Array.isArray(businesses) && businesses.length ? businesses
          : (reqData.businessUnit ? [reqData.businessUnit] : (reqData.businesses || ['AGRI']));
        try {
          await FDB.updateDoc('users', reqData.uid, { status: 'active', role: allowedRoles.includes(finalRole) ? finalRole : 'sales_staff', businesses: finalBiz });
        } catch (_) {
          await FDB.setDoc('users', reqData.uid, { status: 'active', role: allowedRoles.includes(finalRole) ? finalRole : 'sales_staff', businesses: finalBiz }, true);
        }
      }
      writeAudit(req, 'APPROVE_ACCESS', `Access request ${id} approved`, null);
    } else {
      if (before && before.uid) {
        try {
          await FDB.updateDoc('users', before.uid, { status: 'rejected' });
        } catch (_) {
          await FDB.setDoc('users', before.uid, { status: 'rejected' }, true);
        }
      }
      writeAudit(req, 'REJECT_ACCESS', `Access request ${id} rejected`, null);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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
    if (!firestore) {
      let data = mockAuditLogs.slice(-parseInt(limit)).reverse();
      if (type) data = data.filter(l => l.logType === type);
      return res.json({ success: true, data });
    }
    const all = await FDB.getAll('auditLogs', 'timestamp');
    let data = all.slice(0, parseInt(limit));
    if (type) data = data.filter(l => l.logType === type);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
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
    if (!firestore) { mockAuditLogs.push(log); return res.json({ success: true }); }
    await FDB.addDoc('auditLogs', log);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/user-activity — user activity monitoring
router.get('/user-activity', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) {
      const activity = mockUsers.map(u => ({
        uid: u.uid, name: u.name, email: u.email, role: u.role,
        status: u.status, lastLogin: u.lastLogin,
        actions: mockAuditLogs.filter(l => l.userId === u.uid).length,
      }));
      return res.json({ success: true, data: activity });
    }
    const docs = await FDB.getAll('users');
    const activity = docs.map(d => {
      const uid = d.uid || d.id;
      return { uid, name: d.name, email: d.email, role: d.role, status: d.status, lastLogin: d.lastLogin || 'Never', actions: 0 };
    });
    res.json({ success: true, data: activity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATIONS / ALERTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/notifications
router.get('/notifications', requireViewer, async (req, res) => {
  try {
    if (!firestore) {
      // Generate mock notifications
      const now = new Date();
      const defaultAlerts = [];
      return res.json({ success: true, data: defaultAlerts });
    }
    const all = await FDB.getAll('notifications', 'createdAt');
    const data = all.slice(0, 50);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/admin/notifications/:id/read
router.put('/notifications/:id/read', requireViewer, async (req, res) => {
  try {
    if (!firestore) {
      const n = mockNotifications.find(n => n.id === req.params.id);
      if (n) n.isRead = true;
      return res.json({ success: true });
    }
    await FDB.updateDoc('notifications', req.params.id, { isRead: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/notifications — create a notification (Super Admin, Manager, Accounting Officer)
router.post('/notifications', requireManager, async (req, res) => {
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
    if (!firestore) { mockNotifications.push(notif); return res.json({ success: true, data: notif }); }
    await FDB.setDoc('notifications', notif.id, notif);
    res.json({ success: true, data: notif });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BACKUP & RECOVERY
// ═══════════════════════════════════════════════════════════════════

// Helper for automated / scheduled database backups (stores full restorable blob)
async function executeAutoBackup(triggeredBy = 'SCHEDULED_SYSTEM') {
  if (!firestore) return null;
  const paths = ['sales', 'inventory', 'expenses', 'businesses', 'users', 'auditLogs', 'notifications', 'accessRequests', 'inventoryMovements', 'budgetLimits', 'settings'];
  const backup = { exportedAt: new Date().toISOString(), version: '1.0', data: {} };

  let totalRecords = 0;
  for (const p of paths) {
    if (p === 'settings') {
      const taxesDoc = await FDB.getById('settings', 'taxes').catch(() => null);
      backup.data[p] = taxesDoc ? { taxes: taxesDoc } : {};
      totalRecords += taxesDoc ? 1 : 0;
    } else {
      const docs = await FDB.getAll(p).catch(() => []);
      const map = {};
      for (const d of docs) {
        map[d.id] = d;
      }
      backup.data[p] = map;
      totalRecords += docs.length;
    }
  }

  const recordId = `b-${Date.now()}`;
  const record = {
    id: recordId,
    timestamp: new Date().toISOString(),
    triggeredBy,
    status: 'SUCCESS',
    totalRecords,
    pathsCount: paths.length
  };

  // Store metadata in history + full blob under backupsData for one-click restore
  await FDB.addDoc('backupsHistory', record).catch(() => {});
  await FDB.setDoc('backupsData', recordId, { ...record, backup }).catch(() => {});
  // Keep only the latest 30 full blobs to bound database size
  try {
    const all = await FDB.getAll('backupsData');
    const sorted = all.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
    if (sorted.length > 30) {
      for (const extra of sorted.slice(0, sorted.length - 30)) {
        await FDB.deleteDoc('backupsData', extra.id).catch(() => {});
      }
    }
  } catch (_) {}
  return record;
}

// GET /api/admin/backups/history — list backup history log
router.get('/backups/history', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, data: [] });
    const history = await FDB.getAll('backupsHistory', 'timestamp');
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, data: history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/backup — export all data as JSON download
router.get('/backup', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) return res.status(400).json({ success: false, message: 'Database not connected' });

    const paths = ['sales', 'inventory', 'expenses', 'businesses', 'users', 'auditLogs', 'notifications', 'accessRequests', 'inventoryMovements', 'budgetLimits', 'settings'];
    const backup = { exportedAt: new Date().toISOString(), version: '1.0', data: {} };

    for (const p of paths) {
      if (p === 'settings') {
        const taxesDoc = await FDB.getById('settings', 'taxes').catch(() => null);
        backup.data[p] = taxesDoc ? { taxes: taxesDoc } : {};
      } else {
        const docs = await FDB.getAll(p).catch(() => []);
        const map = {};
        for (const d of docs) {
          map[d.id] = d;
        }
        backup.data[p] = map;
      }
    }

    // Record manual backup in history (stores restorable blob as well)
    executeAutoBackup(`MANUAL (${req.session.user.name})`).catch(() => {});
    writeAudit(req, 'BACKUP', 'Manual database backup exported', null);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=oba-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json({ success: true, backup });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/backups/:backupId/download — download a stored backup blob
router.get('/backups/:backupId/download', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) return res.status(400).json({ success: false, message: 'Database not connected' });
    const stored = await FDB.getById('backupsData', req.params.backupId);
    if (!stored) return res.status(404).json({ success: false, message: 'Backup not found.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=oba-backup-${req.params.backupId}.json`);
    res.json({ success: true, backup: stored.backup || stored });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/restore/:backupId — one-click restore from stored history
router.post('/restore/:backupId', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) return res.status(400).json({ success: false, message: 'Database not connected' });
    const stored = await FDB.getById('backupsData', req.params.backupId);
    if (!stored) return res.status(404).json({ success: false, message: 'Backup not found.' });
    const backup = stored.backup || stored;
    if (!backup || !backup.data) return res.status(400).json({ success: false, message: 'Invalid backup data.' });
    for (const p of Object.keys(backup.data)) {
      const data = backup.data[p];
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        for (const docId of Object.keys(data)) {
          const docData = data[docId];
          if (!docData || typeof docData !== 'object') continue;
          if (p === 'settings') {
            await FDB.setDoc('settings', docId, docData);
          } else {
            await FDB.setDoc(p, docId, docData);
          }
        }
      }
    }
    writeAudit(req, 'RESTORE', `System restored from stored backup ${req.params.backupId}`, null, true);
    res.json({ success: true, message: 'System restored successfully from stored backup.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/restore — import backup data
router.post('/restore', requireSuperAdmin, async (req, res) => {
  const { backup } = req.body;
  if (!backup || !backup.data) {
    return res.status(400).json({ success: false, message: 'Invalid backup data' });
  }

  try {
    if (!firestore) return res.status(400).json({ success: false, message: 'Database not connected' });

    const paths = Object.keys(backup.data);
    for (const p of paths) {
      const data = backup.data[p];
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        for (const docId of Object.keys(data)) {
          const docData = data[docId];
          if (!docData || typeof docData !== 'object') continue;
          if (p === 'settings') {
            await FDB.setDoc('settings', docId, docData);
          } else {
            await FDB.setDoc(p, docId, docData);
          }
        }
      }
    }

    await FDB.addDoc('auditLogs', {
      action: 'RESTORE',
      module: 'backup',
      details: `System restored from backup dated ${backup.exportedAt || 'unknown'}`,
      logType: 'transaction',
      previousValue: null, newValue: null, businessId: null,
      userId: req.session.user.uid,
      userName: req.session.user.name,
      userEmail: req.session.user.email || '',
      timestamp: new Date().toISOString(),
      isSuspicious: true,
    });

    res.json({ success: true, message: 'System restored successfully from backup' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/backup/info — info about last backup
router.get('/backup/info', requireSuperAdmin, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, data: { lastBackup: 'Never', size: 0 } });

    const [sales, inventory, expenses, businesses, users] = await Promise.all([
      FDB.getAll('sales').catch(() => []),
      FDB.getAll('inventory').catch(() => []),
      FDB.getAll('expenses').catch(() => []),
      FDB.getAll('businesses').catch(() => []),
      FDB.getAll('users').catch(() => []),
    ]);

    const totalRecords = sales.length + inventory.length + expenses.length + businesses.length + users.length;

    res.json({ success: true, data: { lastBackup: 'Manual export only', totalRecords, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/taxes — list tax rates for each category (available to all logged in users)
const defaultTaxes = { AGRI: 0, NON_AGRI: 12, MAIN: 12 };
router.get('/taxes', requireViewer, async (req, res) => {
  try {
    if (!firestore) return res.json({ success: true, data: defaultTaxes });
    const taxes = await FDB.getById('settings', 'taxes');
    if (!taxes) {
      await FDB.setDoc('settings', 'taxes', defaultTaxes);
      return res.json({ success: true, data: defaultTaxes });
    }
    const { id: _drop, ...taxData } = taxes;
    res.json({ success: true, data: taxData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// POST /api/admin/taxes — update tax rates (Super Admin / Admin only)
router.post('/taxes', requireSuperAdmin, async (req, res) => {
  const { taxes } = req.body;
  if (!taxes) return res.status(400).json({ success: false, message: 'Taxes object is required.' });
  try {
    if (!firestore) {
      Object.assign(defaultTaxes, taxes);
      return res.json({ success: true, data: defaultTaxes });
    }
    const existing = await FDB.getById('settings', 'taxes').catch(() => null);
    const { id: _drop, ...existingData } = existing || {};
    await FDB.setDoc('settings', 'taxes', { ...existingData, ...taxes }, true);
    await FDB.addDoc('auditLogs', {
      action: 'UPDATE_TAX_RATES',
      module: 'settings',
      details: `Tax rates updated: ${JSON.stringify(taxes)}`,
      userId: req.session.user.uid,
      userName: req.session.user.name,
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, message: 'Tax rates updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

router.executeAutoBackup = executeAutoBackup;
module.exports = router;
