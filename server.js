require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');

const { attachUser, noCache } = require('./middleware/auth.middleware');

// Route imports
const authRoutes = require('./routes/auth');
const salesRoutes = require('./routes/sales');
const inventoryRoutes = require('./routes/inventory');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
// TEMPORARY local tool: all-businesses inventory manager (delete to remove)
const adminInventoryRoutes = require('./routes/admin-inventory');
const expensesRoutes = require('./routes/expenses');
const employeeNotificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ─── CORS (allow Live Server on port 5500 to access API) ──────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ['http://localhost:3000', 'http://localhost:5500', 'http://localhost:5501'];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://www.gstatic.com", "https://cdn.firebase.com", "https://apis.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "http://localhost:3000", "https://cdn.jsdelivr.net", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com"],
    },
  },
}));

// ─── Body Parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Session ───────────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set in .env — generating a random secret for this run.');
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ─── Static Files ──────────────────────────────────────────────────────────────
// Never allow a stale cached copy of the shared client script — otherwise
// old code (e.g. without the double-submit guard) keeps running after updates.
app.use('/js/app.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Attach user to all responses ──────────────────────────────────────────────
app.use(attachUser);

// ─── Prevent browser caching on all protected pages ───────────────────────────
app.use(['/admin', '/manager', '/employee', '/viewer', '/business-select'], noCache);

// ─── Public Page Routes ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/public/index.html')));
app.get('/features', (req, res) => res.sendFile(path.join(__dirname, 'views/public/features.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'views/public/contact.html')));
app.get('/careers', (req, res) => res.sendFile(path.join(__dirname, 'views/public/careers.html')));



// ─── Middleware Imports ────────────────────────────────────────────────────────
const { requireSuperAdmin, requireManager, requireEmployee, requireViewer, requireBusinessAccess } = require('./middleware/auth.middleware');

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.use('/', authRoutes);

// ─── Business Selection Page ─────────────────────────────────────────
app.get('/business-select', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/auth/business-select.html')));

// ─── Admin Dashboard Routes (all authenticated users can view pages) ──────────

app.get('/admin/dashboard', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/dashboard.html')));
app.get('/admin/business', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/business.html')));
app.get('/admin/inventory', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/inventory.html')));
app.get('/admin/expenses', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/expenses.html')));
app.get('/manager/expenses', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/expenses.html')));
app.get('/manager/business', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/business.html')));
app.get('/manager/dashboard', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/dashboard.html')));
app.get('/manager/inventory', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/inventory.html')));
app.get('/manager/sales', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/sales.html')));
app.get('/manager/reports', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/reports.html')));
app.get('/manager/notifications', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/notifications.html')));
// Performing Rank — placeholder section for Accounting Officer navigation
app.get('/manager/performing-rank', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/performing-rank.html')));
app.get('/admin/users', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/users.html')));
app.get('/admin/settings', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/settings.html')));
// Admin Notifications page: Manager / Accounting Officer or higher ONLY.
// Sales staff / employees have their own scoped feed at /employee/notifications.
app.get('/admin/notifications', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/notifications.html')));
app.get('/admin/sales', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/sales.html')));
app.get('/admin/reports', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/reports.html')));
// TEMPORARY LOCAL TOOL — All Businesses Inventory (admin + localhost only).
// Remove this line + views/admin/all-inventory.html + routes/admin-inventory.js
// when you no longer need the bulk product loader.
app.get('/admin/all-inventory', adminInventoryRoutes.guardPage, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/all-inventory.html')));

// ─── Employee Dashboard Routes (category-specific) ────────────────────────────

app.get('/employee/dashboard', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/dashboard.html')));
app.get('/employee/sales', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/sales.html')));
app.get('/employee/inventory', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/inventory.html')));
app.get('/employee/reports', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/reports.html')));
app.get('/employee/expenses', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/expenses.html')));
app.get('/employee/pos', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/pos.html')));
// Return History — viewed by Accounting Officers and Sales Staff (read-only)
app.get('/employee/returns', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/returns.html')));
app.get('/employee/notifications', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/notifications.html')));

// ─── Viewer Routes ─────────────────────────────────────────────────────────────
app.get('/viewer/dashboard', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/dashboard.html')));

// ─── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/sales', salesRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin-inventory', adminInventoryRoutes); // TEMPORARY local tool
app.use('/api/expenses', expensesRoutes);
app.use('/api/employee', employeeNotificationRoutes);

// ─── Firebase Config Endpoint (for frontend) ───────────────────────────────────
app.get('/api/firebase-config', (req, res) => {
  const { firebaseClientConfig } = require('./config/firebase');
  res.json(firebaseClientConfig);
});

// ─── Public Contact / Request Demo (stored for admin follow-up) ──────────────
const contactLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/api/contact', contactLimiter, express.json(), async (req, res) => {
  try {
    const { sanitizeString, isValidEmail } = require('./middleware/auth.middleware');
    const name = sanitizeString(req.body.name || '');
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const subject = sanitizeString(req.body.subject || 'general');
    const message = sanitizeString(req.body.message || '');
    if (!name || !email || !message) return res.status(400).json({ success: false, message: 'Name, email and message are required.' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    const allowedSubjects = ['general', 'demo', 'access', 'support', 'feedback'];
    const cleanSubject = allowedSubjects.includes(subject.toLowerCase()) ? subject.toLowerCase() : 'general';
    const { firestore } = require('./config/firebase');
    if (firestore) {
      const FDB = require('./config/db');
      await FDB.addDoc('contactRequests', {
        name, email, subject: cleanSubject, message,
        status: 'new', createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
    res.json({ success: true, message: 'Request received. The OBA team will follow up by email.' });
  } catch (err) {
    console.error('Contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit request.' });
  }
});

// ─── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`
    <html><head><title>404 - Not Found</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;background:#1A1A1A;color:#fff">
      <h1 style="color:#F5C518">404</h1>
      <p>Page not found.</p>
      <a href="/" style="color:#6B8C6B">Go Home</a>
    </body></html>
  `);
});

// ─── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);

  // Scheduled Automated Database Backup (Section 5.3)
  if (adminRoutes && adminRoutes.executeAutoBackup) {
    setTimeout(() => {
      adminRoutes.executeAutoBackup('SCHEDULED_AUTOMATED_STARTUP').catch(() => {});
    }, 10000);
    setInterval(() => {
      adminRoutes.executeAutoBackup('SCHEDULED_AUTOMATED_DAILY').catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }
});

module.exports = app;
