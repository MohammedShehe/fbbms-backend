// One place for the business numbers (revenue, profit, stock, receivables...) so dashboards, health, summaries,
// finance statements and the AI assistant all quote the SAME figures. Revenue = completed sales minus refunds.
const { q, one } = require('../config/db');
const { round2, addDays } = require('./util');
const { localDate, bizTz, offset } = require('./tz');

const num = v => Number(v || 0);
const DUE = 'GREATEST(0, s.total - s.refunded_total - s.amount_paid)';

async function period(biz, from, to, { seller = null } = {}) {
  const B = biz.id; const sf = seller ? ' AND s.sold_by=?' : ''; const sp = seller ? [seller] : [];
  const t = await one(`SELECT COUNT(*) AS sales, COALESCE(SUM(s.subtotal),0) AS gross, COALESCE(SUM(s.discount),0) AS discounts, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.tax_amount),0) AS tax,
      COALESCE(SUM(s.cost_total),0) AS cogs, COALESCE(SUM(s.profit),0) AS profit FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf}`, [B, from, to, ...sp]);
  const units = await one(`SELECT COALESCE(SUM(i.qty),0) AS u FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?${sf}`, [B, from, to, ...sp]);
  const rf = seller ? { n: 0, amount: 0, tax: 0, cost: 0 } : await one('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(tax_amount),0) AS tax, COALESCE(SUM(cost_recovered),0) AS cost FROM refunds WHERE business_id=? AND refund_date BETWEEN ? AND ?', [B, from, to]);
  const ex = seller ? { total: 0 } : await one("SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ?", [B, from, to]);
  const vd = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(s.total),0) AS value FROM sales s WHERE s.business_id=? AND s.status='voided' AND s.sale_date BETWEEN ? AND ?${sf}`, [B, from, to, ...sp]);
  const netRevenue = round2(num(t.revenue) - num(rf.amount));
  const netProfit0 = round2(num(t.profit) - (num(rf.amount) - num(rf.tax) - num(rf.cost)));
  return {
    from, to, sales: num(t.sales), units: num(units.u), gross: num(t.gross), discounts: num(t.discounts), revenue: num(t.revenue), tax: round2(num(t.tax) - num(rf.tax)), cogs: round2(num(t.cogs) - num(rf.cost)),
    refunds: { count: num(rf.n), amount: num(rf.amount) }, net_revenue: netRevenue, gross_profit: netProfit0, expenses: num(ex.total), net_profit: round2(netProfit0 - num(ex.total)),
    margin_pct: netRevenue ? round2(netProfit0 / netRevenue * 100) : 0, avg_sale: t.sales ? round2(num(t.revenue) / num(t.sales)) : 0, voids: { count: num(vd.n), value: num(vd.value) }
  };
}

async function daily(biz, from, to) {
  const s = await q("SELECT sale_date AS d, SUM(total) AS revenue, SUM(profit) AS profit, COUNT(*) AS sales FROM sales WHERE business_id=? AND status='completed' AND sale_date BETWEEN ? AND ? GROUP BY sale_date", [biz.id, from, to]);
  const r = await q('SELECT refund_date AS d, SUM(amount) AS amount, SUM(amount-tax_amount-cost_recovered) AS impact FROM refunds WHERE business_id=? AND refund_date BETWEEN ? AND ? GROUP BY refund_date', [biz.id, from, to]);
  const sm = new Map(s.map(x => [x.d, x])); const rm = new Map(r.map(x => [x.d, x])); const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const a = sm.get(d) || {}; const b = rm.get(d) || {}; out.push({ date: d, revenue: round2(num(a.revenue) - num(b.amount)), profit: round2(num(a.profit) - num(b.impact)), sales: num(a.sales) }); }
  return out;
}

async function topProducts(biz, from, to, { by = 'revenue', order = 'desc', limit = 10 } = {}) {
  const col = { revenue: 'revenue', profit: 'profit', units: 'units' }[by] || 'revenue'; const dir = order === 'asc' ? 'ASC' : 'DESC';
  return q(`SELECT i.name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue, SUM(i.line_total - i.unit_cost*i.qty) AS profit FROM sale_items i JOIN sales s ON s.id=i.sale_id
    WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY i.product_id, i.name ORDER BY ${col} ${dir} LIMIT ?`, [biz.id, from, to, Math.min(50, limit)]);
}
const byCategory = (biz, from, to) => q(`SELECT COALESCE(i.category,'Uncategorised') AS name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue, SUM(i.line_total - i.unit_cost*i.qty) AS profit FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY COALESCE(i.category,'Uncategorised') ORDER BY revenue DESC`, [biz.id, from, to]);
const bySeller = (biz, from, to) => q(`SELECT u.id, u.name, COUNT(*) AS sales, SUM(s.total) AS revenue, SUM(s.profit) AS profit, SUM(s.discount) AS discounts, SUM(s.subtotal) AS gross,
    (SELECT COUNT(*) FROM sales v WHERE v.business_id=? AND v.sold_by=u.id AND v.status='voided' AND v.sale_date BETWEEN ? AND ?) AS voids,
    (SELECT COUNT(*) FROM sales o WHERE o.business_id=? AND o.sold_by=u.id AND o.status='completed' AND o.sale_date BETWEEN ? AND ? AND HOUR(DATE_ADD(o.sold_at, INTERVAL ? MINUTE)) < 5) AS odd_hours
    FROM sales s JOIN users u ON u.id=s.sold_by WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY u.id,u.name ORDER BY revenue DESC`, [biz.id, from, to, biz.id, from, to, offset(biz), biz.id, from, to]);

async function inventory(biz, today) {
  const B = biz.id;
  const inv = await one(`SELECT COUNT(*) AS products, COALESCE(SUM(track_stock=1 AND stock_qty>0 AND stock_qty<=low_stock_at),0) AS low, COALESCE(SUM(track_stock=1 AND stock_qty<=0),0) AS out_of_stock,
      COALESCE(SUM(IF(track_stock=1,stock_qty*cost_price,0)),0) AS cost_value, COALESCE(SUM(IF(track_stock=1,stock_qty*price,0)),0) AS retail_value, COALESCE(SUM(IF(track_stock=1,stock_qty,0)),0) AS units FROM products WHERE business_id=? AND status='active'`, [B]);
  const lowList = await q("SELECT id,name,sku,stock_qty,low_stock_at FROM products WHERE business_id=? AND status='active' AND track_stock=1 AND stock_qty<=low_stock_at ORDER BY stock_qty ASC LIMIT 25", [B]);
  const dead = await q(`SELECT p.id,p.name,p.stock_qty,p.cost_price*p.stock_qty AS tied_up FROM products p WHERE p.business_id=? AND p.status='active' AND p.track_stock=1 AND p.stock_qty>0
      AND p.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY) AND NOT EXISTS (SELECT 1 FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE i.product_id=p.id AND s.status='completed' AND s.sale_date>?) ORDER BY tied_up DESC LIMIT 25`, [B, addDays(today, -60)]);
  const expiring = await q("SELECT id,name,stock_qty,expiry_date FROM products WHERE business_id=? AND status='active' AND track_stock=1 AND stock_qty>0 AND expiry_date IS NOT NULL AND expiry_date<=? ORDER BY expiry_date LIMIT 25", [B, addDays(today, 30)]);
  return { ...inv, low_list: lowList, dead_stock: dead, expiring: expiring.map(e => ({ ...e, expired: e.expiry_date < today })) };
}

async function receivables(biz) { const r = await one(`SELECT COUNT(DISTINCT s.customer_id) AS customers, COUNT(*) AS invoices, COALESCE(SUM(${DUE}),0) AS total FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.total - s.refunded_total - s.amount_paid > 0.009`, [biz.id]); return { customers: num(r.customers), invoices: num(r.invoices), total: num(r.total) }; }
async function payables(biz) {
  const r = await one(`SELECT COUNT(*) AS suppliers, COALESCE(SUM(b),0) AS total FROM (SELECT (COALESCE((SELECT SUM(received_value) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status<>'cancelled'),0) - COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0)) AS b FROM suppliers s WHERE s.business_id=?) x WHERE b>0.009`, [biz.id]);
  return { suppliers: num(r.suppliers), total: num(r.total) };
}
async function newCustomers(biz, from, to) { return num((await one("SELECT COUNT(*) AS n FROM customers WHERE business_id=? AND DATE(created_at) BETWEEN ? AND ?", [biz.id, from, to])).n); }
const today = biz => localDate(new Date(), bizTz(biz));

module.exports = { period, daily, topProducts, byCategory, bySeller, inventory, receivables, payables, newCustomers, today, DUE, num };
