/**
 * app.js — Global JS utilities for OBA System
 * Toast notifications, API helpers, modals, sidebar, auth
 */

// ── Toast Notifications ────────────────────────────────────────────
const Toast = (() => {
  let container;
  function getContainer() {
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function show(message, type = 'info', duration = 4000) {
    const icons = {
      success: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      error: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-msg">${message}</span>
      <button class="toast-close" onclick="this.parentElement.remove()"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    `;
    getContainer().appendChild(el);
    setTimeout(() => {
      el.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    }, duration);
    return el;
  }

  return {
    success: (msg, d) => show(msg, 'success', d),
    error: (msg, d) => show(msg, 'error', d),
    warning: (msg, d) => show(msg, 'warning', d),
    info: (msg, d) => show(msg, 'info', d),
  };
})();

// ── Formatters ─────────────────────────────────────────────────────
const fmt = {
  currency(val) {
    const n = parseFloat(val) || 0;
    return '\u20B1' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  number(val) {
    const n = parseFloat(val) || 0;
    return n.toLocaleString('en');
  },
  percent(val) {
    const n = parseFloat(val) || 0;
    return n.toFixed(1) + '%';
  },
  datetime(val) {
    if (!val) return '—';
    const d = new Date(val);
    if (isNaN(d)) return val;
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
  },
  date(val) {
    if (!val) return '—';
    const d = new Date(val);
    if (isNaN(d)) return val;
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  }
};

// ── API Helper ─────────────────────────────────────────────────────
const API = {
  async get(url, params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(query ? `${url}?${query}` : url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async post(url, data = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.substring(0,100)}`);
    }
    return res.json();
  },
  async put(url, data = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.substring(0,100)}`);
    }
    return res.json();
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};

// ── Modal Helpers ──────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}
// Close modal clicking outside
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// ── Tabs ────────────────────────────────────────────────────────────
function initTabs(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  const tabs = container.querySelectorAll('.tab');
  const contents = container.querySelectorAll('.tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });
  // activate first
  if (tabs[0]) tabs[0].click();
}

// ── Sidebar Toggle (mobile) ────────────────────────────────────────
function initSidebar() {
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.querySelector('.sidebar');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
  // Set active nav item from current path
  const path = window.location.pathname;
  document.querySelectorAll('.nav-item[data-href]').forEach(item => {
    if (path.startsWith(item.dataset.href)) item.classList.add('active');
  });
}

// ── Highlight active nav ────────────────────────────────────────────
function setActiveNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('onclick');
    if (href && href.includes(path.split('/').pop())) {
      item.classList.add('active');
    }
  });
}

// ── Format helpers ─────────────────────────────────────────────────
// (Moved to top of file)

// ── Stock Status Badge ─────────────────────────────────────────────
function stockBadge(status) {
  const map = {
    'in-stock': '<span class="badge badge-green"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg> In Stock</span>',
    'low-stock': '<span class="badge badge-yellow"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg> Low Stock</span>',
    'out-of-stock': '<span class="badge badge-danger"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg> Out of Stock</span>',
  };
  return map[status] || `<span class="badge badge-gray">${status}</span>`;
}

// ── Role Badge ────────────────────────────────────────────────────
function roleBadge(role) {
  const map = {
    super_admin: '<span class="badge badge-black">Super Admin</span>',
    admin: '<span class="badge badge-black">Super Admin</span>',
    manager: '<span class="badge" style="background:var(--info-light);color:var(--info);border:1px solid var(--info)">Manager</span>',
    employee: '<span class="badge badge-green">Employee</span>',
    viewer: '<span class="badge badge-gray">Viewer</span>',
  };
  return map[role] || `<span class="badge">${role}</span>`;
}

function formatRole(role) {
  const names = {
    super_admin: 'Super Admin',
    admin: 'Super Admin',
    manager: 'Manager',
    employee: 'Employee',
    viewer: 'Viewer',
  };
  return names[role] || role.charAt(0).toUpperCase() + role.slice(1);
}

// ── Auto-compute sales totals ──────────────────────────────────────
function computeSaleTotal(items) {
  let subtotal = 0;
  items.forEach(item => {
    subtotal += (parseFloat(item.unitPrice) || 0) * (parseInt(item.qty) || 0);
  });
  return subtotal;
}

// ── Print a section ────────────────────────────────────────────────
function printSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (!el) return;
  const orig = document.body.innerHTML;
  const now = new Date().toLocaleString('en-PH');
  document.body.innerHTML = `
    <div class="print-header">
      <div class="print-logo">OBA System — PSAU</div>
      <div class="print-subtitle">Office of Business Affairs | Pampanga State Agricultural University</div>
      <div class="print-meta">Printed: ${now}</div>
    </div>
    ${el.innerHTML}
  `;
  window.print();
  document.body.innerHTML = orig;
  window.location.reload();
}

// ── Confirm dialog ─────────────────────────────────────────────────
function confirm(message, onConfirm, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px;text-align:center">
      <p style="font-size:2rem;margin-bottom:12px"><svg width="32" height="32" fill="none" stroke="#E53E3E" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></p>
      <h3 style="margin-bottom:8px">Confirm Action</h3>
      <p style="margin-bottom:24px">${message}</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button id="confirmNo" class="btn btn-outline">Cancel</button>
        <button id="confirmYes" class="btn btn-danger">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#confirmYes').onclick = () => { overlay.remove(); onConfirm && onConfirm(); };
  overlay.querySelector('#confirmNo').onclick = () => { overlay.remove(); onCancel && onCancel(); };
}

// ── Inject Manage Employees nav for managers ─────────────────────
async function applyManagerNav() {
  try {
    const u = await getCurrentUser();
    if (u && u.role === 'manager') {
      const nav = document.querySelector('.sidebar-nav');
      if (!nav) return;
      nav.innerHTML = `
        <a class="nav-item" href="/manager/dashboard"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span> Dashboard</a>
        <a class="nav-item" href="/manager/inventory"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></span> Inventory</a>
        <a class="nav-item" href="/manager/sales"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></span> Sales</a>
        <a class="nav-item" href="/manager/reports"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></span> Reports</a>
        <a class="nav-item" href="/manager/employees"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span> Manage Employees</a>
        <a class="nav-item" href="/manager/notifications"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span> Notifications</a>
        <a class="nav-item" href="javascript:void(0)" onclick="confirm('Are you sure you want to logout?', () => window.location.href='/logout');"><span class="nav-icon"><svg width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span> Logout</a>
      `;
      // Set active class based on current page name
      const page = window.location.pathname.split('/').pop().split('?')[0];
      nav.querySelectorAll('.nav-item').forEach(item => {
        const href = item.getAttribute('href');
        if (href && href.includes(page)) item.classList.add('active');
      });
    }
  } catch(e) { /* skip */ }
}

// ── Viewer restrictions ───────────────────────────────────────────
async function applyViewerRestrictions() {
  try {
    const u = await getCurrentUser();
    if (u && u.role === 'viewer') {
      window.__isViewer = true;
      document.body.classList.add('is-viewer');
      document.querySelectorAll('.notif-bell, .notif-dropdown').forEach(el => el.remove());
      document.querySelectorAll('.nav-item[href*="/notifications"], .nav-item[href*="/users"], .nav-item[href*="/settings"]').forEach(el => el.remove());
    }
  } catch(e) { /* skip */ }
}

// ── Get current user from session ─────────────────────────────────
async function getCurrentUser() {
  try {
    const res = await API.get('/api/me');
    return res.authenticated ? res.user : null;
  } catch { return null; }
}

// ── Get bizId from URL param ───────────────────────────────────────
function getBizId() {
  const p = new URLSearchParams(window.location.search);
  return p.get('biz') || 'RENTAL';
}

// ── Business Categories ────────────────────────────────────────────
const BUSINESS_CATEGORIES = [
  { id: 'RENTAL', name: 'Rental', color: '#6B3FA0' },
  { id: 'BUSINESS', name: 'Business', color: '#2d6a2e' },
  { id: 'AGRI', name: 'Agriculture', color: '#D4A915' },
  { id: 'NON_AGRI', name: 'Non-Agriculture', color: '#1A1A1A' },
  { id: 'MAIN', name: 'Main', color: '#0D6EFD' },
];

function getCategoryColor(catId) {
  const cat = BUSINESS_CATEGORIES.find(c => c.id === catId);
  return cat ? cat.color : '#5A7A5A';
}

// ── Status Badge ──────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    'active': '<span class="badge badge-active"><span class="status-dot active"></span>Active</span>',
    'inactive': '<span class="badge badge-inactive"><span class="status-dot inactive"></span>Inactive</span>',
    'suspended': '<span class="badge badge-danger"><span class="status-dot" style="background:var(--danger)"></span>Suspended</span>',
    'pending': '<span class="badge badge-yellow">Pending</span>',
  };
  return map[status] || `<span class="badge badge-gray">${status}</span>`;
}

// ── Notifications ─────────────────────────────────────────────────
let _notifications = [];
async function loadNotifications() {
  try {
    const res = await API.get('/api/admin/notifications');
    if (res.success) {
      _notifications = res.data;
      updateNotifBell();
    }
  } catch(e) { /* silent */ }
}

function updateNotifBell() {
  const unread = _notifications.filter(n => !n.isRead).length;
  const countEl = document.getElementById('notifCount');
  if (countEl) {
    countEl.textContent = unread;
    countEl.style.display = unread > 0 ? 'flex' : 'none';
  }
}

function renderNotifDropdown() {
  const el = document.getElementById('notifDropdown');
  if (!el) return;
  const items = _notifications.slice(0, 8);
  el.innerHTML = `
    <div class="notif-dropdown-header">
      <span>Notifications</span>
      <a href="/admin/notifications" style="font-size:0.78rem;color:var(--green);font-weight:600">View All</a>
    </div>
    ${items.length === 0 ? '<div style="padding:20px;text-align:center;color:var(--gray-400)">No notifications</div>' : ''}
    ${items.map(n => `
      <div class="notif-item ${n.isRead ? '' : 'unread'}">
        <div class="notif-icon ${n.priority === 'critical' ? 'critical' : n.priority === 'warning' ? 'warning' : 'info'}">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            ${n.type === 'low_stock' ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' : ''}
            ${n.type === 'deadline' ? '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' : ''}
            ${n.type === 'submission' ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' : ''}
            ${!['low_stock','deadline','submission'].includes(n.type) ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' : ''}
          </svg>
        </div>
        <div style="flex:1">
          <div class="notif-title">${n.title}</div>
          <div class="notif-msg">${n.message}</div>
          <div class="notif-time">${timeAgo(n.createdAt)}</div>
        </div>
      </div>
    `).join('')}
  `;
}

function toggleNotifDropdown() {
  const dd = document.getElementById('notifDropdown');
  if (dd) {
    dd.classList.toggle('show');
    if (dd.classList.contains('show')) renderNotifDropdown();
  }
}

function timeAgo(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hours ago';
  return Math.floor(diff / 86400) + ' days ago';
}

// ── Export Utilities ──────────────────────────────────────────────
function exportToCSV(data, filename) {
  if (!data || !data.length) { Toast.warning('No data to export.'); return; }
  const keys = Object.keys(data[0]);
  const csv = [keys.join(','), ...data.map(row => keys.map(k => `"${row[k] || ''}"`).join(','))].join('\n');
  downloadFile(csv, filename + '.csv', 'text/csv');
  Toast.success('CSV exported successfully!');
}

function exportToPDF(title, content) {
  const printWin = window.open('', '_blank');
  printWin.document.write(`
    <html><head><title>${title}</title>
    <style>body{font-family:Inter,sans-serif;padding:40px;color:#1A1A1A}
    h1{font-size:1.5rem;margin-bottom:5px}h2{font-size:1.1rem;color:#666;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th{background:#1A1A1A;color:#fff;padding:10px 14px;text-align:left;font-size:0.8rem}
    td{padding:10px 14px;border-bottom:1px solid #eee;font-size:0.88rem}
    .header{text-align:center;border-bottom:2px solid #1A1A1A;padding-bottom:16px;margin-bottom:20px}
    .sig{display:flex;justify-content:space-between;margin-top:60px}
    .sig-item{text-align:center;width:30%}.sig-line{border-top:1px solid #000;padding-top:6px;font-size:0.8rem}
    </style></head><body>
    <div class="header">
      <h1>OBA System — PSAU</h1>
      <h2>Office of Business Affairs | Pampanga State Agricultural University</h2>
      <div style="font-size:0.85rem;color:#888">Generated: ${new Date().toLocaleString('en-PH')}</div>
    </div>
    ${content}
    <div class="sig">
      <div class="sig-item"><div class="sig-line">Prepared By</div></div>
      <div class="sig-item"><div class="sig-line">Checked By (OBA Director)</div></div>
      <div class="sig-item"><div class="sig-line">Noted By (Auditor)</div></div>
    </div>
    </body></html>
  `);
  printWin.document.close();
  printWin.focus();
  setTimeout(() => { printWin.print(); }, 500);
  Toast.success('PDF report generated!');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('notifDropdown');
  const bell = document.getElementById('notifBell');
  if (dd && bell && !bell.contains(e.target) && !dd.contains(e.target)) {
    dd.classList.remove('show');
  }
});

// ── Session check (prevents access to cached pages after logout) ──
async function checkAuth() {
  const publicPaths = ['/login', '/forgot-password', '/reset-password', '/request-access', '/', '/features'];
  const path = window.location.pathname;
  if (publicPaths.some(p => path === p || path.startsWith(p + '?'))) return;
  try {
    const res = await API.get('/api/me');
    if (!res.authenticated) {
      window.location.href = '/login';
    }
  } catch {
    window.location.href = '/login';
  }
}
window.addEventListener('pageshow', (event) => {
  if (event.persisted) checkAuth();
});

// ── Init on load ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  initSidebar();
  setActiveNav();
  applyViewerRestrictions();
  applyManagerNav();
  loadNotifications();

  // Attach Profile button action
  document.querySelectorAll('.profile-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const u = await getCurrentUser();
        if (u) {
          Toast.info(`
            <div style="text-align:left;line-height:1.6">
              <strong>Name:</strong> ${u.name}<br>
              <strong>Email:</strong> ${u.email}<br>
              <strong>Role:</strong> ${u.role.toUpperCase()}<br>
              <strong>Business Access:</strong> ${u.businessAccess.join(', ')}
            </div>
            <a href="javascript:void(0)" onclick="confirm('Are you sure you want to logout?', () => window.location.href='/logout');" style="display:block;margin-top:10px;text-align:center;background:var(--danger);color:#fff;padding:8px;border-radius:4px;text-decoration:none;font-weight:bold">Sign Out</a>
          `, 8000);
        } else {
          Toast.warning('User not logged in.');
        }
      } catch (e) {
        console.error(e);
      }
    });
  });
});

