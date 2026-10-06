/**
 * routes/admin.js
 * System Administrator routes: user management, business management,
 * audit logs, notifications, database backup, push KPI
 * Firestore flat model (see config/db.js)
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../config/firebase');
const FDB = require('../config/db');
const { dbReady } = require('../config/db');
const { requireSuperAdmin, requireManager, requireViewer, sanitizeString, BUSINESS_UNITS } = require('../middleware/auth.middleware');
const { sendMail, transportName, isConfigured } = require('../utils/mailer');
const crypto = require('crypto');
const archiver = require('archiver');

// ── Outgoing mail for the backup-download OTP goes through utils/mailer.js
// (Brevo HTTPS API, SMTP fallback). It used to be a raw nodemailer SMTP
// transport here, which never connected from Railway — Gmail's :587 is not
// reachable from that host. See utils/mailer.js.

async function writeAudit(req, action, module, details, businessId = null, isSuspicious = false) {
  try {
    if (!dbReady || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action, module, details: details || '', logType: 'transaction',
      previousValue: null, newValue: null, businessId,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '',
      timestamp: new Date().toISOString(), isSuspicious,
    }).catch(() => {});
  } catch (_) {}
}

// System notification helper for backup/restore events (success & failure).
// Uses type 'backup_restore' so it appears in the admin bell and Alert Logs.
async function notifyBackupEvent(req, success, message) {
  try {
    if (!dbReady) return;
    const id = `n-${Date.now()}`;
    await FDB.setDoc('notifications', id, {
      id,
      type: 'backup_restore',
      title: success ? 'Backup Restored Successfully' : 'Backup Restore Failed',
      message,
      businessId: null,
      entityId: '',
      entityName: '',
      priority: success ? 'info' : 'critical',
      isRead: false,
      createdAt: new Date().toISOString(),
      createdBy: (req.session && req.session.user && req.session.user.uid) || null,
    }).catch(() => {});
  } catch (_) { /* notification is non-fatal */ }
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
    if (!dbReady) return res.json({ success: true, data: mockBusinesses, categories: BUSINESS_CATEGORIES });
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
    if (!dbReady) {
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
    if (!dbReady) {
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

// DELETE /api/admin/businesses/:id — permanently delete a business workspace.
//
// The row is removed outright, so the business can never be reactivated or
// resurrected. Only the `businesses` row is deleted: inventory, sales, returns,
// expenses, inventory movements and audit logs are deliberately KEPT so
// historical reports and the audit trail stay intact and reconcilable.
//
// NOTE: a business is referenced by `entityId`, which for sales/returns/
// expenses/inventory_movements lives inside the `data` jsonb (only `inventory`
// has a real entity_id column). Deleting only the businesses row avoids having
// to cascade across those tables, which is the point of this endpoint.
router.delete('/businesses/:id', requireManagerOnly, async (req, res) => {
  const { id } = req.params;
  try {
    if (!dbReady) {
      const idx = mockBusinesses.findIndex(b => b.id === id);
      if (idx >= 0) mockBusinesses.splice(idx, 1);
      return res.json({ success: true });
    }

    // Resolve first so we can refuse unknown ids instead of reporting success
    // for a row that was never there.
    const existing = await FDB.getById('businesses', id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Business not found.' });
    }

    await FDB.deleteDoc('businesses', id);
    writeAudit(req, 'DELETE_BUSINESS', 'business',
      `Business "${existing.name || id}" (${id}) permanently deleted; related records retained`,
      null, true);
    res.json({ success: true, name: existing.name || id });
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
    if (!dbReady) {
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
        // Rejected signups are not accounts — hide them (they stay in accessRequests history).
        // Pending signups are also not accounts yet — they live in the Access Requests
        // tab until approved (approve flips their users doc status to 'active').
        const st = String(u.status || '').toLowerCase();
        if (st === 'rejected' || st === 'pending') continue;
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
    if (!dbReady) return res.json({ success: true, data: cleanUsers(mockUsers) });
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

    if (!dbReady) {
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

    if (!dbReady) {
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
    if (dbReady) {
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
    if (!dbReady) {
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
    if (!dbReady) return res.json({ success: true, data: [] });
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
    if (!dbReady) return res.json({ success: true, data: newUser });
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
    if (!dbReady) return res.json({ success: true });
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
    if (!dbReady) return res.json({ success: true, message: 'User deleted.' });
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
    if (!dbReady) return res.json({ success: true, data: mockRequests });
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
    if (!dbReady) {
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
    if (!dbReady) {
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
    if (!dbReady) { mockAuditLogs.push(log); return res.json({ success: true }); }
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
    if (!dbReady) {
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
// Admin feed contains ONLY report-generation events:
// who generated which report and for which category.
router.get('/notifications', requireViewer, async (req, res) => {
  try {
    if (!dbReady) {
      // Generate mock notifications
      const now = new Date();
      const defaultAlerts = [];
      return res.json({ success: true, data: defaultAlerts });
    }
    const all = await FDB.getAll('notifications', 'createdAt');
    const data = all.filter(n => n.type === 'report_generated' || n.type === 'backup_restore').slice(0, 50);
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// PUT /api/admin/notifications/:id/read
router.put('/notifications/:id/read', requireViewer, async (req, res) => {
  try {
    if (!dbReady) {
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
  const { type, title, message, businessId, priority, entityId, entityName } = req.body;
  const notif = {
    id: `n-${Date.now()}`,
    type: type || 'system',
    title, message,
    businessId: businessId || null,
    entityId: entityId || '',
    entityName: entityName || '',
    priority: priority || 'info',
    isRead: false,
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.uid,
  };
  try {
    if (!dbReady) { mockNotifications.push(notif); return res.json({ success: true, data: notif }); }
    await FDB.setDoc('notifications', notif.id, notif);
    res.json({ success: true, data: notif });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/admin/notifications/:id — delete a single notification
router.delete('/notifications/:id', requireViewer, async (req, res) => {
  try {
    if (!dbReady) {
      const idx = mockNotifications.findIndex(n => n.id === req.params.id);
      if (idx !== -1) mockNotifications.splice(idx, 1);
      return res.json({ success: true });
    }
    await FDB.deleteDoc('notifications', req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// DELETE /api/admin/notifications — clear the whole admin (report) feed
router.delete('/notifications', requireViewer, async (req, res) => {
  try {
    if (!dbReady) {
      mockNotifications.length = 0;
      return res.json({ success: true, deleted: 0 });
    }
    const all = await FDB.getAll('notifications', 'createdAt');
    const scoped = all.filter(n => n.type === 'report_generated' || n.type === 'backup_restore').slice(0, 200);
    for (const n of scoped) {
      await FDB.deleteDoc('notifications', n.id).catch(() => {});
    }
    res.json({ success: true, deleted: scoped.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BACKUP & RECOVERY
// ═══════════════════════════════════════════════════════════════════

// Shared: build the full restorable backup object (used by auto + manual backups)
const BACKUP_PATHS = ['sales', 'inventory', 'expenses', 'businesses', 'users', 'auditLogs', 'notifications', 'accessRequests', 'inventoryMovements', 'budgetLimits', 'settings'];

async function buildBackupData() {
  const backup = { exportedAt: new Date().toISOString(), version: '1.0', data: {} };
  let totalRecords = 0;
  for (const p of BACKUP_PATHS) {
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
  backup.totalRecords = totalRecords;
  return backup;
}

// Helper for automated / scheduled database backups (stores full restorable blob)
async function executeAutoBackup(triggeredBy = 'SCHEDULED_SYSTEM') {
  if (!dbReady) return null;
  const paths = BACKUP_PATHS;
  const backup = await buildBackupData();
  const totalRecords = backup.totalRecords;

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

// GET /api/admin/backup/download?token=... — stream a ZIP with one JSON file per collection
router.get('/backup/download', requireSuperAdmin, async (req, res) => {
  const token = String(req.query.token || '');
  const entry = backupTokenMemory.get(token);

  if (!entry) return res.status(403).json({ success: false, message: 'Missing or invalid download token. Please verify an OTP first.' });
  if (entry.used) { backupTokenMemory.delete(token); return res.status(403).json({ success: false, message: 'This download link was already used. Please verify an OTP again.' }); }
  if (entry.uid !== req.session.user.uid) return res.status(403).json({ success: false, message: 'This download link does not belong to the current session.' });
  if (Date.now() > entry.expiresAt) { backupTokenMemory.delete(token); return res.status(403).json({ success: false, message: 'The download link has expired. Please verify an OTP again.' }); }

  try {
    if (!dbReady) return res.status(400).json({ success: false, message: 'Database not connected' });

    const backup = await buildBackupData();

    // Record manual backup in history (stores restorable blob as well)
    executeAutoBackup(`MANUAL (${req.session.user.name})`).catch(() => {});
    writeAudit(req, 'BACKUP', `Manual database backup downloaded as ZIP (${backup.totalRecords} records)`, null);

    const zipName = `oba-backup-${new Date().toISOString().split('T')[0]}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${zipName}`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e) => {
      console.error('ZIP error:', e);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);

    // One standalone, pretty-printed JSON file per collection
    const counts = {};
    for (const [collection, docs] of Object.entries(backup.data)) {
      counts[collection] = Object.keys(docs || {}).length;
      archive.append(JSON.stringify(docs, null, 2), { name: `data/${collection}.json` });
    }

    // Manifest with counts and metadata
    const manifest = {
      system: 'OBA — Office of Business Affairs POS',
      backupVersion: backup.version,
      exportedAt: backup.exportedAt,
      exportedBy: req.session.user.name || req.session.user.email || 'admin',
      totalRecords: backup.totalRecords,
      collections: counts,
      contents: 'Each file under /data is a standalone JSON file for one Firestore collection. "settings.json" contains the tax rates document.',
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    const readme = [
      'OBA SYSTEM DATABASE BACKUP',
      '==========================',
      '',
      `Exported at  : ${backup.exportedAt}`,
      `Exported by  : ${req.session.user.name || 'admin'}`,
      `Total records: ${backup.totalRecords}`,
      '',
      'Contents',
      '--------',
      'manifest.json          — metadata about this backup (counts, date, version)',
      'data/<collection>.json — one standalone JSON file per database collection',
      '',
      'Collections included:',
      ...Object.entries(counts).map(([c, n]) => `  - data/${c}.json (${n} records)`),
      '',
      'How to restore',
      '--------------',
      'Use the one-click restore in Admin > Settings > Backup & Recovery (restores',
      'from the latest stored snapshot), or import individual data/<collection>.json',
      'files via the restore endpoint.',
      '',
      'Keep this archive in a secure location — it contains user and business data.',
    ].join('\n');
    archive.append(readme, { name: 'README.txt' });

    entry.used = true; // one-time token
    await archive.finalize();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/backups/history — list backup history log
router.get('/backups/history', requireSuperAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.json({ success: true, data: [] });
    const history = await FDB.getAll('backupsHistory', 'timestamp');
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, data: history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// OTP-GATED BACKUP DOWNLOAD
// The admin must request a one-time code (sent to their email via
// Gmail SMTP) and verify it before a backup ZIP can be downloaded.
// ═══════════════════════════════════════════════════════════════════

// In-memory stores (per server instance). OTPs are ALSO persisted in
// Firestore (`backupOtps`) so they survive server restarts when Firebase
// is configured; the in-memory map is the dev/no-Firebase fallback.
const backupOtpMemory = new Map();   // uid -> { otp, expiresAt, attempts }
const backupTokenMemory = new Map(); // token -> { uid, expiresAt, used }

const OTP_TTL_MS = 10 * 60 * 1000;   // OTP valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = 10 * 60 * 1000; // download token valid for 10 minutes

function maskEmail(email) {
  if (!email || !email.includes('@')) return 'your registered email';
  const [name, domain] = email.split('@');
  const shown = name.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(name.length - 2, 2))}@${domain}`;
}

// POST /api/admin/backup/otp/send — email a 6-digit verification code
router.post('/backup/otp/send', requireSuperAdmin, async (req, res) => {
  const uid = req.session.user.uid;
  const email = (req.session.user.email || '').trim().toLowerCase();
  if (!email) return res.json({ success: false, message: 'No email is associated with your account. Contact your administrator.' });

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + OTP_TTL_MS;

    // Persist (best-effort) + in-memory fallback
    if (dbReady) {
      await FDB.setDoc('backupOtps', uid, { otp, expiresAt, email, attempts: 0 }).catch(() => {});
    }
    backupOtpMemory.set(uid, { otp, expiresAt, email, attempts: 0 });

    // Demo / no-mail-transport mode: log the code so local testing still works
    if (!dbReady || !isConfigured()) {
      console.log(`[BACKUP OTP] ${email} -> ${otp} (dev mode: no mail transport configured)`);
    } else {
      const mailOptions = {
        to: email,
        toName: req.session.user.name || 'Admin',
        subject: 'OBA System — Database Backup Verification Code',
        text: `Your verification code for downloading a database backup is: ${otp}\nIt is valid for 10 minutes.`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:30px;">
            <h2 style="color:#2d6a2e;">OBA System — Backup Verification</h2>
            <p>Hi <strong>${req.session.user.name || 'Admin'}</strong>,</p>
            <p>A database backup was requested from the OBA System. Use the verification code below to continue:</p>
            <div style="background:#f5f5f5;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
              <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#2d6a2e;">${otp}</span>
            </div>
            <p style="color:#666;">This code is valid for <strong>10 minutes</strong> and can be used once.</p>
            <p style="color:#999;font-size:12px;">If you did not request a backup, please ignore this email and consider changing your password.</p>
          </div>
        `
      };
      await sendMail(mailOptions);
    }

    writeAudit(req, 'BACKUP_OTP_SENT', 'backup', `Backup download OTP sent to ${maskEmail(email)}`, null);
    return res.json({ success: true, message: `A verification code was sent to ${maskEmail(email)}.`, maskedEmail: maskEmail(email) });
  } catch (err) {
    console.error('Backup OTP Send Error:', err);
    return res.json({ success: false, message: 'Failed to send the verification code. Please try again.' });
  }
});

// POST /api/admin/backup/otp/verify — verify the code, get a one-time download token
router.post('/backup/otp/verify', requireSuperAdmin, async (req, res) => {
  const uid = req.session.user.uid;
  const { otp } = req.body || {};
  const code = typeof otp === 'string' ? otp.trim() : '';

  if (!/^\d{6}$/.test(code)) return res.json({ success: false, message: 'Please enter the 6-digit verification code.' });

  try {
    // Prefer the persisted record; fall back to the in-memory one
    let record = null;
    if (dbReady) {
      const stored = await FDB.getById('backupOtps', uid).catch(() => null);
      if (stored && stored.otp) record = { otp: String(stored.otp), expiresAt: stored.expiresAt, attempts: stored.attempts || 0 };
    }
    const mem = backupOtpMemory.get(uid);
    if (!record && mem) record = { otp: mem.otp, expiresAt: mem.expiresAt, attempts: mem.attempts };
    if (mem) { mem.attempts = (mem.attempts || 0) + 1; }
    if (record) { record.attempts = (record.attempts || 0) + 1; }

    if (!record) return res.json({ success: false, message: 'No verification code was requested. Please request a new code.' });
    if (Date.now() > record.expiresAt) {
      backupOtpMemory.delete(uid);
      if (dbReady) FDB.deleteDoc('backupOtps', uid).catch(() => {});
      return res.json({ success: false, message: 'The code has expired. Please request a new one.' });
    }
    if ((record.attempts || 0) > OTP_MAX_ATTEMPTS) {
      backupOtpMemory.delete(uid);
      if (dbReady) FDB.deleteDoc('backupOtps', uid).catch(() => {});
      return res.json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }
    if (record.otp !== code) return res.json({ success: false, message: 'Incorrect verification code. Please try again.' });

    // Success — consume the OTP and issue a one-time download token
    backupOtpMemory.delete(uid);
    if (dbReady) FDB.deleteDoc('backupOtps', uid).catch(() => {});

    const token = crypto.randomBytes(32).toString('hex');
    backupTokenMemory.set(token, { uid, expiresAt: Date.now() + TOKEN_TTL_MS, used: false });

    return res.json({ success: true, token, expiresInMs: TOKEN_TTL_MS, message: 'Verified. Your download is starting…' });
  } catch (err) {
    console.error('Backup OTP Verify Error:', err);
    return res.json({ success: false, message: 'An internal error occurred while verifying the code.' });
  }
});

// GET /api/admin/backups/:backupId/download — download a stored backup blob
router.get('/backups/:backupId/download', requireSuperAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(400).json({ success: false, message: 'Database not connected' });
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
    if (!dbReady) return res.status(400).json({ success: false, message: 'Database not connected' });
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
    await notifyBackupEvent(req, true, `System data was successfully restored from snapshot ${req.params.backupId} by ${req.session.user.name}. All collections were overwritten with the snapshot data.`);
    res.json({ success: true, message: 'System restored successfully from stored backup.' });
  } catch (err) {
    console.error(err);
    await notifyBackupEvent(req, false, `Snapshot restore (${req.params.backupId}) by ${req.session.user ? req.session.user.name : 'unknown user'} failed: ${err.message || 'internal error'}. Current data was NOT fully restored — please retry or contact support.`);
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
    if (!dbReady) return res.status(400).json({ success: false, message: 'Database not connected' });

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

    await notifyBackupEvent(req, true, `System data was successfully restored from a backup file (exported ${backup.exportedAt || 'unknown date'}) by ${req.session.user.name}. All collections were overwritten with the backup data.`);

    res.json({ success: true, message: 'System restored successfully from backup' });
  } catch (err) {
    console.error(err);
    await notifyBackupEvent(req, false, `Backup file restore by ${req.session.user ? req.session.user.name : 'unknown user'} failed: ${err.message || 'internal error'}. The uploaded backup was NOT fully applied — please verify the file and retry.`);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/admin/backup/info — info about last backup
router.get('/backup/info', requireSuperAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.json({ success: true, data: { lastBackup: 'Never', size: 0 } });

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
    if (!dbReady) return res.json({ success: true, data: defaultTaxes });
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
    if (!dbReady) {
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
