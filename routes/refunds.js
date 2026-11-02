// Refunds and exchanges against a completed sale (module: refunds). Goods go back on the shelf (or are written off),
// the money handed back is tracked, and revenue/profit reports are adjusted automatically.
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, canAny, requireModule } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, round2 } = require('../lib/util');
const { localDate, bizTz } = require('../lib/tz');
const { createSale, PAYMENTS } = require('../lib/sales');
const customers = require('../lib/customers');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const hooks = require('../lib/webhooks');
const rt = require('../lib/realtime');

const mod = requireModule('refunds');

router.get('/refunds', mod, canAny('sales.refund', 'reports.view'), wrap(async (req, res) => {
  const w = ['r.business_id=?']; const a = [req.biz.id];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { w.push('r.refund_date>=?'); a.push(req.query.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { w.push('r.refund_date<=?'); a.push(req.query.to); }
  const rows = await q(`SELECT r.*, s.receipt_no, s.customer_name, u.name AS user_name, ns.receipt_no AS new_receipt_no FROM refunds r JOIN sales s ON s.id=r.sale_id JOIN users u ON u.id=r.created_by LEFT JOIN sales ns ON ns.id=r.new_sale_id WHERE ${w.join(' AND ')} ORDER BY r.id DESC LIMIT 200`, a);
  if (rows.length) { const items = await q('SELECT * FROM refund_items WHERE refund_id IN (?)', [rows.map(r => r.id)]); rows.forEach(r => { r.items = items.filter(i => i.refund_id === r.id); }); }
  res.json(rows);
}));

// What can still be returned from a sale?
router.get('/sales/:id/refundable', mod, can('sales.refund'), wrap(async (req, res) => {
  const s = await one('SELECT id,receipt_no,status,total,subtotal,refunded_total,amount_paid,customer_name FROM sales WHERE id=? AND business_id=?', [req.params.id, req.biz.id]);
  if (!s) throw notFound('Sale not found'); if (s.status !== 'completed') throw conflict('Only completed sales can be refunded');
  const items = await q(`SELECT i.id,i.product_id,i.name,i.sku,i.qty,i.unit_price,i.unit_cost, COALESCE((SELECT SUM(ri.qty) FROM refund_items ri WHERE ri.sale_item_id=i.id),0) AS returned FROM sale_items i WHERE i.sale_id=? ORDER BY i.id`, [s.id]);
  items.forEach(i => { i.available = i.qty - i.returned; delete i.unit_cost; });
  res.json({ sale: s, ratio: s.subtotal > 0 ? s.total / s.subtotal : 1, items });
}));

router.post('/sales/:id/refund', mod, can('sales.refund'), wrap(async (req, res) => {
  const reason = clip(req.body.reason, 255); if (reason.length < 3) throw bad('Give a reason for the return');
  const type = req.body.type === 'exchange' ? 'exchange' : 'refund';
  const method = PAYMENTS.includes(req.body.method) ? req.body.method : 'cash';
  const lines = Array.isArray(req.body.items) ? req.body.items : []; if (!lines.length) throw bad('Choose the items being returned');
  if (type === 'exchange' && !(Array.isArray(req.body.new_items) && req.body.new_items.length)) throw bad('Choose the replacement items');
  const isSuper = req.member.role === 'super_admin';

  const out = await tx(async conn => {
    const [[sale]] = await conn.query('SELECT * FROM sales WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]);
    if (!sale) throw notFound('Sale not found'); if (sale.status !== 'completed') throw conflict('Only completed sales can be refunded');
    const [items] = await conn.query(`SELECT i.*, COALESCE((SELECT SUM(ri.qty) FROM refund_items ri WHERE ri.sale_item_id=i.id),0) AS returned FROM sale_items i WHERE i.sale_id=? ORDER BY i.id`, [sale.id]);
    const ratio = sale.subtotal > 0 ? Number(sale.total) / Number(sale.subtotal) : 1;
    const picked = []; let gross = 0, cost = 0; const seen = new Set();
    for (const l of lines) {
      const it = items.find(x => x.id === int(l.sale_item_id)); const qty = int(l.qty);
      if (!it) throw bad('An item does not belong to this sale'); if (seen.has(it.id)) throw bad('An item appears twice'); seen.add(it.id);
      if (qty < 1 || qty > it.qty - it.returned) throw bad(`"${it.name}": only ${it.qty - it.returned} can still be returned`);
      const restock = l.restock !== false && l.restock !== 0;
      picked.push({ it, qty, restock }); gross += it.unit_price * qty; if (restock) cost += it.unit_cost * qty;
    }
    const allBack = items.every(i => { const p = picked.find(x => x.it.id === i.id); return i.returned + (p ? p.qty : 0) >= i.qty; });
    const amount = allBack ? round2(sale.total - sale.refunded_total) : round2(Math.min(gross * ratio, sale.total - sale.refunded_total));
    if (!(amount > 0)) throw bad('Nothing to refund');
    const taxPart = sale.total > 0 ? round2(sale.tax_amount * amount / sale.total) : 0;
    const refundedAfter = round2(sale.refunded_total + amount);
    const creditAvailable = round2(Math.max(0, sale.amount_paid - (sale.total - refundedAfter)));

    // limit on refunds for shopkeepers
    const cap = Number(req.biz.settings.refund_limit_shopkeeper) || 0; // 0 = no limit
    if (!isSuper && cap > 0 && amount > cap) throw require('../lib/util').forbidden(`Refunds above ${cap} need a Super Admin`);

    await conn.query('UPDATE businesses SET next_refund = LAST_INSERT_ID(next_refund + 1) WHERE id=?', [req.biz.id]);
    const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const refund_no = `${req.biz.code}-R${String(seq).padStart(5, '0')}`;
    const now = new Date(); const rdate = localDate(now, bizTz(req.biz));

    // exchange: sell the replacement items now; the credit from the returned goods pays first
    let newSale = null, cashOut = 0;
    if (type === 'exchange') {
      newSale = await createSale(conn, { biz: req.biz, userId: req.user.id, perms: req.member.permissions, isSuper, items: req.body.new_items, customer_id: sale.customer_id, customer_name: sale.customer_name, customer_phone: sale.customer_phone, payments: req.body.payments, notes: `Exchange for ${sale.receipt_no}`, credit_available: creditAvailable, source: 'pos', payment_method: method });
      cashOut = round2(creditAvailable - newSale.credit_used);
    } else cashOut = creditAvailable;

    const [r] = await conn.query('INSERT INTO refunds (business_id,refund_no,sale_id,type,amount,tax_amount,cash_out,cost_recovered,method,reason,new_sale_id,created_by,created_at,refund_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.biz.id, refund_no, sale.id, type, amount, taxPart, cashOut, round2(cost), cashOut > 0 || type === 'refund' ? method : 'credit_note', reason, newSale ? newSale.id : null, req.user.id, now, rdate]);
    for (const p of picked.sort((a, b) => (a.it.product_id || 0) - (b.it.product_id || 0))) {
      await conn.query('INSERT INTO refund_items (refund_id,sale_item_id,product_id,name,qty,unit_price,unit_cost,line_total,restocked) VALUES (?,?,?,?,?,?,?,?,?)', [r.insertId, p.it.id, p.it.product_id, p.it.name, p.qty, p.it.unit_price, p.it.unit_cost, round2(p.it.unit_price * p.qty), p.restock ? 1 : 0]);
      if (p.restock && p.it.product_id) {
        const [[pr]] = await conn.query('SELECT id,track_stock,stock_qty FROM products WHERE id=? FOR UPDATE', [p.it.product_id]);
        if (pr && pr.track_stock) {
          const bal = pr.stock_qty + p.qty; await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [bal, pr.id]);
          await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,note,user_id) VALUES (?,?,'refund_return',?,?,?,'refund',?,?,?)", [req.biz.id, pr.id, p.qty, bal, p.it.unit_cost, r.insertId, `${type === 'exchange' ? 'Exchange' : 'Refund'} ${refund_no} on ${sale.receipt_no}`, req.user.id]);
        }
      }
    }
    const newPaid = round2(sale.amount_paid - cashOut); const effTotal = round2(sale.total - refundedAfter);
    await conn.query('UPDATE sales SET refunded_total=?, amount_paid=?, paid_status=? WHERE id=?', [refundedAfter, newPaid, newPaid >= effTotal - 0.009 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid', sale.id]);
    if (cashOut > 0) await conn.query('INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, sale.id, sale.customer_id, method, -cashOut, `Refund ${refund_no}`, req.user.id, now]);
    if (sale.customer_id && sale.points_earned && sale.total > 0) await customers.addPoints(conn, req.biz.id, sale.customer_id, -Math.floor(sale.points_earned * amount / sale.total), `Refund ${refund_no}`, 'refund', r.insertId, req.user.id);
    await audit(req, { action: 'sale.' + type, entity: 'sale', entity_id: sale.id, details: { refund_no, receipt: sale.receipt_no, amount, cash_out: cashOut, reason, items: picked.map(p => `${p.qty}× ${p.it.name}`) }, conn });
    return { id: r.insertId, refund_no, type, amount, cash_out: cashOut, credit_used: newSale ? newSale.credit_used : 0, new_sale: newSale ? { id: newSale.id, receipt_no: newSale.receipt_no, total: newSale.total, balance_due: newSale.balance_due } : null, receipt: sale.receipt_no, lowStock: newSale ? newSale.lowStock : [] };
  });
  rt.broadcast(req.biz.id, 'product.changed', {});
  await notify(req.biz, { type: 'refund.created', severity: out.amount >= (Number(req.biz.settings.alert_refund_amount) || 100000) ? 'warn' : 'info', audience: 'super', title: `${out.type === 'exchange' ? 'Exchange' : 'Refund'} ${out.refund_no}: ${out.amount}`, body: `${req.user.name} processed ${out.type} on ${out.receipt}. Reason: ${reason}`, dedupe: `refund:${out.id}` });
  hooks.emit(req.biz.id, 'sale.completed', { kind: out.type, refund_no: out.refund_no, amount: out.amount });
  out.lowStock.forEach(p => rt.broadcast(req.biz.id, 'stock.low', p)); delete out.lowStock;
  res.json(out);
}));

module.exports = router;
