// Finance statements, tax report, cash-flow statement, daily closing report (module: finance).
const router = require('express').Router();
const { q, one } = require('../config/db');
const { requireModule, canAny } = require('../middleware/auth');
const { wrap, bad, isDate, round2, addDays, startOfMonth } = require('../lib/util');
const { offset } = require('../lib/tz');
const M = require('../lib/metrics');

const gate = [requireModule('finance'), canAny('reports.view')];
const rng = req => { const t = M.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(t); const to = isDate(req.query.to) ? req.query.to : t; if (from > to) throw bad('The start date is after the end date'); if ((new Date(to) - new Date(from)) / 86400000 > 400) throw bad('Choose a range of up to 13 months'); return { from, to }; };

router.get('/finance/statements', gate, wrap(async (req, res) => {
  const { from, to } = rng(req); const B = req.biz.id; const off = offset(req.biz);
  const p = await M.period(req.biz, from, to);
  const expCat = await q("SELECT category AS name, SUM(amount) AS total FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC", [B, from, to]);
  // cash flow (actual money): receipts by method net of cash refunds, minus supplier payments and expenses paid
  const inflow = await q(`SELECT p.method AS name, SUM(IF(p.amount>0,p.amount,0)) AS received, SUM(IF(p.amount<0,-p.amount,0)) AS refunded FROM sale_payments p JOIN sales s ON s.id=p.sale_id
     WHERE p.business_id=? AND p.method<>'credit_note' AND s.status='completed' AND DATE(DATE_ADD(p.created_at, INTERVAL ? MINUTE)) BETWEEN ? AND ? GROUP BY p.method`, [B, off, from, to]);
  const sup = await one('SELECT COALESCE(SUM(amount),0) AS v FROM supplier_payments WHERE business_id=? AND paid_date BETWEEN ? AND ?', [B, from, to]);
  const received = round2(inflow.reduce((t, r) => t + Number(r.received), 0)), refunded = round2(inflow.reduce((t, r) => t + Number(r.refunded), 0));
  const net = round2(received - refunded - Number(sup.v) - p.expenses);
  const [inv, rec, pay] = await Promise.all([M.inventory(req.biz, to), M.receivables(req.biz), M.payables(req.biz)]);
  const tax = await q(`SELECT DATE_FORMAT(sale_date,'%Y-%m') AS month, SUM(total - tax_amount) AS net_sales, SUM(tax_amount) AS tax FROM sales WHERE business_id=? AND status='completed' AND sale_date BETWEEN ? AND ? GROUP BY month ORDER BY month`, [B, from, to]);
  const rt = await q("SELECT DATE_FORMAT(refund_date,'%Y-%m') AS month, SUM(tax_amount) AS tax FROM refunds WHERE business_id=? AND refund_date BETWEEN ? AND ? GROUP BY month", [B, from, to]);
  const s = req.biz.settings;
  res.json({ from, to, currency: req.biz.currency,
    income_statement: { gross_sales: p.gross, discounts: -p.discounts, refunds: -p.refunds.amount, net_revenue: p.net_revenue, tax_included: p.tax, cost_of_goods: p.cogs, gross_profit: p.gross_profit, expenses: p.expenses, expenses_by_category: expCat, net_profit: p.net_profit, net_margin_pct: p.net_revenue ? round2(p.net_profit / p.net_revenue * 100) : 0, note: 'Net revenue is shown after refunds. Gross profit excludes tax collected.' },
    cash_flow: { received_by_method: inflow.map(r => ({ method: r.name, received: Number(r.received), refunded: Number(r.refunded) })), total_received: received, refunds_paid: refunded, supplier_payments: Number(sup.v), expenses: p.expenses, net_cash_flow: net, note: 'Cash basis: money actually received/paid in the period. Credit sales not yet paid and exchange credit are not counted. All expenses are treated as paid in the period they are dated.' },
    tax: { name: s.tax_name || 'Tax', rate_pct: Number(s.tax_rate_pct) || 0, prices_include_tax: s.tax_inclusive !== false, months: tax.map(t => { const r = rt.find(x => x.month === t.month); const refT = r ? Number(r.tax) : 0; return { month: t.month, net_sales: round2(Number(t.net_sales)), tax_collected: round2(Number(t.tax)), tax_refunded: round2(refT), tax_payable: round2(Number(t.tax) - refT) }; }), total_payable: p.tax, tin: s.tin || null },
    position: { inventory_at_cost: Number(inv.cost_value), inventory_at_retail: Number(inv.retail_value), customer_debts: rec.total, owed_to_suppliers: pay.total, note: 'A management snapshot, not an audited balance sheet.' } });
}));

router.get('/closing-report', requireModule('finance'), canAny('reports.view', 'cash.manage'), wrap(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : M.today(req.biz); const B = req.biz.id; const off = offset(req.biz);
  const [p, sellers, cats, pay] = await Promise.all([M.period(req.biz, date, date), M.bySeller(req.biz, date, date), M.byCategory(req.biz, date, date),
    q(`SELECT p.method AS name, SUM(p.amount) AS net FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE p.business_id=? AND p.method<>'credit_note' AND s.status='completed' AND DATE(DATE_ADD(p.created_at, INTERVAL ? MINUTE))=? GROUP BY p.method`, [B, off, date])]);
  const credit = await one("SELECT COUNT(*) AS n, COALESCE(SUM(total-amount_paid),0) AS v FROM sales WHERE business_id=? AND status='completed' AND sale_date=? AND paid_status<>'paid'", [B, date]);
  const sessions = await q("SELECT id,opening_float,expected_cash,counted_cash,variance,opened_at,closed_at,status FROM cash_sessions WHERE business_id=? AND session_date=? ORDER BY id", [B, date]);
  const exp = await q("SELECT category,description,amount FROM expenses WHERE business_id=? AND expense_date=? AND voided=0 AND status='approved' ORDER BY id", [B, date]);
  const inv = await M.inventory(req.biz, date);
  res.json({ date, business: req.biz.name, currency: req.biz.currency, summary: p, payments_by_method: pay.map(r => ({ method: r.name, net: Number(r.net) })), credit_given: { sales: credit.n, amount: Number(credit.v) }, expenses: exp, cash_sessions: sessions, by_seller: sellers, by_category: cats, low_stock: inv.low_list.slice(0, 10) });
}));

module.exports = router;
