/**
 * routes/reports.js
 * Financial report generation routes per business
 * Dynamic Report Generator (Daily Sales, Weekly Revenue, Monthly Financial Statements,
 * Transaction History, Expense Reports, Profit & Loss Statements, and ROI Calculations)
 */
const express = require('express');
const router = express.Router();
const { firestore } = require('../config/firebase');
const FDB = require('../config/db');
const { requireViewer } = require('../middleware/auth.middleware');

const BIZ_CATEGORIES = ['AGRI', 'NON_AGRI', 'MAIN'];
const DEFAULT_TAX_RATES = { AGRI: 0, NON_AGRI: 12, MAIN: 12 };

async function writeReportAudit(req, reportName, bizId) {
  try {
    if (!firestore || !req.session || !req.session.user) return;
    await FDB.addDoc('auditLogs', {
      action: 'GENERATE_REPORT',
      module: 'reports',
      details: `${reportName} generated for ${bizId}`,
      logType: 'transaction',
      previousValue: null, newValue: null,
      businessId: bizId || null,
      userId: req.session.user.uid, userName: req.session.user.name,
      userEmail: req.session.user.email || '',
      timestamp: new Date().toISOString(), isSuspicious: false,
    }).catch(() => {});
  } catch (_) {}
}

async function getBizTaxRate(bizId) {
  if (!firestore) return DEFAULT_TAX_RATES[bizId] || 0;
  try {
    const doc = await FDB.getById('settings', 'taxes');
    const rates = doc || DEFAULT_TAX_RATES;
    return rates[bizId] || DEFAULT_TAX_RATES[bizId] || 0;
  } catch (e) {
    return DEFAULT_TAX_RATES[bizId] || 0;
  }
}

function calcTaxes(sales, gross, taxRate) {
  const stored = sales.reduce((a, s) => a + (parseFloat(s.taxAmount) || 0), 0);
  if (stored > 0) return stored;
  if (gross === 0 || taxRate === 0) return 0;
  return gross * (taxRate / (100 + taxRate));
}

function getPeriodRanges(query) {
  const { period = 'month', startDate, endDate } = query;
  let curStart, curEnd, prevStart, prevEnd;
  const now = new Date();

  if (startDate && endDate) {
    curStart = new Date(startDate);
    curStart.setHours(0, 0, 0, 0);
    curEnd = new Date(endDate);
    curEnd.setHours(23, 59, 59, 999);
    const duration = curEnd.getTime() - curStart.getTime() + 1;
    prevEnd = new Date(curStart.getTime() - 1);
    prevStart = new Date(prevEnd.getTime() - duration + 1);
  } else if (period === 'day' || period === 'daily') {
    curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    curEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    prevStart = new Date(curStart);
    prevStart.setDate(prevStart.getDate() - 1);
    prevEnd = new Date(curEnd);
    prevEnd.setDate(prevEnd.getDate() - 1);
  } else if (period === 'week' || period === 'weekly') {
    curEnd = new Date(now);
    curStart = new Date(now);
    curStart.setDate(now.getDate() - 7);
    curStart.setHours(0, 0, 0, 0);
    prevEnd = new Date(curStart);
    prevEnd.setMilliseconds(-1);
    prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 7);
  } else if (period === 'year' || period === 'annual' || period === 'annually') {
    curStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    curEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    prevStart = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0);
    prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
  } else {
    // Default: month / monthly
    curStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    curEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  }

  return { curStart, curEnd, prevStart, prevEnd };
}

function filterListByRange(list, start, end, dateField = 'date') {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return list.filter(item => {
    const dStr = item[dateField] || item.createdAt || item.timestamp;
    if (!dStr) return false;
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return false;
    const ms = d.getTime();
    return ms >= startMs && ms <= endMs;
  });
}

function calculateTrend(currentVal, prevVal) {
  let percent = 0;
  if (prevVal > 0) {
    percent = ((currentVal - prevVal) / prevVal) * 100;
  } else if (currentVal > 0) {
    percent = 100;
  } else {
    percent = 0;
  }
  const direction = percent >= 0 ? 'up' : 'down';
  const rounded = Math.round(percent * 10) / 10;
  return {
    current: currentVal,
    previous: prevVal,
    percent: rounded,
    direction,
    formatted: (rounded >= 0 ? '+' : '') + rounded + '%'
  };
}

router.param('bizId', (req, res, next, val) => {
  if (req.session && req.session.user) {
    const u = req.session.user;
    const isRestrictedRole = ['sales_staff', 'sale_staff', 'viewer', 'employee', 'budgeting_officer', 'budget_officer'].includes(u.role);
    const userAccess = u.businessAccess || u.businesses || [];
    const hasRestrictedAccess = isRestrictedRole || (userAccess.length > 0 && !userAccess.includes('all'));
    if (hasRestrictedAccess) {
      let assignedBiz = 'AGRI';
      if (u.selectedCategory && u.selectedCategory !== 'all') {
        assignedBiz = u.selectedCategory;
      } else if (Array.isArray(userAccess) && userAccess.length > 0 && userAccess[0] !== 'all') {
        assignedBiz = userAccess[0];
      }
      req.params.bizId = assignedBiz;
    }
  }
  next();
});

async function getBizData(bizId, query = {}) {
  if (!firestore) return { curSales: [], prevSales: [], curExpenses: [], prevExpenses: [], inventory: [], allSales: [], allExpenses: [] };

  const targets = (bizId === 'all' || !bizId) ? BIZ_CATEGORIES : [bizId];
  let allSales = [];
  let allExpenses = [];
  let allInventory = [];

  for (const b of targets) {
    const sList = await FDB.getWhere('sales', 'businessCategory', '==', b);
    const eList = await FDB.getWhere('expenses', 'businessCategory', '==', b);
    const iList = await FDB.getWhere('inventory', 'businessCategory', '==', b);

    sList.forEach(s => allSales.push({ bizId: b, ...s }));
    eList.forEach(e => allExpenses.push({ bizId: b, ...e }));
    iList.forEach(i => allInventory.push({ bizId: b, ...i }));
  }

  const { curStart, curEnd, prevStart, prevEnd } = getPeriodRanges(query);

  const curSales = filterListByRange(allSales, curStart, curEnd, 'date');
  const prevSales = filterListByRange(allSales, prevStart, prevEnd, 'date');

  // Expenses carry a business `date` (YYYY-MM-DD) plus a system `createdAt`.
  // Filter by business date first so manual date edits are respected.
  const curExpenses = filterListByRange(allExpenses, curStart, curEnd, 'date');
  const prevExpenses = filterListByRange(allExpenses, prevStart, prevEnd, 'date');

  return {
    curSales, prevSales,
    curExpenses, prevExpenses,
    inventory: allInventory,
    allSales, allExpenses,
    curStart, curEnd, prevStart, prevEnd
  };
}

function computeCOGS(salesList, inventoryList) {
  const invMap = {};
  (inventoryList || []).forEach(item => {
    invMap[item.id] = item;
    if (item.name) invMap[item.name.toLowerCase().trim()] = item;
  });

  return salesList.reduce((total, sale) => {
    const items = sale.items || [];
    return total + items.reduce((sum, item) => {
      const inv = invMap[item.id] || invMap[(item.name || '').toLowerCase().trim()];
      const cost = parseFloat(item.cost || item.unitCost || (inv ? inv.unitCost : 0) || 0);
      const qty = parseInt(item.quantity || item.qty || 1);
      return sum + (cost * qty);
    }, 0);
  }, 0);
}

function computeROIByProduct(salesList, inventoryList, categoryFilter = null, productFilter = null) {
  const invMap = {};
  (inventoryList || []).forEach(item => {
    invMap[item.id] = item;
    if (item.name) invMap[item.name.toLowerCase().trim()] = item;
  });

  const productStats = {};

  salesList.forEach(sale => {
    const items = sale.items || [];
    items.forEach(item => {
      const inv = invMap[item.id] || invMap[(item.name || '').toLowerCase().trim()];
      const name = item.name || (inv ? inv.name : 'Unknown Product');
      const category = item.category || (inv ? inv.category : 'General');
      const qty = parseInt(item.quantity || item.qty || 1);
      const price = parseFloat(item.price || item.unitPrice || item.totalPrice / Math.max(1, qty) || (inv ? inv.sellingPrice : 0) || 0);
      const cost = parseFloat(item.cost || item.unitCost || (inv ? inv.unitCost : 0) || 0);

      if (categoryFilter && categoryFilter !== 'all' && category.toLowerCase() !== categoryFilter.toLowerCase()) return;
      if (productFilter && productFilter !== 'all' && name.toLowerCase() !== productFilter.toLowerCase()) return;

      const key = name;
      if (!productStats[key]) {
        productStats[key] = {
          name,
          category,
          unitsSold: 0,
          revenue: 0,
          cost: 0,
          netProfit: 0,
          roi: 0
        };
      }

      productStats[key].unitsSold += qty;
      productStats[key].revenue += (price * qty);
      productStats[key].cost += (cost * qty);
    });
  });

  const productList = Object.values(productStats).map(p => {
    p.netProfit = p.revenue - p.cost;
    p.roi = p.cost > 0 ? ((p.netProfit / p.cost) * 100) : (p.revenue > 0 ? 100 : 0);
    return p;
  });

  const categoryStats = {};
  productList.forEach(p => {
    if (!categoryStats[p.category]) {
      categoryStats[p.category] = { category: p.category, unitsSold: 0, revenue: 0, cost: 0, netProfit: 0, roi: 0 };
    }
    categoryStats[p.category].unitsSold += p.unitsSold;
    categoryStats[p.category].revenue += p.revenue;
    categoryStats[p.category].cost += p.cost;
  });

  const categoryList = Object.values(categoryStats).map(c => {
    c.netProfit = c.revenue - c.cost;
    c.roi = c.cost > 0 ? ((c.netProfit / c.cost) * 100) : (c.revenue > 0 ? 100 : 0);
    return c;
  });

  const totalRevenue = productList.reduce((sum, p) => sum + p.revenue, 0);
  const totalCost = productList.reduce((sum, p) => sum + p.cost, 0);
  const totalProfit = totalRevenue - totalCost;
  const overallROI = totalCost > 0 ? ((totalProfit / totalCost) * 100) : (totalRevenue > 0 ? 100 : 0);

  return {
    products: productList.sort((a, b) => b.revenue - a.revenue),
    categories: categoryList.sort((a, b) => b.revenue - a.revenue),
    totals: {
      revenue: totalRevenue,
      cost: totalCost,
      netProfit: totalProfit,
      roi: overallROI
    }
  };
}

// GET /api/reports/:bizId/summary
router.get('/:bizId/summary', requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const curNetSales = curGross - curTaxes;
    const prevNetSales = prevGross - prevTaxes;

    const curOtherIncome = curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOtherIncome = prevExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curRev = curNetSales + curOtherIncome;
    const prevRev = prevNetSales + prevOtherIncome;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalExp = curCOGS + curOpExp;
    const prevTotalExp = prevCOGS + prevOpExp;

    const curProfit = curRev - curTotalExp;
    const prevProfit = prevRev - prevTotalExp;

    const curROI = curTotalExp > 0 ? ((curProfit / curTotalExp) * 100) : (curRev > 0 ? 100 : 0);
    const prevROI = prevTotalExp > 0 ? ((prevProfit / prevTotalExp) * 100) : (prevRev > 0 ? 100 : 0);
    writeReportAudit(req, 'Summary', bizId);

    const eb = { cogs: curCOGS, utilities: 0, suppliers: 0, salary: 0, other: 0 };
    curExpenses.filter(e => e.type === 'expense').forEach(e => {
      const c = (e.category || '').toLowerCase();
      if (c.includes('util')) eb.utilities += parseFloat(e.amount) || 0;
      else if (c.includes('suppl') || c.includes('inventory')) eb.suppliers += parseFloat(e.amount) || 0;
      else if (c.includes('salar') || c.includes('payroll')) eb.salary += parseFloat(e.amount) || 0;
      else eb.other += parseFloat(e.amount) || 0;
    });

    res.json({
      success: true,
      data: {
        revenue: curRev,
        expenses: curTotalExp,
        cogs: curCOGS,
        profit: curProfit,
        taxes: curTaxes,
        grossSales: curGross,
        roi: curROI,
        salesCount: curSales.length,
        period: req.query.period || 'month',
        dateRange: { start: data.curStart, end: data.curEnd },
        expenseBreakdown: eb,
        trends: {
          revenue: calculateTrend(curRev, prevRev),
          expenses: calculateTrend(curTotalExp, prevTotalExp),
          profit: calculateTrend(curProfit, prevProfit),
          roi: calculateTrend(curROI, prevROI),
          salesCount: calculateTrend(curSales.length, prevSales.length),
          taxes: calculateTrend(curTaxes, prevTaxes)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/reports/:bizId/daily-sales (and /dailysales alias)
router.get(['/:bizId/daily-sales', '/:bizId/dailysales'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  const query = { ...req.query, period: req.query.period || 'day' };
  try {
    const data = await getBizData(bizId, query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory, allSales } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);
    const curNet = curGross - curTaxes;
    const prevNet = prevGross - prevTaxes;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);
    const curProfit = curNet - curCOGS;
    const prevProfit = prevNet - prevCOGS;

    // Operating expenditures (Module 4.1: Total Expenses KPI card)
    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const curTotalExp = curCOGS + curOpExp;
    const prevTotalExp = prevCOGS + prevOpExp;

    // Average Order Value KPI
    const curAOV = curSales.length > 0 ? curGross / curSales.length : 0;
    const prevAOV = prevSales.length > 0 ? prevGross / prevSales.length : 0;

    // Payment method breakdown
    const paymentMethods = {};
    curSales.forEach(s => {
      const pm = (s.paymentMethod || 'Cash').toUpperCase();
      paymentMethods[pm] = (paymentMethods[pm] || 0) + (parseFloat(s.total) || 0);
    });

    // Staff breakdown
    const staffSales = {};
    curSales.forEach(s => {
      const staff = s.cashierName || s.employeeName || s.createdBy || 'Store Staff';
      staffSales[staff] = (staffSales[staff] || 0) + (parseFloat(s.total) || 0);
    });

    // ── Module 4.1 mockup data: 7-day comparative trend series (current vs previous period) ──
    const periodDays = Math.max(1, Math.ceil((data.curEnd.getTime() - data.curStart.getTime()) / 86400000));
    const sumSalesBetween = (list, start, end) => list.reduce((acc, s) => {
      const d = new Date(s.date || s.createdAt);
      if (isNaN(d.getTime())) return acc;
      const ms = d.getTime();
      return (ms >= start.getTime() && ms <= end.getTime()) ? acc + (parseFloat(s.total) || 0) : acc;
    }, 0);
    const dailySeries = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(data.curEnd.getFullYear(), data.curEnd.getMonth(), data.curEnd.getDate() - i, 0, 0, 0, 0);
      const dayEnd = new Date(data.curEnd.getFullYear(), data.curEnd.getMonth(), data.curEnd.getDate() - i, 23, 59, 59, 999);
      const prevStart = new Date(dayStart); prevStart.setDate(prevStart.getDate() - periodDays);
      const prevEnd = new Date(dayEnd); prevEnd.setDate(prevEnd.getDate() - periodDays);
      dailySeries.push({
        label: dayStart.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
        current: sumSalesBetween(allSales, dayStart, dayEnd),
        previous: sumSalesBetween(allSales, prevStart, prevEnd)
      });
    }

    // ── Sales by Category breakdown (item-level, with previous-period amounts for trend arrows) ──
    const invCatMap = {};
    (inventory || []).forEach(item => {
      if (item.id) invCatMap[item.id] = item.category;
      if (item.name) invCatMap[item.name.toLowerCase().trim()] = item.category;
    });
    const resolveCategory = (item) => {
      if (item.category) return item.category;
      const invCat = invCatMap[item.id] || invCatMap[(item.name || '').toLowerCase().trim()];
      return invCat || 'General';
    };
    const sumItems = (salesList) => salesList.reduce((map, s) => {
      (s.items || []).forEach(item => {
        const qty = parseInt(item.quantity || item.qty || 1) || 1;
        const price = parseFloat(item.price || item.unitPrice || (parseFloat(item.totalPrice) || 0) / qty || 0);
        const cat = resolveCategory(item);
        map[cat] = (map[cat] || 0) + (price * qty);
      });
      return map;
    }, {});
    const curCatMap = sumItems(curSales);
    const prevCatMap = sumItems(prevSales);
    const categoryBreakdown = Object.keys(curCatMap).map(category => ({
      category,
      amount: curCatMap[category],
      prevAmount: prevCatMap[category] || 0
    })).sort((a, b) => b.amount - a.amount);

    res.json({
      success: true,
      data: {
        reportTitle: 'Daily Sales Report',
        date: data.curStart.toLocaleDateString('en-PH'),
        totalSalesCount: curSales.length,
        grossSales: curGross,
        taxes: curTaxes,
        netSales: curNet,
        cogs: curCOGS,
        profit: curProfit,
        totalExpenses: curTotalExp,
        averageOrderValue: curAOV,
        dailySeries,
        categoryBreakdown,
        periodUnit: periodDays === 1 ? 'day' : (periodDays === 7 ? 'week' : `${periodDays} days`),
        paymentMethods,
        staffSales,
        transactions: curSales.sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt)),
        trends: {
          revenue: calculateTrend(curNet, prevNet),
          transactions: calculateTrend(curSales.length, prevSales.length),
          profit: calculateTrend(curProfit, prevProfit),
          taxes: calculateTrend(curTaxes, prevTaxes),
          expenses: calculateTrend(curTotalExp, prevTotalExp),
          aov: calculateTrend(curAOV, prevAOV)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate daily sales report.' });
  }
});

// GET /api/reports/:bizId/weekly-revenue (and /weeklyrevenue alias)
router.get(['/:bizId/weekly-revenue', '/:bizId/weeklyrevenue'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  const query = { ...req.query, period: req.query.period || 'week' };
  try {
    const data = await getBizData(bizId, query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const curNet = curGross - curTaxes;
    const prevNet = prevGross - prevTaxes;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalExp = curCOGS + curOpExp;
    const prevTotalExp = prevCOGS + prevOpExp;

    const curProfit = curNet - curTotalExp;
    const prevProfit = prevNet - prevTotalExp;

    // Daily breakdown for current week
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dailyBreakdown = days.map(dayName => ({ day: dayName, revenue: 0, salesCount: 0 }));

    curSales.forEach(s => {
      const d = new Date(s.date || s.createdAt);
      if (!isNaN(d.getTime())) {
        const idx = d.getDay();
        dailyBreakdown[idx].revenue += (parseFloat(s.total) || 0);
        dailyBreakdown[idx].salesCount += 1;
      }
    });

    res.json({
      success: true,
      data: {
        reportTitle: 'Weekly Revenue Summary',
        periodStart: data.curStart.toLocaleDateString('en-PH'),
        periodEnd: data.curEnd.toLocaleDateString('en-PH'),
        grossRevenue: curGross,
        taxes: curTaxes,
        netRevenue: curNet,
        totalExpenses: curTotalExp,
        netProfit: curProfit,
        dailyBreakdown,
        trends: {
          revenue: calculateTrend(curNet, prevNet),
          expenses: calculateTrend(curTotalExp, prevTotalExp),
          profit: calculateTrend(curProfit, prevProfit),
          salesCount: calculateTrend(curSales.length, prevSales.length)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate weekly revenue summary.' });
  }
});

// GET /api/reports/:bizId/monthly-statement (and /monthlystatement alias)
router.get(['/:bizId/monthly-statement', '/:bizId/monthlystatement'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  const query = { ...req.query, period: req.query.period || 'month' };
  try {
    const data = await getBizData(bizId, query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const curSalesRev = curGross - curTaxes;
    const prevSalesRev = prevGross - prevTaxes;

    const curOtherIncome = curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOtherIncome = prevExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalRev = curSalesRev + curOtherIncome;
    const prevTotalRev = prevSalesRev + prevOtherIncome;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalExp = curCOGS + curOpExp;
    const prevTotalExp = prevCOGS + prevOpExp;

    const curNetIncome = curTotalRev - curTotalExp;
    const prevNetIncome = prevTotalRev - prevTotalExp;

    res.json({
      success: true,
      data: {
        reportTitle: 'Monthly Financial Statement',
        period: data.curStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
        salesRevenue: curSalesRev,
        taxes: curTaxes,
        otherIncome: curOtherIncome,
        totalRevenue: curTotalRev,
        costOfGoods: curCOGS,
        operatingExpenses: curOpExp,
        totalExpenses: curTotalExp,
        netIncome: curNetIncome,
        trends: {
          revenue: calculateTrend(curTotalRev, prevTotalRev),
          expenses: calculateTrend(curTotalExp, prevTotalExp),
          netIncome: calculateTrend(curNetIncome, prevNetIncome)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate monthly financial statement.' });
  }
});

// GET /api/reports/:bizId/transactions
router.get('/:bizId/transactions', requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales } = data;

    const curTotal = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevTotal = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const curTax = curSales.reduce((a, s) => a + (parseFloat(s.taxAmount) || 0), 0);
    const prevTax = prevSales.reduce((a, s) => a + (parseFloat(s.taxAmount) || 0), 0);

    const transactions = curSales.map(s => ({
      id: s.id,
      date: s.date || s.createdAt,
      cashier: s.cashierName || s.employeeName || s.createdBy || 'Store Staff',
      paymentMethod: s.paymentMethod || 'Cash',
      itemsCount: (s.items || []).length,
      grossTotal: parseFloat(s.total) || 0,
      taxAmount: parseFloat(s.taxAmount) || 0,
      items: s.items || []
    })).sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      data: {
        reportTitle: 'Transaction History Report',
        totalVolume: curTotal,
        totalTax: curTax,
        transactionCount: curSales.length,
        transactions,
        trends: {
          volume: calculateTrend(curTotal, prevTotal),
          count: calculateTrend(curSales.length, prevSales.length),
          tax: calculateTrend(curTax, prevTax)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate transaction history report.' });
  }
});

// GET /api/reports/:bizId/expense-report (and /expensereport alias)
router.get(['/:bizId/expense-report', '/:bizId/expensereport'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curExpenses, prevExpenses, curSales, prevSales, inventory } = data;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const categories = { 'Cost of Goods Sold (Supplies)': curCOGS, Utilities: 0, 'Suppliers & Stock': 0, 'Salaries & Payroll': 0, Maintenance: 0, Marketing: 0, Other: 0 };
    const prevCategories = { COGS: prevCOGS, Utilities: 0, Suppliers: 0, Salaries: 0, Maintenance: 0, Marketing: 0, Other: 0 };

    curExpenses.filter(e => e.type === 'expense').forEach(e => {
      const amt = parseFloat(e.amount) || 0;
      const c = (e.category || '').toLowerCase();
      if (c.includes('util')) categories.Utilities += amt;
      else if (c.includes('suppl') || c.includes('stock')) categories['Suppliers & Stock'] += amt;
      else if (c.includes('salar') || c.includes('payroll')) categories['Salaries & Payroll'] += amt;
      else if (c.includes('maint')) categories.Maintenance += amt;
      else if (c.includes('market') || c.includes('campa')) categories.Marketing += amt;
      else categories.Other += amt;
    });

    // Remove categories with 0.00 balance
    Object.keys(categories).forEach(cat => {
      if (categories[cat] === 0) {
        delete categories[cat];
      }
    });

    prevExpenses.filter(e => e.type === 'expense').forEach(e => {
      const amt = parseFloat(e.amount) || 0;
      const c = (e.category || '').toLowerCase();
      if (c.includes('util')) prevCategories.Utilities += amt;
      else if (c.includes('suppl') || c.includes('stock')) prevCategories.Suppliers += amt;
      else if (c.includes('salar') || c.includes('payroll')) prevCategories.Salaries += amt;
      else if (c.includes('maint')) prevCategories.Maintenance += amt;
      else if (c.includes('market') || c.includes('campa')) prevCategories.Marketing += amt;
      else prevCategories.Other += amt;
    });

    const curTotal = Object.values(categories).reduce((a, b) => a + b, 0);
    const prevTotal = Object.values(prevCategories).reduce((a, b) => a + b, 0);

    const itemList = curExpenses.filter(e => e.type === 'expense').map(e => ({
      id: e.id,
      title: e.title || e.description || 'Operating Expense',
      category: e.category || 'General',
      amount: parseFloat(e.amount) || 0,
      date: e.createdAt || e.date
    })).sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      data: {
        reportTitle: 'Expense Report',
        totalExpenses: curTotal,
        cogs: curCOGS,
        categoryBreakdown: categories,
        expensesList: itemList,
        trends: {
          expenses: calculateTrend(curTotal, prevTotal)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate expense report.' });
  }
});

// GET /api/reports/:bizId/profit-loss (and /profitloss alias)
router.get(['/:bizId/profit-loss', '/:bizId/profitloss'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const curNetSales = curGross - curTaxes;
    const prevNetSales = prevGross - prevTaxes;

    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const curGrossProfit = curNetSales - curCOGS;
    const prevGrossProfit = prevNetSales - prevCOGS;

    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curNetProfit = curGrossProfit - curOpExp;
    const prevNetProfit = prevGrossProfit - prevOpExp;

    const grossMargin = curNetSales > 0 ? ((curGrossProfit / curNetSales) * 100) : 0;
    const netMargin = curNetSales > 0 ? ((curNetProfit / curNetSales) * 100) : 0;

    res.json({
      success: true,
      data: {
        reportTitle: 'Profit & Loss Statement',
        grossSales: curGross,
        taxes: curTaxes,
        netSales: curNetSales,
        costOfGoodsSold: curCOGS,
        grossProfit: curGrossProfit,
        operatingExpenses: curOpExp,
        netProfit: curNetProfit,
        grossMarginPercent: grossMargin.toFixed(1) + '%',
        netMarginPercent: netMargin.toFixed(1) + '%',
        trends: {
          grossSales: calculateTrend(curGross, prevGross),
          netSales: calculateTrend(curNetSales, prevNetSales),
          cogs: calculateTrend(curCOGS, prevCOGS),
          grossProfit: calculateTrend(curGrossProfit, prevGrossProfit),
          operatingExpenses: calculateTrend(curOpExp, prevOpExp),
          netProfit: calculateTrend(curNetProfit, prevNetProfit)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate profit and loss statement.' });
  }
});

// GET /api/reports/:bizId/overall — Comprehensive Overall Report (totals from all categories)
router.get('/:bizId/overall', requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    // ── Revenue ──
    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const curNetSales = curGross - curTaxes;
    const prevNetSales = prevGross - prevTaxes;

    // ── Other Income ──
    const curOtherIncome = curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOtherIncome = prevExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalRevenue = curNetSales + curOtherIncome;
    const prevTotalRevenue = prevNetSales + prevOtherIncome;

    // ── Expenses ──
    const curCOGS = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const curOpExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const curTotalExpenses = curCOGS + curOpExp;
    const prevTotalExpenses = prevCOGS + prevOpExp;

    // ── Profit ──
    const curGrossProfit = curNetSales - curCOGS;
    const prevGrossProfit = prevNetSales - prevCOGS;

    const curNetProfit = curGrossProfit - curOpExp;
    const prevNetProfit = prevGrossProfit - prevOpExp;

    const grossMargin = curNetSales > 0 ? ((curGrossProfit / curNetSales) * 100) : 0;
    const netMargin = curNetSales > 0 ? ((curNetProfit / curNetSales) * 100) : 0;

    // ── Average Order Value ──
    const curAOV = curSales.length > 0 ? curGross / curSales.length : 0;
    const prevAOV = prevSales.length > 0 ? prevGross / prevSales.length : 0;

    // ── ROI ──
    const curROI = curTotalExpenses > 0 ? ((curNetProfit / curTotalExpenses) * 100) : (curTotalRevenue > 0 ? 100 : 0);
    const prevROI = prevTotalExpenses > 0 ? ((prevNetProfit / prevTotalExpenses) * 100) : (prevTotalRevenue > 0 ? 100 : 0);

    // ── Inventory ──
    const totalProducts = inventory.length;
    const totalStocks = inventory.reduce((sum, i) => sum + (parseInt(i.quantity || i.stock || 0)), 0);
    const totalInventoryCost = inventory.reduce((sum, i) => sum + ((parseFloat(i.unitCost || i.cost || 0)) * (parseInt(i.quantity || i.stock || 0))), 0);

    // ── Expense Breakdown by Category ──
    const expenseCategories = {};
    curExpenses.filter(e => e.type === 'expense').forEach(e => {
      const amt = parseFloat(e.amount) || 0;
      const c = (e.category || 'Other');
      expenseCategories[c] = (expenseCategories[c] || 0) + amt;
    });
    if (curCOGS > 0) expenseCategories['Cost of Goods Sold'] = curCOGS;

    // ── Payment Method Breakdown ──
    const paymentMethods = {};
    curSales.forEach(s => {
      const pm = (s.paymentMethod || 'Cash');
      paymentMethods[pm] = (paymentMethods[pm] || 0) + (parseFloat(s.total) || 0);
    });

    // ── Top transactions ──
    const transactions = curSales.sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt)).slice(0, 50).map(s => ({
      id: s.transactionId || s.id || 'N/A',
      date: s.date || s.createdAt,
      cashierName: s.recordedByName || s.cashierName || s.employeeName || 'Staff',
      paymentMethod: s.paymentMethod || 'Cash',
      taxAmount: parseFloat(s.taxAmount) || 0,
      total: parseFloat(s.total) || 0
    }));

    writeReportAudit(req, 'Overall Report', bizId);

    res.json({
      success: true,
      data: {
        reportTitle: 'Overall Financial Report',
        // Revenue
        grossSales: curGross,
        taxes: curTaxes,
        netSales: curNetSales,
        otherIncome: curOtherIncome,
        totalRevenue: curTotalRevenue,
        // Expenses
        costOfGoodsSold: curCOGS,
        operatingExpenses: curOpExp,
        totalExpenses: curTotalExpenses,
        // Profit
        grossProfit: curGrossProfit,
        netProfit: curNetProfit,
        grossMarginPercent: grossMargin.toFixed(1) + '%',
        netMarginPercent: netMargin.toFixed(1) + '%',
        // Transaction stats
        totalTransactions: curSales.length,
        averageOrderValue: curAOV,
        // ROI
        roi: curROI,
        // Inventory
        totalProducts,
        totalStocks,
        totalInventoryCost,
        // Breakdowns
        expenseCategories,
        paymentMethods,
        transactions,
        // Trends
        trends: {
          grossSales: calculateTrend(curGross, prevGross),
          netSales: calculateTrend(curNetSales, prevNetSales),
          totalRevenue: calculateTrend(curTotalRevenue, prevTotalRevenue),
          totalExpenses: calculateTrend(curTotalExpenses, prevTotalExpenses),
          grossProfit: calculateTrend(curGrossProfit, prevGrossProfit),
          netProfit: calculateTrend(curNetProfit, prevNetProfit),
          transactions: calculateTrend(curSales.length, prevSales.length),
          aov: calculateTrend(curAOV, prevAOV),
          roi: calculateTrend(curROI, prevROI),
          taxes: calculateTrend(curTaxes, prevTaxes),
          cogs: calculateTrend(curCOGS, prevCOGS),
          operatingExpenses: calculateTrend(curOpExp, prevOpExp)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate overall report.' });
  }
});

// GET /api/reports/:bizId/roi (Requirement 4.4 - ROI Calculations)
router.get('/:bizId/roi', requireViewer, async (req, res) => {
  const { bizId } = req.params;
  const { category, product } = req.query;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, inventory } = data;

    const curROI = computeROIByProduct(curSales, inventory, category, product);
    const prevROI = computeROIByProduct(prevSales, inventory, category, product);

    const overallTrend = calculateTrend(curROI.totals.roi, prevROI.totals.roi);
    const profitTrend = calculateTrend(curROI.totals.netProfit, prevROI.totals.netProfit);
    const revenueTrend = calculateTrend(curROI.totals.revenue, prevROI.totals.revenue);

    res.json({
      success: true,
      data: {
        reportTitle: 'Return on Investment (ROI) Report',
        filters: {
          category: category || 'all',
          product: product || 'all',
          period: req.query.period || 'custom'
        },
        totals: curROI.totals,
        products: curROI.products,
        categories: curROI.categories,
        trends: {
          roi: overallTrend,
          netProfit: profitTrend,
          revenue: revenueTrend
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to calculate ROI.' });
  }
});

// GET /api/reports/:bizId/income-statement (and /incomestatement alias)
router.get(['/:bizId/income-statement', '/:bizId/incomestatement'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, curExpenses, prevExpenses, inventory } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);

    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);

    const salesRevenue = curGross - curTaxes;
    const prevSalesRev = prevGross - prevTaxes;

    const otherIncome = curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOtherIncome = prevExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const totalRevenue = salesRevenue + curTaxes + otherIncome;
    const prevTotalRev = prevSalesRev + prevTaxes + prevOtherIncome;

    const cogs = computeCOGS(curSales, inventory);
    const prevCOGS = computeCOGS(prevSales, inventory);

    const operatingExpenses = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevOpExp = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const totalExpenses = cogs + operatingExpenses;
    const prevTotalExp = prevCOGS + prevOpExp;

    const netIncome = salesRevenue + otherIncome - totalExpenses;
    const prevNetIncome = prevSalesRev + prevOtherIncome - prevTotalExp;

    res.json({
      success: true,
      data: {
        salesRevenue, taxes: curTaxes, otherIncome, totalRevenue, costOfGoods: cogs, operatingExpenses, totalExpenses, netIncome,
        period: req.query.period || 'month',
        trends: {
          totalRevenue: calculateTrend(totalRevenue, prevTotalRev),
          totalExpenses: calculateTrend(totalExpenses, prevTotalExp),
          netIncome: calculateTrend(netIncome, prevNetIncome)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/reports/:bizId/cash-flow (and /cashflow alias)
router.get(['/:bizId/cash-flow', '/:bizId/cashflow'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, prevSales, curExpenses, prevExpenses } = data;

    const curGross = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const taxRate = await getBizTaxRate(bizId);
    const curTaxes = calcTaxes(curSales, curGross, taxRate);
    const netSales = curGross - curTaxes;

    const receipts = netSales + curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const payments = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const netOperating = receipts - payments;

    const equipmentPurchase = curExpenses.filter(e => e.type === 'expense' && (e.category || '').toLowerCase().includes('equip')).reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    // Prev period
    const prevGross = prevSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const prevTaxes = calcTaxes(prevSales, prevGross, taxRate);
    const prevNetSales = prevGross - prevTaxes;
    const prevReceipts = prevNetSales + prevExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevPayments = prevExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const prevNetOp = prevReceipts - prevPayments;

    res.json({
      success: true,
      data: {
        operatingActivities: { salesReceipts: receipts, expensePayments: payments, netOperating },
        investingActivities: { equipmentPurchase, netInvesting: -equipmentPurchase },
        openingBalance: 0,
        closingBalance: netOperating - equipmentPurchase,
        period: req.query.period || 'month',
        trends: {
          salesReceipts: calculateTrend(receipts, prevReceipts),
          expensePayments: calculateTrend(payments, prevPayments),
          netOperating: calculateTrend(netOperating, prevNetOp)
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/reports/:bizId/balance-summary (and /balancesummary alias)
router.get(['/:bizId/balance-summary', '/:bizId/balancesummary'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, { period: 'year' });
    const { curSales, curExpenses, inventory } = data;

    const grossSales = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const taxRate = await getBizTaxRate(bizId);
    const taxes = calcTaxes(curSales, grossSales, taxRate);
    const netSales = grossSales - taxes;
    const otherIncome = curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const payments = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);

    const cash = Math.max(0, netSales + otherIncome - payments);
    const invValue = inventory.reduce((a, i) => a + ((parseFloat(i.unitCost) || 0) * (parseInt(i.quantity) || 0)), 0);
    const totalAssets = cash + invValue;

    const receivables = 0;
    const payables = 0;
    const totalLiabilities = 0;
    const equity = totalAssets;

    res.json({
      success: true,
      data: {
        assets: { cash, inventory: invValue, receivables, totalAssets },
        liabilities: { payables, totalLiabilities },
        equity
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/reports/all/comparison
router.get('/all/comparison', requireViewer, async (req, res) => {
  try {
    const comparison = [];
    const catsMap = { AGRI: 'Agriculture', NON_AGRI: 'Non-Agriculture', MAIN: 'Main' };

    let totalRev = 0;
    let totalExp = 0;
    let totalProf = 0;

    let targetCategories = BIZ_CATEGORIES;
    if (req.session && req.session.user) {
      const u = req.session.user;
      const isRestrictedRole = ['sales_staff', 'sale_staff', 'viewer', 'employee', 'budgeting_officer', 'budget_officer'].includes(u.role);
      const userAccess = u.businessAccess || [];
      if (isRestrictedRole || (userAccess.length > 0 && !userAccess.includes('all'))) {
        const assignedBiz = (userAccess.length > 0 && userAccess[0] !== 'all') ? userAccess[0] : (u.selectedCategory || 'AGRI');
        targetCategories = [assignedBiz];
      }
    }

    for (const bizId of targetCategories) {
      const data = await getBizData(bizId, req.query);
      const { curSales, curExpenses, inventory } = data;

      const grossSales = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
      const taxRate = await getBizTaxRate(bizId);
      const taxes = calcTaxes(curSales, grossSales, taxRate);
      const netSales = grossSales - taxes;
      const rev = netSales + curExpenses.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
      const cogs = computeCOGS(curSales, inventory);
      const opExp = curExpenses.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
      const prof = rev - cogs - opExp;

      totalRev += rev;
      totalExp += cogs + opExp;
      totalProf += prof;

      comparison.push({
        category: catsMap[bizId],
        revenue: rev,
        expenses: cogs + opExp,
        profit: prof,
        margin: rev > 0 ? ((prof / rev) * 100).toFixed(1) + '%' : '0.0%'
      });
    }

    const totals = {
      revenue: totalRev,
      expenses: totalExp,
      profit: totalProf,
      margin: totalRev > 0 ? ((totalProf / totalRev) * 100).toFixed(1) + '%' : '0.0%'
    };

    res.json({ success: true, data: { comparison, totals } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'An internal error occurred.' });
  }
});

// GET /api/reports/:bizId/salestaff-consolidated
router.get(['/:bizId/salestaff-consolidated', '/:bizId/salestaffconsolidated'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { curSales, curExpenses, inventory, curStart, curEnd } = data;

    const grossSales = curSales.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    const taxRate = await getBizTaxRate(bizId);
    const taxes = calcTaxes(curSales, grossSales, taxRate);
    const cogs = computeCOGS(curSales, inventory);
    const opExpenses = curExpenses.filter(e => e.type === 'expense' || !e.type).reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const totalExpenses = cogs + opExpenses;
    const netIncome = grossSales - taxes - totalExpenses;

    const inventoryList = (inventory || []).map(i => ({
      id: i.id || 'N/A',
      name: i.name || 'Unnamed Product',
      category: i.category || 'General',
      quantity: parseInt(i.quantity || i.stock || 0),
      unitCost: parseFloat(i.unitCost || i.cost || 0),
      sellingPrice: parseFloat(i.sellingPrice || i.price || 0),
      totalCost: (parseFloat(i.unitCost || i.cost || 0)) * (parseInt(i.quantity || i.stock || 0)),
      addedBy: i.createdBy || i.addedBy || 'Sales Staff',
      dateAdded: i.createdAt || i.date || 'N/A'
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const totalStocks = inventoryList.reduce((sum, i) => sum + i.quantity, 0);
    const totalInventoryCost = inventoryList.reduce((sum, i) => sum + i.totalCost, 0);

    const itemizedSales = [];
    curSales.forEach(s => {
      (s.items || []).forEach(it => {
        itemizedSales.push({
          saleId: s.transactionId || s.id || 'N/A',
          date: s.date || s.createdAt || new Date().toISOString(),
          productId: it.id || 'N/A',
          productName: it.name || 'Product',
          quantity: it.quantity || it.qty || 1,
          unitPrice: parseFloat(it.unitPrice || it.price || 0),
          paymentMethod: s.paymentMethod || 'cash',
          amount: parseFloat(it.subtotal || (it.unitPrice * (it.quantity || 1)) || 0),
          recordedByName: s.recordedByName || s.recordedBy || 'Sales Staff'
        });
      });
    });

    res.json({
      success: true,
      data: {
        reportTitle: 'Sales & Category Comprehensive Report',
        bizCategory: bizId,
        period: req.query.period || 'month',
        startDate: curStart ? curStart.toISOString() : null,
        endDate: curEnd ? curEnd.toISOString() : null,
        totalSales: grossSales,
        tax: taxes,
        cogs: cogs,
        opExpenses: opExpenses,
        totalExpenses: totalExpenses,
        netIncome: netIncome,
        isNetLoss: netIncome < 0,
        totalTransactions: curSales.length,
        totalStocks: totalStocks,
        totalInventoryCost: totalInventoryCost,
        inventory: inventoryList,
        itemizedSales: itemizedSales
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate sale staff consolidated report.' });
  }
});

// GET /api/reports/:bizId/budget-utilization-staff
router.get(['/:bizId/budget-utilization-staff', '/:bizId/budgetutilizationstaff'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { inventory, curExpenses, curStart, curEnd } = data;

    let budgetLimit = 500000;
    let setBy = 'System Admin';
    let setDate = new Date().toISOString();
    let budgetHistory = [];

    if (firestore) {
      const val = await FDB.getById('budgetLimits', bizId);
      if (val) {
        if (val.totalBudget) budgetLimit = parseFloat(val.totalBudget);
        if (val.setBy || val.updatedBy || val.createdByName) setBy = val.setBy || val.updatedBy || val.createdByName;
        if (val.updatedAt || val.createdAt) setDate = val.updatedAt || val.createdAt;
        if (val.history && Array.isArray(val.history)) {
          budgetHistory = val.history;
        } else if (val.history && typeof val.history === 'object') {
          budgetHistory = Object.keys(val.history).map(k => val.history[k]);
        }
      }
    }

    if (budgetHistory.length === 0) {
      budgetHistory.push({
        date: setDate,
        setBy: setBy,
        budgetLimit: budgetLimit,
        category: bizId,
        notes: 'Active Allocated Business Budget'
      });
    }

    const stockCost = inventory.reduce((sum, item) => sum + ((parseFloat(item.unitCost) || 0) * (parseInt(item.quantity) || 0)), 0);
    const opExpenses = curExpenses.filter(e => e.type === 'expense' || !e.type).reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const usedBalance = stockCost + opExpenses;

    const itemsList = inventory.map(i => ({
      id: i.id || 'N/A',
      name: i.name || 'Unnamed Product',
      category: i.category || 'General',
      quantity: parseInt(i.quantity || 0),
      unitCost: parseFloat(i.unitCost || 0),
      totalCost: (parseFloat(i.unitCost) || 0) * (parseInt(i.quantity) || 0),
      addedBy: i.addedBy || i.createdBy || 'Sales Staff',
      dateAdded: i.createdAt || i.date || 'N/A'
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({
      success: true,
      data: {
        reportTitle: 'Budget Utilization & Allocation Report',
        bizCategory: bizId,
        period: req.query.period || 'month',
        startDate: curStart ? curStart.toISOString() : null,
        endDate: curEnd ? curEnd.toISOString() : null,
        budgetSetBefore: 500000,
        budgetSetNow: budgetLimit,
        setBy: setBy,
        setDate: setDate,
        budgetHistory: budgetHistory,
        usedBalance: usedBalance,
        stockCost: stockCost,
        opExpenses: opExpenses,
        remainingBalance: budgetLimit - usedBalance,
        inventoryItems: itemsList
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate budget utilization report.' });
  }
});

// GET /api/reports/:bizId/inventory-report (and /inventoryreport alias)
router.get(['/:bizId/inventory-report', '/:bizId/inventoryreport'], requireViewer, async (req, res) => {
  const { bizId } = req.params;
  try {
    const data = await getBizData(bizId, req.query);
    const { inventory } = data;

    const totalProducts = inventory.length;
    const totalStocks = inventory.reduce((sum, i) => sum + (parseInt(i.quantity || i.stock || 0)), 0);
    const totalInventoryCost = inventory.reduce((sum, i) => sum + ((parseFloat(i.unitCost || i.cost || 0)) * (parseInt(i.quantity || i.stock || 0))), 0);
    const totalSellingValue = inventory.reduce((sum, i) => sum + ((parseFloat(i.sellingPrice || i.price || 0)) * (parseInt(i.quantity || i.stock || 0))), 0);

    const inventoryList = inventory.map(i => ({
      id: i.id || 'N/A',
      name: i.name || 'Unnamed Product',
      category: i.category || 'General',
      quantity: parseInt(i.quantity || i.stock || 0),
      unitCost: parseFloat(i.unitCost || i.cost || 0),
      sellingPrice: parseFloat(i.sellingPrice || i.price || 0),
      totalCost: (parseFloat(i.unitCost || i.cost || 0)) * (parseInt(i.quantity || i.stock || 0)),
      status: i.status || (parseInt(i.quantity || 0) > 0 ? 'in-stock' : 'out-of-stock'),
      supplier: i.supplier || 'N/A',
      dateAdded: i.createdAt || i.date || 'N/A'
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({
      success: true,
      data: {
        reportTitle: 'Inventory Stock & Product Cost Report',
        bizCategory: bizId,
        totalProducts,
        totalStocks,
        totalInventoryCost,
        totalSellingValue,
        inventory: inventoryList
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate inventory report.' });
  }
});

// POST /api/reports/send-consolidated
router.post('/send-consolidated', requireViewer, async (req, res) => {
  const { bizId, reportSummary } = req.body;
  try {
    if (firestore) {
      await FDB.addDoc('sent_reports', {
        bizId: bizId || 'GENERAL',
        reportType: 'Consolidated Sales & P&L Report',
        sentBy: req.user ? req.user.name : 'Sales Staff',
        sentByRole: req.user ? req.user.role : 'sales_staff',
        recipients: ['Budgeting Office', 'Accountant'],
        timestamp: new Date().toISOString(),
        summary: reportSummary || {}
      });
    }
    res.json({ success: true, message: 'Report successfully transmitted to Budgeting Office and Accountant.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to send report.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MULTI-SCOPE REPORT GENERATOR — GET /api/reports/generate
//   type        = dailysales | weeklyrevenue | monthlystatement |
//                 transactionhistory | expensereport | profitloss | overall
//   categories  = AGRI,NON_AGRI,MAIN  (or 'all')
//   businesses  = <entityId,entityId2> (one / custom count) or 'all' or
//                 empty → aggregate entire selected categories
//   period      = day | week | month | year  (or startDate & endDate)
// Every report includes trend indicators (up/down %) comparing the
// selected period against the previous comparable period.
// Access: super_admin/admin/system_administrator or businessAccess
// 'all' → unrestricted. All other roles are clamped SERVER-SIDE to
// their assigned categories/businesses (cannot be bypassed via UI).
// ═══════════════════════════════════════════════════════════════════
const GENERATOR_TYPES = {
  overall: 'Overall Report',
  dailysales: 'Daily Sales Report',
  weeklyrevenue: 'Weekly Revenue Summary',
  monthlystatement: 'Monthly Financial Statement',
  transactionhistory: 'Transaction History Report',
  expensereport: 'Expense Report',
  profitloss: 'Profit & Loss Statement'
};
const ADMIN_LEVEL_ROLES = ['super_admin', 'admin', 'system_administrator'];
const CAT_NAMES = { AGRI: 'Agriculture', NON_AGRI: 'Non-Agriculture', MAIN: 'Main' };

async function resolveReportScope(user) {
  const access = (user && (user.businessAccess || user.businesses)) || [];
  const unrestricted = ADMIN_LEVEL_ROLES.includes(user && user.role) || access.includes('all');
  if (unrestricted) return { unrestricted: true, categories: BIZ_CATEGORIES.slice(), businessIds: 'all' };

  const entries = (Array.isArray(access) ? access : []).filter(a => a && a !== 'all');
  const selected = (user && user.selectedCategory && user.selectedCategory !== 'all') ? user.selectedCategory : null;
  const cats = new Set();
  const bizIds = new Set();

  const classify = (e, bizById) => {
    const doc = bizById ? bizById[e] : null;
    if (doc && doc.categoryId) { bizIds.add(doc.id); cats.add(doc.categoryId); }
    else if (BIZ_CATEGORIES.includes(e)) cats.add(e);      // legacy: entry is a category id
    else bizIds.add(e);                                    // unknown id — keep for entity matching
  };

  if (entries.length && firestore) {
    try {
      const bizById = {};
      (await FDB.getAll('businesses')).forEach(b => { bizById[b.id] = b; });
      entries.forEach(e => classify(e, bizById));
    } catch (_) { entries.forEach(e => classify(e, null)); }
  }
  if (selected) cats.add(selected);
  if (cats.size === 0 && bizIds.size === 0) cats.add('AGRI'); // consistent with router.param fallback
  return { unrestricted: false, categories: [...cats], businessIds: bizIds.size ? [...bizIds] : 'all' };
}

router.get('/generate', requireViewer, async (req, res) => {
  try {
    const u = (req.session && req.session.user) || {};
    const scope = await resolveReportScope(u);

    // ── 1. Categories (clamped to what the role is allowed to see) ──
    let reqCats = String(req.query.categories || 'all').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!reqCats.length || reqCats.includes('ALL')) reqCats = BIZ_CATEGORIES.slice();
    const categories = scope.unrestricted
      ? reqCats.filter(c => BIZ_CATEGORIES.includes(c))
      : reqCats.filter(c => scope.categories.includes(c));
    if (!categories.length) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to the selected category(ies).',
        allowedCategories: scope.categories
      });
    }

    // ── 2. Businesses (workspace entity ids; null = entire categories) ──
    const rawBiz = String(req.query.businesses || '').trim();
    let businessIds = null;
    if (rawBiz && rawBiz.toLowerCase() !== 'all') {
      businessIds = rawBiz.split(',').map(s => s.trim()).filter(Boolean);
      if (!scope.unrestricted && scope.businessIds !== 'all') {
        businessIds = businessIds.filter(id => scope.businessIds.includes(id));
      }
      if (!businessIds.length) businessIds = null;
    }

    // ── 3. Report type ──
    const type = String(req.query.type || 'dailysales').toLowerCase();
    const title = GENERATOR_TYPES[type];
    if (!title) return res.status(400).json({ success: false, message: `Unknown report type "${type}".` });

    // ── 4. Load data for the selected categories ──
    let allSales = [], allExpenses = [], allInventory = [];
    if (firestore) {
      for (const c of categories) {
        const [s, e, i] = await Promise.all([
          FDB.getWhere('sales', 'businessCategory', '==', c).catch(() => []),
          FDB.getWhere('expenses', 'businessCategory', '==', c).catch(() => []),
          FDB.getWhere('inventory', 'businessCategory', '==', c).catch(() => [])
        ]);
        s.forEach(x => allSales.push({ bizCategory: c, ...x }));
        e.forEach(x => allExpenses.push({ bizCategory: c, ...x }));
        i.forEach(x => allInventory.push({ bizCategory: c, ...x }));
      }
    }

    // Business workspace names (labels / breakdowns)
    const bizName = {};
    if (firestore) { (await FDB.getAll('businesses').catch(() => [])).forEach(b => { bizName[b.id] = b.name; }); }

    // Narrow to the selected businesses (entityId match, entityName fallback)
    if (businessIds) {
      const set = new Set(businessIds);
      const hit = d => set.has(d.entityId) || set.has(d.entityName);
      allSales = allSales.filter(hit);
      allExpenses = allExpenses.filter(hit);
      allInventory = allInventory.filter(hit);
    }

    // ── 5. Period windows (current vs previous comparable period) ──
    const { curStart, curEnd, prevStart, prevEnd } = getPeriodRanges(req.query);
    const curSales = filterListByRange(allSales, curStart, curEnd, 'date');
    const prevSales = filterListByRange(allSales, prevStart, prevEnd, 'date');
    const curExpenses = filterListByRange(allExpenses, curStart, curEnd, 'date');
    const prevExpenses = filterListByRange(allExpenses, prevStart, prevEnd, 'date');

    // ── 6. Core aggregates (taxes computed per category at its own rate) ──
    const sumTotal = list => list.reduce((a, s) => a + (parseFloat(s.total) || 0), 0);
    let curTaxes = 0, prevTaxes = 0;
    for (const c of categories) {
      const catCur = curSales.filter(s => (s.bizCategory || s.businessCategory) === c);
      const catPrev = prevSales.filter(s => (s.bizCategory || s.businessCategory) === c);
      const rate = await getBizTaxRate(c);
      curTaxes += calcTaxes(catCur, sumTotal(catCur), rate);
      prevTaxes += calcTaxes(catPrev, sumTotal(catPrev), rate);
    }
    const curGross = sumTotal(curSales), prevGross = sumTotal(prevSales);
    const curNet = curGross - curTaxes, prevNet = prevGross - prevTaxes;
    const curCOGS = computeCOGS(curSales, allInventory), prevCOGS = computeCOGS(prevSales, allInventory);
    const opExp = l => l.filter(e => e.type === 'expense').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const otherInc = l => l.filter(e => e.type === 'income').reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
    const curOpExp = opExp(curExpenses), prevOpExp = opExp(prevExpenses);
    const curOtherInc = otherInc(curExpenses), prevOtherInc = otherInc(prevExpenses);
    const curProfit = curNet - (curCOGS + curOpExp);
    const prevProfit = prevNet - (prevCOGS + prevOpExp);

    // ── 7. Shared breakdowns (business, category, expense, payments) ──
    const bizKey = d => d.entityId || d.entityName || d.bizCategory || 'Unassigned';
    const bizLabel = d => {
      const k = bizKey(d);
      if (bizName[k]) return bizName[k];
      const cat = d.bizCategory || d.businessCategory;
      if (CAT_NAMES[cat] && k !== cat) return `${CAT_NAMES[cat]} — ${k}`;
      return CAT_NAMES[cat] || k;
    };
    function groupSum(list, keyFn, valFn) {
      const m = {};
      list.forEach(d => { const k = keyFn(d); m[k] = (m[k] || 0) + valFn(d); });
      return m;
    }
    const curBizRev = groupSum(curSales, bizKey, s => parseFloat(s.total) || 0);
    const prevBizRev = groupSum(prevSales, bizKey, s => parseFloat(s.total) || 0);
    const curBizExp = groupSum(curExpenses.filter(e => e.type === 'expense'), bizKey, e => parseFloat(e.amount) || 0);
    const curBizCnt = groupSum(curSales, bizKey, () => 1);
    const bizCatOf = k => { const s = curSales.find(x => bizKey(x) === k); return s ? (s.bizCategory || s.businessCategory) : ''; };
    const businessBreakdown = Object.keys(curBizRev).map(k => ({
      key: k,
      name: bizLabel({ entityId: k, bizCategory: bizCatOf(k) }),
      category: CAT_NAMES[bizCatOf(k)] || bizCatOf(k) || '—',
      revenue: curBizRev[k],
      previousRevenue: prevBizRev[k] || 0,
      expenses: curBizExp[k] || 0,
      net: curBizRev[k] - (curBizExp[k] || 0),
      transactions: curBizCnt[k] || 0,
      trend: calculateTrend(curBizRev[k], prevBizRev[k] || 0)
    })).sort((a, b) => b.revenue - a.revenue);

    const curCatRev = groupSum(curSales, s => s.bizCategory || s.businessCategory, s => parseFloat(s.total) || 0);
    const prevCatRev = groupSum(prevSales, s => s.bizCategory || s.businessCategory, s => parseFloat(s.total) || 0);
    const categoryBreakdown = categories.map(c => ({
      category: c,
      name: CAT_NAMES[c] || c,
      revenue: curCatRev[c] || 0,
      previousRevenue: prevCatRev[c] || 0,
      trend: calculateTrend(curCatRev[c] || 0, prevCatRev[c] || 0)
    }));

    const expCat = e => (e.category || 'other').toLowerCase();
    const curExpByCat = groupSum(curExpenses.filter(e => e.type === 'expense'), expCat, e => parseFloat(e.amount) || 0);
    const prevExpByCat = groupSum(prevExpenses.filter(e => e.type === 'expense'), expCat, e => parseFloat(e.amount) || 0);
    const expenseBreakdown = Object.keys(curExpByCat).map(k => ({
      category: k,
      name: k.charAt(0).toUpperCase() + k.slice(1),
      amount: curExpByCat[k],
      previousAmount: prevExpByCat[k] || 0,
      trend: calculateTrend(curExpByCat[k], prevExpByCat[k] || 0)
    })).sort((a, b) => b.amount - a.amount);

    const paymentMethods = groupSum(curSales, s => (s.paymentMethod || 'cash').toLowerCase(), () => 1);

    // Transactions (newest first, capped at 300 rows)
    const txSort = (a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0);
    const transactions = curSales.slice().sort(txSort).slice(0, 300).map(s => ({
      id: s.transactionId || s.id || '',
      date: s.date || s.createdAt || '',
      time: s.time || '',
      business: bizLabel(s),
      items: s.items || [],
      total: parseFloat(s.total) || 0,
      paymentMethod: s.paymentMethod || 'cash',
      customer: s.customerName || 'Walk-in',
      soldBy: s.recordedByName || s.cashierName || '—'
    }));

    // ── 8. Per-type payload (KPIs + statement lines, all with trends) ──
    const K = (label, value, trend, currency = true) => ({ label, value, trend, currency });
    const L = (label, amount, trend, negative = false) => ({ label, amount, trend, negative });
    let kpis = [], lines = [], extra = {};

    if (type === 'dailysales') {
      const curAOV = curSales.length ? curGross / curSales.length : 0;
      const prevAOV = prevSales.length ? prevGross / prevSales.length : 0;
      kpis = [
        K('Gross Sales', curGross, calculateTrend(curGross, prevGross)),
        K('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        K('Transactions', curSales.length, calculateTrend(curSales.length, prevSales.length), false),
        K('Net Profit', curProfit, calculateTrend(curProfit, prevProfit))
      ];
      lines = [
        L('Taxes Collected', curTaxes, calculateTrend(curTaxes, prevTaxes), true),
        L('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS), true),
        L('Operating Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp), true),
        L('Other Income', curOtherInc, calculateTrend(curOtherInc, prevOtherInc)),
        L('Average Order Value', curAOV, calculateTrend(curAOV, prevAOV))
      ];
    } else if (type === 'weeklyrevenue') {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dailyBreakdown = days.map(dayName => ({ day: dayName, revenue: 0, salesCount: 0 }));
      curSales.forEach(s => {
        const d = new Date(s.date || s.createdAt);
        if (!isNaN(d.getTime())) {
          const idx = d.getDay();
          dailyBreakdown[idx].revenue += (parseFloat(s.total) || 0);
          dailyBreakdown[idx].salesCount += 1;
        }
      });
      kpis = [
        K('Gross Revenue', curGross, calculateTrend(curGross, prevGross)),
        K('Net Revenue', curNet, calculateTrend(curNet, prevNet)),
        K('Total Expenses', curCOGS + curOpExp, calculateTrend(curCOGS + curOpExp, prevCOGS + prevOpExp)),
        K('Net Profit', curProfit, calculateTrend(curProfit, prevProfit))
      ];
      lines = [
        L('Taxes Collected', curTaxes, calculateTrend(curTaxes, prevTaxes), true),
        L('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS), true),
        L('Operating Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp), true)
      ];
      extra = { dailyBreakdown };
    } else if (type === 'monthlystatement') {
      const curTotalRev = curNet + curOtherInc, prevTotalRev = prevNet + prevOtherInc;
      const curNetIncome = curTotalRev - (curCOGS + curOpExp) - curTaxes;
      const prevNetIncome = prevTotalRev - (prevCOGS + prevOpExp) - prevTaxes;
      kpis = [
        K('Total Revenue', curTotalRev, calculateTrend(curTotalRev, prevTotalRev)),
        K('Total Expenses', curCOGS + curOpExp, calculateTrend(curCOGS + curOpExp, prevCOGS + prevOpExp)),
        K('Net Income (after tax)', curNetIncome, calculateTrend(curNetIncome, prevNetIncome)),
        K('Transactions', curSales.length, calculateTrend(curSales.length, prevSales.length), false)
      ];
      lines = [
        L('Sales Revenue (net of tax)', curNet, calculateTrend(curNet, prevNet)),
        L('Other Income', curOtherInc, calculateTrend(curOtherInc, prevOtherInc)),
        L('Total Revenue', curTotalRev, calculateTrend(curTotalRev, prevTotalRev)),
        L('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS), true),
        L('Operating Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp), true),
        L('Income Before Tax', curTotalRev - (curCOGS + curOpExp), calculateTrend(curTotalRev - (curCOGS + curOpExp), prevTotalRev - (prevCOGS + prevOpExp))),
        L('Taxes', curTaxes, calculateTrend(curTaxes, prevTaxes), true),
        L('Net Income', curNetIncome, calculateTrend(curNetIncome, prevNetIncome))
      ];
    } else if (type === 'transactionhistory') {
      const curAOV = curSales.length ? curGross / curSales.length : 0;
      const prevAOV = prevSales.length ? prevGross / prevSales.length : 0;
      kpis = [
        K('Transactions', curSales.length, calculateTrend(curSales.length, prevSales.length), false),
        K('Gross Sales', curGross, calculateTrend(curGross, prevGross)),
        K('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        K('Average Order Value', curAOV, calculateTrend(curAOV, prevAOV))
      ];
    } else if (type === 'expensereport') {
      const curTotal = curCOGS + curOpExp, prevTotal = prevCOGS + prevOpExp;
      const curCount = curExpenses.filter(e => e.type === 'expense').length;
      const prevCount = prevExpenses.filter(e => e.type === 'expense').length;
      kpis = [
        K('Total Expenses', curTotal, calculateTrend(curTotal, prevTotal)),
        K('Cash Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp)),
        K('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS)),
        K('Expense Entries', curCount, calculateTrend(curCount, prevCount), false)
      ];
      lines = expenseBreakdown.map(x => L(x.name, x.amount, x.trend, true));
      extra = {
        expensesList: curExpenses.filter(e => e.type === 'expense').slice(0, 300).map(e => ({
          id: e.id || '', date: e.date || e.createdAt || '', category: expCat(e),
          description: e.description || e.name || e.supplier || 'Expense',
          business: bizLabel(e), amount: parseFloat(e.amount) || 0
        }))
      };
    } else if (type === 'overall') {
      // Comprehensive report — combines sales, revenue, expenses, P&L and all breakdowns
      const curAOV = curSales.length ? curGross / curSales.length : 0;
      const prevAOV = prevSales.length ? prevGross / prevSales.length : 0;
      const curGrossProfit = curNet - curCOGS, prevGrossProfit = prevNet - prevCOGS;
      const curNetProfit = curGrossProfit - curOpExp, prevNetProfit = prevGrossProfit - prevOpExp;
      const curMargin = curNet > 0 ? ((curNetProfit / curNet) * 100) : 0;
      const prevMargin = prevNet > 0 ? ((prevNetProfit / prevNet) * 100) : 0;
      kpis = [
        K('Gross Sales', curGross, calculateTrend(curGross, prevGross)),
        K('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        K('Total Expenses', curCOGS + curOpExp, calculateTrend(curCOGS + curOpExp, prevCOGS + prevOpExp)),
        K('Net Profit', curNetProfit, calculateTrend(curNetProfit, prevNetProfit)),
        K('Transactions', curSales.length, calculateTrend(curSales.length, prevSales.length), false),
        K('Average Order Value', curAOV, calculateTrend(curAOV, prevAOV))
      ];
      lines = [
        L('Gross Sales', curGross, calculateTrend(curGross, prevGross)),
        L('Taxes Collected', curTaxes, calculateTrend(curTaxes, prevTaxes), true),
        L('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        L('Other Income', curOtherInc, calculateTrend(curOtherInc, prevOtherInc)),
        L('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS), true),
        L('Gross Profit', curGrossProfit, calculateTrend(curGrossProfit, prevGrossProfit)),
        L('Operating Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp), true),
        L('Net Profit (Net Margin: ' + curMargin.toFixed(1) + '%)', curNetProfit, calculateTrend(curNetProfit, prevNetProfit))
      ];
      // Calendar-day revenue breakdown across the entire period
      const dayMap = {};
      curSales.forEach(s => {
        const dt = new Date(s.date || s.createdAt);
        if (isNaN(dt.getTime())) return;
        const key = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        if (!dayMap[key]) dayMap[key] = { day: key, revenue: 0, salesCount: 0 };
        dayMap[key].revenue += (parseFloat(s.total) || 0);
        dayMap[key].salesCount += 1;
      });
      const dailyBreakdown = Object.values(dayMap)
        .sort((a, b) => a.day.localeCompare(b.day))
        .map(x => ({ ...x, day: new Date(x.day + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) }));
      extra = {
        dailyBreakdown,
        expensesList: curExpenses.filter(e => e.type === 'expense').slice(0, 300).map(e => ({
          id: e.id || '', date: e.date || e.createdAt || '', category: expCat(e),
          description: e.description || e.name || e.supplier || 'Expense',
          business: bizLabel(e), amount: parseFloat(e.amount) || 0
        }))
      };
    } else { // profitloss
      const curGrossProfit = curNet - curCOGS, prevGrossProfit = prevNet - prevCOGS;
      const curNetProfit = curGrossProfit - curOpExp, prevNetProfit = prevGrossProfit - prevOpExp;
      const curMargin = curNet > 0 ? ((curNetProfit / curNet) * 100) : 0;
      const prevMargin = prevNet > 0 ? ((prevNetProfit / prevNet) * 100) : 0;
      kpis = [
        K('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        K('Gross Profit', curGrossProfit, calculateTrend(curGrossProfit, prevGrossProfit)),
        K('Net Profit', curNetProfit, calculateTrend(curNetProfit, prevNetProfit)),
        K('Net Margin', curMargin.toFixed(1) + '%', calculateTrend(curMargin, prevMargin), false)
      ];
      lines = [
        L('Gross Sales', curGross, calculateTrend(curGross, prevGross)),
        L('Taxes Collected', curTaxes, calculateTrend(curTaxes, prevTaxes), true),
        L('Net Sales', curNet, calculateTrend(curNet, prevNet)),
        L('Cost of Goods Sold', curCOGS, calculateTrend(curCOGS, prevCOGS), true),
        L('Gross Profit', curGrossProfit, calculateTrend(curGrossProfit, prevGrossProfit)),
        L('Operating Expenses', curOpExp, calculateTrend(curOpExp, prevOpExp), true),
        L('Net Profit', curNetProfit, calculateTrend(curNetProfit, prevNetProfit))
      ];
    }

    // ── 9. Respond ──
    const periodLabel = (req.query.startDate && req.query.endDate)
      ? `${curStart.toLocaleDateString('en-PH')} → ${curEnd.toLocaleDateString('en-PH')}`
      : (req.query.period === 'day' ? curStart.toLocaleDateString('en-PH')
        : req.query.period === 'year' ? `Year ${curStart.getFullYear()}`
        : curStart.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }));
    await writeReportAudit(req, title, `categories: ${categories.join(',')} | businesses: ${businessIds ? businessIds.join(',') : 'all'}`);

    // ── Notify admins: WHO generated WHICH report for WHICH category ──
    try {
      if (firestore) {
        const gen = (req.session && req.session.user) || {};
        const catLabel = categories.map(c => CAT_NAMES[c] || c).join(', ');
        const bizLabel = businessIds
          ? businessIds.map(id => bizName[id] || id).join(', ')
          : `All businesses in ${catLabel}`;
        await FDB.addDoc('notifications', {
          type: 'report_generated',
          title: 'Report Generated',
          message: `${gen.name || 'Unknown user'} generated a ${title} for ${catLabel} — ${bizLabel} (period: ${periodLabel}).`,
          reportType: type,
          reportTitle: title,
          businessCategory: categories.length === 1 ? categories[0] : 'ALL',
          businessId: businessIds && businessIds.length === 1 ? businessIds[0] : null,
          entityId: businessIds && businessIds.length === 1 ? businessIds[0] : '',
          entityName: businessIds && businessIds.length === 1 ? (bizName[businessIds[0]] || '') : '',
          generatedBy: gen.uid || '',
          priority: 'info',
          isRead: false,
          createdAt: new Date().toISOString(),
          createdByName: gen.name || 'Unknown user',
        }).catch(() => {});
      }
    } catch (_) {}

    res.json({
      success: true,
      data: {
        reportTitle: title,
        reportType: type,
        period: {
          label: periodLabel,
          start: curStart.toISOString(), end: curEnd.toISOString(),
          previousStart: prevStart.toISOString(), previousEnd: prevEnd.toISOString()
        },
        scope: {
          categories,
          categoryNames: categories.map(c => CAT_NAMES[c] || c),
          businesses: businessIds ? businessIds.map(id => ({ id, name: bizName[id] || id })) : 'all',
          restricted: !scope.unrestricted
        },
        kpis, lines,
        businessBreakdown, categoryBreakdown, expenseBreakdown,
        paymentMethods, transactions,
        trends: {
          revenue: calculateTrend(curNet, prevNet),
          expenses: calculateTrend(curCOGS + curOpExp, prevCOGS + prevOpExp),
          profit: calculateTrend(curProfit, prevProfit),
          transactions: calculateTrend(curSales.length, prevSales.length)
        },
        ...extra
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate report.' });
  }
});

module.exports = router;
