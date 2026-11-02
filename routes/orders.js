const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, isDate } = require('../lib/util');
const { createSale, PAYMENTS } = require('../lib/sales');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');

const STATUSES = ['new', 'contacted', 'confirmed', 'completed', 'cancelled'];

router.get('/orders', can('orders.view'), wrap(async (req, res) => {
  const w = ['o.business_id=?']; const a = [req.biz.id];
  if (STATUSES.includes(req.query.status)) { w.push('o.status=?'); a.push(req.query.status); }
  if (req.query.status === 'open') w.push("o.status IN ('new','contacted','confirmed')");
  if (isDate(req.query.from)) { w.push('DATE(DATE_ADD(o.created_at, INTERVAL ? MINUTE))>=?'); a.push(require('../lib/tz').offset(req.biz), req.query.from); }
  if (isDate(req.query.to)) { w.push('DATE(DATE_ADD(o.created_at, INTERVAL ? MINUTE))<=?'); a.push(require('../lib/tz').offset(req.biz), req.query.to); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(o.order_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)'); a.push(s, s, s); }
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(100, Math.max(1, int(req.query.limit, 25)));
  const where = w.join(' AND ');
  const total = (await one(`SELECT COUNT(*) AS n FROM orders o WHERE ${where}`, a)).n;
  const rows = await q(`SELECT o.*, h.name AS handled_by_name, s.receipt_no FROM orders o LEFT JOIN users h ON h.id=o.handled_by LEFT JOIN sales s ON s.id=o.sale_id
                        WHERE ${where} ORDER BY (o.status='new') DESC, o.id DESC LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  if (rows.length) {
    const items = await q('SELECT * FROM order_items WHERE order_id IN (?) ORDER BY id', [rows.map(r => r.id)]);
    rows.forEach(r => { r.items = items.filter(i => i.order_id === r.id); });
  }
  const counts = await q('SELECT status, COUNT(*) AS n, COALESCE(SUM(items_total),0) AS value FROM orders WHERE business_id=? GROUP BY status', [req.biz.id]);
  res.json({ rows, total, page, limit, counts });
}));

router.get('/orders/:id', can('orders.view'), wrap(async (req, res) => {
  const o = await one('SELECT o.*, h.name AS handled_by_name, s.receipt_no FROM orders o LEFT JOIN users h ON h.id=o.handled_by LEFT JOIN sales s ON s.id=o.sale_id WHERE o.id=? AND o.business_id=?', [req.params.id, req.biz.id]);
  if (!o) throw notFound('Order not found');
  o.items = await q('SELECT oi.*, p.stock_qty, p.track_stock, p.image_url FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?', [o.id]);
  res.json(o);
}));

router.put('/orders/:id', can('orders.manage'), wrap(async (req, res) => {
  const status = String(req.body.status || '');
  if (!['contacted', 'confirmed', 'cancelled'].includes(status)) throw bad('Use "Complete" to finish an order');
  const o = await one('SELECT * FROM orders WHERE id=? AND business_id=?', [req.params.id, req.biz.id]);
  if (!o) throw notFound('Order not found');
  if (['completed', 'cancelled'].includes(o.status)) throw conflict(`This order is already ${o.status}`);
  const reason = clip(req.body.cancel_reason, 255);
  if (status === 'cancelled' && reason.length < 3) throw bad('Give a reason for cancelling');
  await q('UPDATE orders SET status=?, handled_by=?, admin_notes=COALESCE(?,admin_notes), cancel_reason=? WHERE id=?',
    [status, req.user.id, req.body.admin_notes !== undefined ? clip(req.body.admin_notes, 500) : null, status === 'cancelled' ? reason : null, o.id]);
  await audit(req, { action: 'order.' + status, entity: 'order', entity_id: o.id, details: { order_no: o.order_no, reason: reason || undefined } });
  rt.broadcast(req.biz.id, 'order.updated', { id: o.id, order_no: o.order_no, status, by: req.user.name });
  require('../lib/webhooks').emit(req.biz.id, 'order.updated', { order_no: o.order_no, status });
  res.json({ ok: true });
}));

router.put('/orders/:id/notes', can('orders.manage'), wrap(async (req, res) => {
  await q('UPDATE orders SET admin_notes=? WHERE id=? AND business_id=?', [clip(req.body.admin_notes, 500) || null, req.params.id, req.biz.id]);
  res.json({ ok: true });
}));

// Completing an order records a real sale (money + stock) - the only way website orders become income.
router.post('/orders/:id/complete', can('orders.manage'), wrap(async (req, res) => {
  const payment = PAYMENTS.includes(req.body.payment_method) ? req.body.payment_method : null;
  if (!payment) throw bad('Choose how the customer paid');
  const out = await tx(async conn => {
    const [[o]] = await conn.query('SELECT * FROM orders WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]);
    if (!o) throw notFound('Order not found');
    if (['completed', 'cancelled'].includes(o.status)) throw conflict(`This order is already ${o.status}`);
    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id=?', [o.id]);
    if (items.some(i => !i.product_id)) throw bad('An item in this order no longer exists. Cancel it or contact the customer.');
    const fixed = {}; items.forEach(i => { fixed[i.product_id] = i.unit_price; });
    const sale = await createSale(conn, {
      biz: req.biz, userId: req.user.id, perms: req.member.permissions, isSuper: req.member.role === 'super_admin',
      items: items.map(i => ({ product_id: i.product_id, qty: i.qty })), fixedPrices: fixed,
      customer_name: o.customer_name, customer_phone: o.customer_phone, payment_method: payment, discount: req.body.discount,
      notes: `Website order ${o.order_no}`, source: 'website', order_id: o.id
    });
    await conn.query("UPDATE orders SET status='completed', sale_id=?, handled_by=? WHERE id=?", [sale.id, req.user.id, o.id]);
    await audit(req, { action: 'order.completed', entity: 'order', entity_id: o.id, details: { order_no: o.order_no, receipt: sale.receipt_no, total: sale.total }, conn });
    return { sale, order_no: o.order_no };
  });
  rt.broadcast(req.biz.id, 'sale.new', { id: out.sale.id, receipt_no: out.sale.receipt_no, total: out.sale.total, by: req.user.name, by_id: req.user.id, discount: out.sale.discount, website: true });
  rt.broadcast(req.biz.id, 'order.updated', { id: int(req.params.id), order_no: out.order_no, status: 'completed', by: req.user.name });
  out.sale.lowStock.forEach(p => rt.broadcast(req.biz.id, 'stock.low', p));
  require('../lib/webhooks').emit(req.biz.id, 'order.updated', { order_no: out.order_no, status: 'completed' });
  res.json({ ok: true, receipt_no: out.sale.receipt_no, total: out.sale.total });
}));

module.exports = router;
