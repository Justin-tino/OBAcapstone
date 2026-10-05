4.2 Key Performance Indicator (KPI) Dashboard 
• A visual, customizable dashboard providing a high-level 
overview of: total income, total expenses, net profit/loss, 
inventory value, and sales performance by product category. 
• Interactive charts (bar, line, pie) powered by JavaScript 
charting libraries for intuitive data visualization. 
• Data is sourced directly from Firestore and updated in real 
time. // TEMP test harness for /api/reports/generate (delete after use)
process.env.SUPPRESS_FIREBASE_WARNINGS = '1';
const express = require('express');
const app = express();

function fakeUser(role, access, selectedCategory) {
  return (req, res, next) => {
    req.session = { user: { uid: 'test', role, name: 'Tester', email: 't@t.ph', businessAccess: access, selectedCategory } };
    next();
  };
}

const reports = require('./routes/reports');
const types = ['dailysales', 'weeklyrevenue', 'monthlystatement', 'transactionhistory', 'expensereport', 'profitloss'];

async function main() {
  // ── 1. Admin (unrestricted) — all 6 types ──
  const admin = express();
  admin.use(fakeUser('super_admin', ['all']));
  admin.use('/api/reports', reports);
  const adminServer = admin.listen(3199);
  for (const t of types) {
    const r = await fetch(`http://localhost:3199/api/reports/generate?type=${t}&categories=AGRI,MAIN&businesses=all&period=week`);
    const j = await r.json();
    console.log(`[admin] ${t}: HTTP ${r.status} success=${j.success}` +
      (j.data ? ` kpis=${j.data.kpis.length} bizBreakdown=${(j.data.businessBreakdown || []).length} title="${j.data.reportTitle}" trend=${JSON.stringify(j.data.trends.revenue.formatted)}` : ` msg=${j.message}`));
  }
  // custom range
  {
    const r = await fetch('http://localhost:3199/api/reports/generate?type=profitloss&categories=all&businesses=all&startDate=2026-01-01&endDate=2026-01-31');
    const j = await r.json();
    console.log(`[admin] custom-range profitloss: HTTP ${r.status} success=${j.success} period="${j.data ? j.data.period.label : j.message}"`);
  }
  // unknown type
  {
    const r = await fetch('http://localhost:3199/api/reports/generate?type=bogus');
    const j = await r.json();
    console.log(`[admin] bogus type: HTTP ${r.status} success=${j.success} msg=${j.message}`);
  }
  adminServer.close();

  // ── 2. Sales staff (restricted) — must be clamped to their category ──
  const staff = express();
  staff.use(fakeUser('sales_staff', ['AGRI'], 'AGRI'));
  staff.use('/api/reports', reports);
  const staffServer = staff.listen(3198);
  {
    // requests NON_AGRI (out of scope) → 403
    const r = await fetch('http://localhost:3198/api/reports/generate?type=dailysales&categories=NON_AGRI');
    const j = await r.json().catch(() => ({}));
    console.log(`[staff] out-of-scope category: HTTP ${r.status} success=${j.success} allowed=${JSON.stringify(j.allowedCategories)}`);
    // requests own category → 200, scope clamped
    const r2 = await fetch('http://localhost:3198/api/reports/generate?type=expensereport&categories=AGRI&period=month');
    const j2 = await r2.json();
    console.log(`[staff] own category: HTTP ${r2.status} success=${j2.success} scope=${JSON.stringify(j2.data ? j2.data.scope : j2.message)}`);
  }
  staffServer.close();

  // ── 3. Accountant (manager) — restricted to assigned businesses ──
  const acct = express();
  acct.use(fakeUser('accounting_officer', ['AGRI']));
  acct.use('/api/reports', reports);
  const acctServer = acct.listen(3197);
  {
    const r = await fetch('http://localhost:3197/api/reports/generate?type=weeklyrevenue&categories=all&businesses=all&period=week');
    const j = await r.json();
    console.log(`[acct] weeklyrevenue: HTTP ${r.status} success=${j.success} scope=${JSON.stringify(j.data ? j.data.scope : j.message)}`);
  }
  acctServer.close();

  console.log('ALL TESTS DONE');
  process.exit(0);
}

main().catch(e => { console.error('TEST FAIL:', e); process.exit(1); });
