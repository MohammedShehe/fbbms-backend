// Dashboard + reports. Revenue = completed sales only (voided sales never count).
const router = require('express').Router();
const { q, one } = require('../config/db');
const { has, canAny } = require('../middleware/auth');
const { wrap, addDays, startOfMonth, isDate, int, round2, bad } = require('../lib/util');
const tzu = require('../lib/tz');
const eatDate = () => { throw new Error('use tzu.today(req.biz)'); };

const full = req => req.member.role === 'super_admin' || has(req, 'reports.view');
const money = (v) => round2(v || 0);

function fillDays(rows, from, to, keys) {
  const m = new Map(rows.map(r => [r.d, r]));
  const out = []; for (let d = from; d <= to; d = addDays(d, 1)) { const r = m.get(d) || {}; const o = { date: d }; keys.forEach(k => { o[k] = Number(r[k] || 0); }); out.push(o); }
  return out;
}

router.get('/dashboard', wrap(async (req, res) => {
  const own = !full(req);
  const seeCost = has(req, 'products.see_cost') || full(req);
  const today = tzu.today(req.biz); const yesterday = addDays(today, -1); const wk = addDays(today, -6); const d30 = addDays(today, -29); const mtd = startOfMonth(today);
  const prevMonthStart = startOfMonth(addDays(mtd, -1)); const prevMonthEnd = addDays(mtd, -1);
  const sc = own ? ' AND s.sold_by=?' : ''; const sa = own ? [req.user.id] : [];
  const B = req.biz.id;

  const agg = async (from, to) => one(`SELECT COUNT(*) AS sales, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(profit),0) AS profit, COALESCE(SUM(discount),0) AS discounts,
      (SELECT COALESCE(SUM(i.qty),0) FROM sale_items i JOIN sales x ON x.id=i.sale_id WHERE x.business_id=? AND x.status='completed' AND x.sale_date BETWEEN ? AND ? ${own ? 'AND x.sold_by=?' : ''}) AS units
      FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc}`, [B, from, to, ...sa, B, from, to, ...sa]);
  // revenue and profit are shown AFTER refunds so the owner sees what the business really kept
  const refAdj = async (from, to) => own ? { amount: 0, impact: 0 } : one('SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(amount-tax_amount-cost_recovered),0) AS impact FROM refunds WHERE business_id=? AND refund_date BETWEEN ? AND ?', [B, from, to]);
  const aggNet = async (from, to) => { const [a, r] = await Promise.all([agg(from, to), refAdj(from, to)]); return { ...a, revenue: round2(a.revenue - r.amount), profit: round2(a.profit - r.impact), refunds: r.amount }; };
  const [t, y, w, m, pm] = await Promise.all([aggNet(today, today), aggNet(yesterday, yesterday), aggNet(wk, today), aggNet(mtd, today), aggNet(prevMonthStart, prevMonthEnd)]);

  const daily = await q(`SELECT s.sale_date AS d, SUM(s.total) AS revenue, SUM(s.profit) AS profit, COUNT(*) AS sales FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc} GROUP BY s.sale_date`, [B, d30, today, ...sa]);
  const hourly = await q(`SELECT HOUR(DATE_ADD(s.sold_at, INTERVAL ${tzu.offset(req.biz)} MINUTE)) AS h, COUNT(*) AS sales, SUM(s.total) AS revenue FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc} GROUP BY h ORDER BY h`, [B, d30, today, ...sa]);
  const byCategory = await q(`SELECT COALESCE(i.category,'Uncategorised') AS name, SUM(i.line_total) AS revenue, SUM(i.qty) AS units FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc} GROUP BY COALESCE(i.category,'Uncategorised') ORDER BY revenue DESC LIMIT 8`, [B, d30, today, ...sa]);
  const byPayment = await q(`SELECT s.payment_method AS name, SUM(s.total) AS revenue, COUNT(*) AS sales FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc} GROUP BY s.payment_method ORDER BY revenue DESC`, [B, d30, today, ...sa]);
  const topProducts = await q(`SELECT i.name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? ${sc} GROUP BY i.product_id, i.name ORDER BY revenue DESC LIMIT 8`, [B, d30, today, ...sa]);
  const sellers = own ? [] : await q(`SELECT u.id, u.name, COUNT(*) AS sales, SUM(s.total) AS revenue, SUM(s.discount) AS discounts,
      (SELECT COUNT(*) FROM sales v WHERE v.business_id=? AND v.sold_by=u.id AND v.status='voided' AND v.sale_date BETWEEN ? AND ?) AS voids
      FROM sales s JOIN users u ON u.id=s.sold_by WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY u.id, u.name ORDER BY revenue DESC`, [B, d30, today, B, d30, today]);
  const recent = await q(`SELECT s.id,s.receipt_no,s.total,s.payment_method,s.customer_name,s.sold_at,s.status,s.source,u.name AS seller FROM sales s JOIN users u ON u.id=s.sold_by WHERE s.business_id=? ${sc} ORDER BY s.id DESC LIMIT 8`, [B, ...sa]);

  const inv = await one(`SELECT COUNT(*) AS products, COALESCE(SUM(track_stock=1 AND stock_qty>0 AND stock_qty<=low_stock_at),0) AS low, COALESCE(SUM(track_stock=1 AND stock_qty<=0),0) AS out_of_stock,
      COALESCE(SUM(IF(track_stock=1,stock_qty,0)),0) AS units, COALESCE(SUM(IF(track_stock=1,stock_qty*cost_price,0)),0) AS cost_value, COALESCE(SUM(IF(track_stock=1,stock_qty*price,0)),0) AS retail_value,
      COALESCE(SUM(is_published=1),0) AS published FROM products WHERE business_id=? AND status='active'`, [B]);
  const lowList = has(req, 'products.view') || full(req) ? await q(`SELECT id,name,sku,stock_qty,low_stock_at,image_url FROM products WHERE business_id=? AND status='active' AND track_stock=1 AND stock_qty<=low_stock_at ORDER BY stock_qty ASC LIMIT 8`, [B]) : [];
  const orders = has(req, 'orders.view') ? await one(`SELECT COALESCE(SUM(status='new'),0) AS new_orders, COALESCE(SUM(status IN ('new','contacted','confirmed')),0) AS open_orders, COALESCE(SUM(IF(status IN ('new','contacted','confirmed'),items_total,0)),0) AS open_value FROM orders WHERE business_id=?`, [B]) : null;
  const expenses = (!own || has(req, 'expenses.manage')) && full(req) ? await one(`SELECT COALESCE(SUM(IF(expense_date BETWEEN ? AND ?,amount,0)),0) AS month, COALESCE(SUM(IF(expense_date=?,amount,0)),0) AS today FROM expenses WHERE business_id=? AND voided=0 AND status='approved'`, [mtd, today, today, B]) : null;
  const flags = full(req) ? await one(`SELECT COALESCE(SUM(status='voided' AND sale_date BETWEEN ? AND ?),0) AS voids_30d, COALESCE(SUM(status='voided' AND sale_date BETWEEN ? AND ?),0) AS voided_value_30d, COALESCE(SUM(status='completed' AND discount>0 AND sale_date BETWEEN ? AND ?),0) AS discounted_30d FROM sales WHERE business_id=?`, [d30, today, d30, today, d30, today, B]) : null;
  // voided_value needs a separate sum
  if (flags) { const v = await one("SELECT COALESCE(SUM(total),0) AS v FROM sales WHERE business_id=? AND status='voided' AND sale_date BETWEEN ? AND ?", [B, d30, today]); flags.voided_value_30d = v.v; }

  const strip = o => { if (!seeCost && o) delete o.profit; return o; };
  res.json({
    scope: own ? 'own' : 'shop', today, see_cost: seeCost,
    kpi: { today: strip(t), yesterday: strip(y), week: strip(w), month: strip(m), prev_month: strip(pm) },
    daily: fillDays(daily, d30, today, ['revenue', 'profit', 'sales']).map(r => { if (!seeCost) delete r.profit; return r; }),
    hourly: Array.from({ length: 24 }, (_, h) => { const r = hourly.find(x => x.h === h); return { hour: h, sales: r ? r.sales : 0, revenue: r ? Number(r.revenue) : 0 }; }),
    by_category: byCategory, by_payment: byPayment, top_products: topProducts, sellers, recent,
    inventory: seeCost ? inv : (delete inv.cost_value, inv), low_stock: lowList, orders, expenses, flags
  });
}));

// ---------- Reports (Super Admin / reports.view) ----------
router.get('/reports', wrap(async (req, res) => {
  if (!full(req)) throw require('../lib/util').forbidden();
  const today = tzu.today(req.biz);
  let from = isDate(req.query.from) ? req.query.from : startOfMonth(today);
  let to = isDate(req.query.to) ? req.query.to : today;
  if (from > to) throw bad('The start date is after the end date');
  if ((new Date(to) - new Date(from)) / 86400000 > 400) throw bad('Choose a range of up to 13 months');
  const B = req.biz.id; const seller = req.query.seller ? int(req.query.seller) : null;
  const sf = seller ? ' AND s.sold_by=?' : ''; const sp = seller ? [seller] : [];
  const base = [B, from, to, ...sp];

  const totals = await one(`SELECT COUNT(*) AS sales, COALESCE(SUM(s.subtotal),0) AS gross, COALESCE(SUM(s.discount),0) AS discounts, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.cost_total),0) AS cost, COALESCE(SUM(s.profit),0) AS profit,
      COALESCE(SUM(s.source='website'),0) AS website_sales, COALESCE(SUM(IF(s.source='website',s.total,0)),0) AS website_revenue FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf}`, base);
  const voided = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(s.total),0) AS value FROM sales s WHERE s.business_id=? AND s.status='voided' AND s.sale_date BETWEEN ? AND ?${sf}`, base);
  const exp = await one("SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ?", [B, from, to]);
  const rfd = seller ? { n: 0, amount: 0, tax: 0, cost: 0 } : await one('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(tax_amount),0) AS tax, COALESCE(SUM(cost_recovered),0) AS cost FROM refunds WHERE business_id=? AND refund_date BETWEEN ? AND ?', [B, from, to]);
  const rfdImpact = round2(rfd.amount - rfd.tax - rfd.cost);
  const expByCat = await q("SELECT category AS name, SUM(amount) AS total FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC", [B, from, to]);
  const days = await q(`SELECT s.sale_date AS d, SUM(s.total) AS revenue, SUM(s.profit) AS profit, COUNT(*) AS sales FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf} GROUP BY s.sale_date`, base);
  const bySeller = await q(`SELECT u.id, u.name, COUNT(*) AS sales, SUM(s.total) AS revenue, SUM(s.profit) AS profit, SUM(s.discount) AS discounts,
      (SELECT COUNT(*) FROM sales v WHERE v.business_id=? AND v.sold_by=u.id AND v.status='voided' AND v.sale_date BETWEEN ? AND ?) AS voids
      FROM sales s JOIN users u ON u.id=s.sold_by WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY u.id,u.name ORDER BY revenue DESC`, [B, from, to, B, from, to]);
  const byProduct = await q(`SELECT i.name, MAX(i.sku) AS sku, SUM(i.qty) AS units, SUM(i.line_total) AS revenue, SUM(i.line_total - i.unit_cost*i.qty) AS profit FROM sale_items i JOIN sales s ON s.id=i.sale_id
      WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf} GROUP BY i.product_id, i.name ORDER BY revenue DESC LIMIT 100`, base);
  const byCategory = await q(`SELECT COALESCE(i.category,'Uncategorised') AS name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf} GROUP BY COALESCE(i.category,'Uncategorised') ORDER BY revenue DESC`, base);
  const byPayment = await q(`SELECT s.payment_method AS name, COUNT(*) AS sales, SUM(s.total) AS revenue FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf} GROUP BY s.payment_method ORDER BY revenue DESC`, base);
  const stock = await one(`SELECT COALESCE(SUM(IF(track_stock=1,stock_qty,0)),0) AS units, COALESCE(SUM(IF(track_stock=1,stock_qty*cost_price,0)),0) AS cost_value, COALESCE(SUM(IF(track_stock=1,stock_qty*price,0)),0) AS retail_value FROM products WHERE business_id=? AND status='active'`, [B]);
  // Stock reconciliation: units received - sold + returned +/- adjustments must equal units on hand.
  const recon = await one(`SELECT COALESCE(SUM(CASE WHEN type IN ('opening','purchase') THEN qty_change ELSE 0 END),0) AS received, COALESCE(SUM(CASE WHEN type='sale' THEN -qty_change ELSE 0 END),0) AS sold,
      COALESCE(SUM(CASE WHEN type IN ('void_return','refund_return') THEN qty_change ELSE 0 END),0) AS returned, COALESCE(SUM(CASE WHEN type IN ('adjustment','damage','transfer_out','transfer_in') THEN qty_change ELSE 0 END),0) AS adjusted, COALESCE(SUM(qty_change),0) AS ledger_balance FROM stock_movements WHERE business_id=?`, [B]);
  const onHand = (await one("SELECT COALESCE(SUM(stock_qty),0) AS u FROM products WHERE business_id=? AND track_stock=1", [B])).u;
  recon.on_hand = onHand; recon.balanced = Number(recon.ledger_balance) === Number(onHand);

  const grossAfter = round2(totals.profit - rfdImpact); const revAfter = round2(totals.revenue - rfd.amount); const net = round2(grossAfter - exp.total);
  res.json({ from, to, totals: { ...totals, gross_revenue: totals.revenue, revenue: revAfter, refunds: rfd.amount, refund_count: rfd.n, profit: grossAfter, expenses: exp.total, net_profit: net, margin_pct: revAfter ? round2(grossAfter / revAfter * 100) : 0, avg_sale: totals.sales ? round2(totals.revenue / totals.sales) : 0 },
    voided, days: fillDays(days, from, to, ['revenue', 'profit', 'sales']), by_seller: bySeller, by_product: byProduct, by_category: byCategory, by_payment: byPayment, expenses_by_category: expByCat, stock, reconciliation: recon });
}));

// ---------- Expenses ----------
const { can } = require('../middleware/auth');
const { clip, money: mny, notFound } = require('../lib/util');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');

router.get('/expenses', can('expenses.manage'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today;
  const rows = await q(`SELECT e.*, u.name AS user_name FROM expenses e JOIN users u ON u.id=e.created_by WHERE e.business_id=? AND e.expense_date BETWEEN ? AND ? ${req.query.q ? 'AND (e.description LIKE ? OR e.category LIKE ?)' : ''} ORDER BY e.expense_date DESC, e.id DESC LIMIT 500`,
    [req.biz.id, from, to, ...(req.query.q ? [`%${clip(req.query.q, 50)}%`, `%${clip(req.query.q, 50)}%`] : [])]);
  res.json({ rows, from, to, total: round2(rows.filter(r => !r.voided && r.status === 'approved').reduce((s, r) => s + r.amount, 0)), pending: rows.filter(r => !r.voided && r.status === 'pending').length });
}));
router.post('/expenses', can('expenses.manage'), wrap(async (req, res) => {
  const amount = mny(req.body.amount, 0); if (!(amount > 0)) throw bad('Enter the amount');
  const category = clip(req.body.category, 80); if (!category) throw bad('Choose a category');
  const date = isDate(req.body.expense_date) ? req.body.expense_date : tzu.today(req.biz);
  if (date > tzu.today(req.biz)) throw bad('Date cannot be in the future');
  const limit = Number(req.biz.settings.expense_approval_limit) || 0; const needsApproval = limit > 0 && amount > limit && req.member.role !== 'super_admin';
  const r = await q('INSERT INTO expenses (business_id,expense_date,category,description,amount,created_by,status,from_till) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, date, category, clip(req.body.description, 255) || null, amount, req.user.id, needsApproval ? 'pending' : 'approved', req.body.from_till ? 1 : 0]);
  await audit(req, { action: needsApproval ? 'expense.request' : 'expense.create', entity: 'expense', entity_id: r.insertId, details: { category, amount } });
  if (needsApproval) await require('../lib/notify').notify(req.biz, { type: 'expense.approval', severity: 'warn', audience: 'super', title: `Expense needs approval: ${amount}`, body: `${req.user.name}: ${category}${req.body.description ? ' - ' + clip(req.body.description, 80) : ''}`, dedupe: `exp:${r.insertId}` });
  rt.broadcast(req.biz.id, 'expense.new', { amount, category, by: req.user.name, pending: needsApproval });
  res.json({ id: r.insertId, status: needsApproval ? 'pending' : 'approved' });
}));
router.post('/expenses/:id/decide', can('expenses.manage'), wrap(async (req, res) => {
  if (req.member.role !== 'super_admin') throw require('../lib/util').forbidden('Super Admin only');
  const approve = req.body.approve !== false; const r = await q('UPDATE expenses SET status=?, approved_by=? WHERE id=? AND business_id=? AND status=\'pending\'', [approve ? 'approved' : 'rejected', req.user.id, req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('No pending expense found'); await audit(req, { action: approve ? 'expense.approve' : 'expense.reject', entity: 'expense', entity_id: int(req.params.id) }); res.json({ ok: true });
}));
// ---------- recurring expenses ----------
router.get('/recurring-expenses', can('expenses.manage'), wrap(async (req, res) => res.json(await q('SELECT * FROM recurring_expenses WHERE business_id=? ORDER BY active DESC, next_date', [req.biz.id]))));
router.post('/recurring-expenses', can('expenses.manage'), wrap(async (req, res) => {
  const amount = mny(req.body.amount, 0); const category = clip(req.body.category, 80); if (!(amount > 0) || !category) throw bad('Enter the category and amount');
  const next = isDate(req.body.next_date) ? req.body.next_date : tzu.today(req.biz);
  const r = await q('INSERT INTO recurring_expenses (business_id,category,description,amount,frequency,next_date,created_by) VALUES (?,?,?,?,?,?,?)', [req.biz.id, category, clip(req.body.description, 255) || null, amount, req.body.frequency === 'weekly' ? 'weekly' : 'monthly', next, req.user.id]);
  await audit(req, { action: 'expense.recurring_create', entity: 'expense', entity_id: r.insertId, details: { category, amount } }); res.json({ id: r.insertId });
}));
router.post('/recurring-expenses/:id/toggle', can('expenses.manage'), wrap(async (req, res) => { await q('UPDATE recurring_expenses SET active=1-active WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); res.json({ ok: true }); }));
router.post('/expenses/:id/void', can('expenses.manage'), wrap(async (req, res) => {
  const r = await q('UPDATE expenses SET voided=1 WHERE id=? AND business_id=? AND voided=0', [req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('Expense not found');
  await audit(req, { action: 'expense.void', entity: 'expense', entity_id: int(req.params.id) });
  res.json({ ok: true });
}));

module.exports = router;
