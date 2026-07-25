require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

const { attachUser, noCache } = require('./middleware/auth.middleware');

// Route imports
const authRoutes = require('./routes/auth');
const salesRoutes = require('./routes/sales');
const inventoryRoutes = require('./routes/inventory');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const expensesRoutes = require('./routes/expenses');

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
      connectSrc: ["'self'", "http://localhost:3000", "https://cdn.jsdelivr.net", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com", "wss://*.firebaseio.com", "https://*.firebaseio.com"],
    },
  },
}));

// ─── Body Parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'oba-psau-2025-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ─── Static Files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Attach user to all responses ──────────────────────────────────────────────
app.use(attachUser);

// ─── Prevent browser caching on all protected pages ───────────────────────────
app.use(['/admin', '/manager', '/employee', '/viewer', '/business-select'], noCache);

// ─── Public Page Routes ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/public/index.html')));
app.get('/features', (req, res) => res.sendFile(path.join(__dirname, 'views/public/features.html')));


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
app.get('/manager/business', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/business.html')));
app.get('/manager/dashboard', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/dashboard.html')));
app.get('/manager/inventory', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/inventory.html')));
app.get('/manager/sales', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/sales.html')));
app.get('/manager/reports', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/reports.html')));
app.get('/manager/employees', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/employees.html')));
app.get('/manager/notifications', requireManager, (req, res) => res.sendFile(path.join(__dirname, 'views/manager/notifications.html')));
app.get('/admin/users', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/users.html')));
app.get('/admin/settings', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/settings.html')));
app.get('/admin/notifications', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/notifications.html')));
app.get('/admin/sales', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/sales.html')));
app.get('/admin/reports', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/reports.html')));

// ─── Employee Dashboard Routes (category-specific) ────────────────────────────

app.get('/employee/dashboard', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/dashboard.html')));
app.get('/employee/sales', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/sales.html')));
app.get('/employee/inventory', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/inventory.html')));
app.get('/employee/reports', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/reports.html')));
app.get('/employee/expenses', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/expenses.html')));
app.get('/employee/pos', requireEmployee, requireBusinessAccess, (req, res) => res.sendFile(path.join(__dirname, 'views/employee/pos.html')));

// ─── Viewer Routes ─────────────────────────────────────────────────────────────
app.get('/viewer/dashboard', requireViewer, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/dashboard.html')));

// ─── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/sales', salesRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/expenses', expensesRoutes);

// ─── Firebase Config Endpoint (for frontend) ───────────────────────────────────
app.get('/api/firebase-config', (req, res) => {
  const { firebaseClientConfig } = require('./config/firebase');
  res.json(firebaseClientConfig);
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
});

module.exports = app;
