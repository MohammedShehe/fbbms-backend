const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, has } = require('../middleware/auth');
const { bad, notFound, wrap, clip, int, isDate, eatDate, addDays } = require('../lib/util');
const { createSale, voidSale, PAYMENTS } = require('../lib/sales');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');
const tzu = require('../lib/tz');
const { notify } = require('../lib/notify');
const hooks = require('../lib/webhooks');

const seesAll = req => req.member.role === 'super_admin' || has(req, 'sales.view_all');

router.post('/sales', can('sales.create'), wrap(async (req, res) => {
  const isSuper = req.member.role === 'super_admin';
  const result = await tx(conn => createSale(conn, {
    biz: req.biz, userId: req.user.id, perms: req.member.permissions, isSuper,
    items: req.body.items, customer_name: req.body.customer_name, customer_phone: req.body.customer_phone,
    payment_method: req.body.payment_method, payments: req.body.payments, customer_id: req.body.customer_id, redeem_points: req.body.redeem_points, discount: req.body.discount, notes: req.body.notes, source: 'pos'
  }));
  await audit(req, { action: 'sale.create', entity: 'sale', entity_id: result.id, details: { receipt: result.receipt_no, total: result.total, discount: result.discount } });
  if (result.priceOverrides.length) await audit(req, { action: 'sale.price_override', entity: 'sale', entity_id: result.id, details: result.priceOverrides });
  rt.broadcast(req.biz.id, 'sale.new', { id: result.id, receipt_no: result.receipt_no, total: result.total, by: req.user.name, by_id: req.user.id, discount: result.discount });
  const today = tzu.today(req.biz);
  for (const p of result.lowStock) {
    rt.broadcast(req.biz.id, 'stock.low', p); hooks.emit(req.biz.id, 'stock.low', p);
    await notify(req.biz, { type: 'stock.low', severity: p.stock_qty <= 0 ? 'warn' : 'info', audience: 'all', title: p.stock_qty <= 0 ? `${p.name} is out of stock` : `Low stock: ${p.name} (${p.stock_qty} left)`, dedupe: `low:${p.id}:${today}` });
  }
  const thr = Number(req.biz.settings.alert_discount_pct) || 10;
  if (!isSuper && result.discount > 0 && result.subtotal > 0 && result.discount / result.subtotal * 100 >= thr) await notify(req.biz, { type: 'sale.discount', severity: 'warn', audience: 'super', title: `Large discount on ${result.receipt_no}: ${result.discount}`, body: `${req.user.name} gave ${Math.round(result.discount / result.subtotal * 100)}% off`, dedupe: `disc:${result.id}` });
  if (result.priceOverrides.length) await notify(req.biz, { type: 'sale.override', severity: 'info', audience: 'super', title: `Price changed at checkout on ${result.receipt_no}`, body: `${req.user.name}: ${result.priceOverrides.map(o => JSON.stringify(o)).join(', ').slice(0, 300)}`, dedupe: `ovr:${result.id}` });
  hooks.emit(req.biz.id, 'sale.completed', { receipt_no: result.receipt_no, total: result.total, paid_status: result.paid_status });
  delete result.lowStock; delete result.priceOverrides;
  res.json(result);
}));

router.get('/sales', wrap(async (req, res) => {
  if (!seesAll(req) && !has(req, 'sales.create')) throw require('../lib/util').forbidden();
  const w = ['s.business_id=?']; const a = [req.biz.id];
  if (!seesAll(req)) { w.push('s.sold_by=?'); a.push(req.user.id); }
  else if (req.query.seller) { w.push('s.sold_by=?'); a.push(int(req.query.seller)); }
  if (isDate(req.query.from)) { w.push('s.sale_date>=?'); a.push(req.query.from); }
  if (isDate(req.query.to)) { w.push('s.sale_date<=?'); a.push(req.query.to); }
  if (PAYMENTS.includes(req.query.payment)) { w.push('s.payment_method=?'); a.push(req.query.payment); }
  if (['completed', 'voided'].includes(req.query.status)) { w.push('s.status=?'); a.push(req.query.status); }
  if (['pos', 'website'].includes(req.query.source)) { w.push('s.source=?'); a.push(req.query.source); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(s.receipt_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ? OR EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id=s.id AND i.name LIKE ?))'); a.push(s, s, s, s); }
  const where = w.join(' AND ');
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(200, Math.max(1, int(req.query.limit, 25)));
  const order = { oldest: 's.id ASC', highest: 's.total DESC', lowest: 's.total ASC' }[req.query.sort] || 's.id DESC';
  const sum = await one(`SELECT COUNT(*) AS count, COALESCE(SUM(s.status='completed'),0) AS completed, COALESCE(SUM(s.status='voided'),0) AS voided,
      COALESCE(SUM(IF(s.status='completed',s.total,0)),0) AS revenue, COALESCE(SUM(IF(s.status='completed',s.discount,0)),0) AS discounts,
      COALESCE(SUM(IF(s.status='completed',s.profit,0)),0) AS profit, COALESCE(SUM(IF(s.status='voided',s.total,0)),0) AS voided_value FROM sales s WHERE ${where}`, a);
  const rows = await q(`SELECT s.id,s.receipt_no,s.source,s.customer_name,s.customer_phone,s.payment_method,s.subtotal,s.discount,s.total,s.profit,s.status,s.paid_status,s.amount_paid,s.refunded_total,s.customer_id,s.void_reason,s.sold_at,s.sale_date,s.sold_by,u.name AS seller,
      (SELECT COALESCE(SUM(qty),0) FROM sale_items i WHERE i.sale_id=s.id) AS units,
      (SELECT GROUP_CONCAT(i.name SEPARATOR ', ') FROM sale_items i WHERE i.sale_id=s.id) AS item_names
      FROM sales s JOIN users u ON u.id=s.sold_by WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  if (!has(req, 'products.see_cost')) { delete sum.profit; rows.forEach(r => delete r.profit); }
  res.json({ rows, total: sum.count, page, limit, summary: sum });
}));

router.get('/sales/:id', wrap(async (req, res) => {
  const s = await one(`SELECT s.*, u.name AS seller, v.name AS voided_by_name FROM sales s JOIN users u ON u.id=s.sold_by LEFT JOIN users v ON v.id=s.voided_by WHERE s.id=? AND s.business_id=?`, [req.params.id, req.biz.id]);
  if (!s) throw notFound('Sale not found');
  if (!seesAll(req) && s.sold_by !== req.user.id) throw require('../lib/util').forbidden();
  s.items = await q('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [s.id]);
  s.payments = await q('SELECT method,amount,reference,created_at FROM sale_payments WHERE sale_id=? ORDER BY id', [s.id]);
  s.refunds = await q('SELECT refund_no,type,amount,cash_out,reason,created_at FROM refunds WHERE sale_id=? ORDER BY id', [s.id]);
  s.balance_due = Math.max(0, Math.round((s.total - s.refunded_total - s.amount_paid) * 100) / 100);
  if (!has(req, 'products.see_cost')) { delete s.cost_total; delete s.profit; s.items.forEach(i => delete i.unit_cost); }
  res.json(s);
}));

router.post('/sales/:id/void', can('sales.void'), wrap(async (req, res) => {
  const reason = clip(req.body.reason, 255); if (reason.length < 3) throw bad('Give a reason for voiding this sale');
  const sale = await tx(conn => voidSale(conn, { biz: req.biz, saleId: int(req.params.id), userId: req.user.id, reason }));
  await audit(req, { action: 'sale.void', entity: 'sale', entity_id: sale.id, details: { receipt: sale.receipt_no, total: sale.total, reason } });
  await notify(req.biz, { type: 'sale.void', severity: 'warn', audience: 'super', title: `Sale ${sale.receipt_no} voided (${sale.total})`, body: `${req.user.name}: ${reason}`, dedupe: `void:${sale.id}` });
  rt.broadcast(req.biz.id, 'sale.voided', { id: sale.id, receipt_no: sale.receipt_no, total: sale.total, by: req.user.name });
  rt.broadcast(req.biz.id, 'product.changed', {});
  res.json({ ok: true });
}));

module.exports = router;
