const { auth, db } = require('../config/firebase');

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
  // Backward compat: 'admin' treated as 'super_admin'
  if (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin') {
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. Super Admin only.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  // Backward compat: 'admin' treated as 'super_admin'
  if (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin' && req.session.user.role !== 'manager') {
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. Manager or higher role required.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireEmployee(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  // Backward compat: 'admin' treated as 'super_admin'
  const allowed = ['super_admin', 'admin', 'manager', 'employee'];
  if (!allowed.includes(req.session.user.role)) {
    return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. Employee or higher role required.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
  }
  next();
}

function requireViewer(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireBusinessAccess(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const user = req.session.user;
  if (user.role === 'super_admin' || user.role === 'admin') return next();
  const access = user.businessAccess || [];
  if (access.includes('all')) return next();
  const biz = req.query.biz || req.body.businessCategory;
  if (!biz) {
    const firstBiz = access.length > 0 ? access[0] : 'RENTAL';
    return res.redirect(req.path + '?biz=' + firstBiz);
  }
  if (access.includes(biz)) return next();
  return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff"><h1 style="color:#F5C518">403</h1><p>Access denied. You don't have permission for this business category.</p><a href="/" style="color:#6B8C6B">Go Home</a></body></html>`);
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

module.exports = { requireAuth, requireSuperAdmin, requireManager, requireEmployee, requireViewer, requireBusinessAccess, attachUser, noCache };
