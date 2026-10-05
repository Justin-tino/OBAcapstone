const { auth } = require('../config/firebase');

// ─── Shared Security Helpers ──────────────────────────────────────────────────
const VALID_BIZ_CATEGORIES = ['AGRI', 'NON_AGRI', 'MAIN'];

// B8-B17 business units mapped onto the 3 top-level categories.
// Categories remain the database partition keys; units are sub-entities
// stored under `businesses` and referenced via entityId/entityName.
const BUSINESS_UNITS = [
  { id: 'B8', name: 'Rice Production', categoryId: 'AGRI' },
  { id: 'B9', name: 'Vegetable Farm', categoryId: 'AGRI' },
  { id: 'B10', name: 'Poultry', categoryId: 'AGRI' },
  { id: 'B11', name: 'Fishery', categoryId: 'AGRI' },
  { id: 'B12', name: 'Printing Services', categoryId: 'NON_AGRI' },
  { id: 'B13', name: 'Tailoring', categoryId: 'NON_AGRI' },
  { id: 'B14', name: 'Repair Shop', categoryId: 'NON_AGRI' },
  { id: 'B15', name: 'Main Cafeteria', categoryId: 'MAIN' },
  { id: 'B16', name: 'Main Bookstore', categoryId: 'MAIN' },
  { id: 'B17', name: 'Main Services', categoryId: 'MAIN' },
];

const VALID_PAYMENT_METHODS = ['cash', 'gcash', 'credit', 'check', 'card', 'other'];

function validateBizCategory(biz) {
  return VALID_BIZ_CATEGORIES.includes(biz) ? biz : 'AGRI';
}

function validatePaymentMethod(pm) {
  if (typeof pm !== 'string') return 'cash';
  const v = pm.trim().toLowerCase();
  // RETURN_ADJUSTMENT is an internal system method for returns; allow it through.
  if (v === 'return_adjustment') return 'RETURN_ADJUSTMENT';
  return VALID_PAYMENT_METHODS.includes(v) ? v : 'cash';
}

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim()
    .slice(0, 500);
}

function sanitizeObject(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of keys) {
    if (typeof out[k] === 'string') out[k] = sanitizeString(out[k]);
  }
  return out;
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim().slice(0, 254));
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const allowed = ['super_admin', 'admin', 'system_administrator'];
  if (!allowed.includes(req.session.user.role)) {
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. System Administrator only.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const allowed = ['super_admin', 'admin', 'system_administrator', 'manager', 'accounting_officer'];
  if (!allowed.includes(req.session.user.role)) {
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. Manager / Officer or higher role required.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireEmployee(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  // NOTE: `viewer` is read-only (Module 5.6 View and Print only) and must NOT
  // write. `sales_staff`/`sale_staff` ARE authorized sales personnel
  // (Module 1.1 + Module 2.2) so they can record sales via POS.
  const allowed = ['super_admin', 'admin', 'system_administrator', 'manager', 'accounting_officer', 'employee', 'sales_staff', 'sale_staff', 'budgeting_officer', 'budget_officer'];
  if (!allowed.includes(req.session.user.role)) {
    const wantsJson = (req.headers.accept || '').includes('application/json') || req.path.startsWith('/api/');
    if (wantsJson) return res.status(403).json({ success: false, message: 'Access denied. Write permission required.' });
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. Authorized role required.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireViewer(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function accessCoversCategory(access, biz) {
  if (!Array.isArray(access)) return false;
  if (access.includes('all') || access.includes(biz)) return true;
  // Entity ids are CATEGORY-slug-xxx — same-category entities grant category access
  return access.some(a => {
    if (!a || a === 'all') return false;
    if (a === biz) return true;
    const s = String(a);
    if (biz === 'NON_AGRI') return s.startsWith('NON_AGRI');
    if (biz === 'AGRI') return s.startsWith('AGRI-') || s === 'AGRI';
    if (biz === 'MAIN') return s.startsWith('MAIN-') || s === 'MAIN';
    return false;
  });
}
function requireBusinessAccess(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const user = req.session.user;
  if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'system_administrator') return next();
  const access = user.businessAccess || [];
  if (access.includes('all')) return next();
  const biz = req.query.biz || req.body.businessCategory;
  const entity = req.query.entity || req.body.entityId;
  // If a specific workspace is requested, allow when that entity id is in access
  // or when access holds a legacy category entry for the parent category.
  if (entity && access.includes(entity)) return next();
  if (!biz) {
    const firstRaw = access.length > 0 ? access[0] : 'AGRI';
    const firstCat = firstRaw === 'all' ? 'AGRI'
      : firstRaw.startsWith('NON_AGRI') ? 'NON_AGRI'
      : firstRaw.startsWith('AGRI') ? 'AGRI'
      : firstRaw.startsWith('MAIN') ? 'MAIN' : firstRaw;
    const eq = access[0] && access[0] !== firstCat && access[0] !== 'all' ? '&entity=' + encodeURIComponent(access[0]) : '';
    return res.redirect(req.path + '?biz=' + firstCat + eq);
  }
  if (accessCoversCategory(access, biz)) {
    // If a specific workspace (?entity=) is requested, it must be in access
    // unless access holds a legacy category entry for the parent category.
    if (entity && !access.includes(entity) && !access.includes(biz) && !access.includes('all')) {
      const wantsJson = (req.headers.accept || '').includes('application/json') || req.path.startsWith('/api/');
      if (wantsJson) return res.status(403).json({ success: false, message: 'This account is not under this category.' });
      return res.redirect('/business-select?error=' + encodeURIComponent('This account is not under this category.'));
    }
    return next();
  }
  const wantsJson = (req.headers.accept || '').includes('application/json') || req.path.startsWith('/api/');
  if (wantsJson) return res.status(403).json({ success: false, message: 'This account is not under this category.' });
  return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>This account is not under this category.</p><a href="/business-select" style="color:#6B8C6B">Back to My Businesses</a></body></html>`);
}

function attachUser(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.user = req.session.user;
  }
  next();
}

function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

module.exports = { requireAuth, requireSuperAdmin, requireManager, requireEmployee, requireViewer, requireBusinessAccess, accessCoversCategory, attachUser, noCache, validateBizCategory, sanitizeString, sanitizeObject, isValidEmail, validatePaymentMethod, VALID_BIZ_CATEGORIES, VALID_PAYMENT_METHODS, BUSINESS_UNITS };
