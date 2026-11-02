// Suppliers, purchase orders, stock receiving and supplier payments (module: suppliers).
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, requireModule } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, money, round2, phoneOk, emailOk, isDate } = require('../lib/util');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');

const gate = [requireModule('suppliers'), can('suppliers.manage')];
const BAL = `COALESCE((SELECT SUM(received_value) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status<>'cancelled'),0) - COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0)`;

router.get('/suppliers', gate, wrap(async (req, res) => {
  const w = ['s.business_id=?']; const a = [req.biz.id];
  if (req.query.status !== 'all') { w.push('s.status=?'); a.push(req.query.status === 'archived' ? 'archived' : 'active'); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(s.name LIKE ? OR s.phone LIKE ? OR s.contact_person LIKE ?)'); a.push(s, s, s); }
  const rows = await q(`SELECT s.*, (${BAL}) AS balance,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status<>'cancelled') AS po_count,
      (SELECT COALESCE(SUM(received_value),0) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status<>'cancelled') AS total_purchased,
      (SELECT MAX(received_at) FROM purchase_orders po WHERE po.supplier_id=s.id) AS last_received
      FROM suppliers s WHERE ${w.join(' AND ')} ORDER BY s.name LIMIT 500`, a);
  res.json(rows);
}));

function readSupplier(b) {
  const name = clip(b.name, 150); if (name.length < 2) throw bad('Enter the supplier name');
  const phone = clip(b.phone, 30); if (phone && !phoneOk(phone)) throw bad('Enter a valid phone number');
  const email = clip(b.email, 150); if (email && !emailOk(email)) throw bad('Enter a valid email');
  return { name, contact_person: clip(b.contact_person, 120) || null, phone: phone || null, email: email || null, address: clip(b.address, 255) || null, notes: clip(b.notes, 500) || null };
}
router.post('/suppliers', gate, wrap(async (req, res) => {
  const d = readSupplier(req.body);
  const r = await q('INSERT INTO suppliers (business_id,name,contact_person,phone,email,address,notes,created_by) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, d.name, d.contact_person, d.phone, d.email, d.address, d.notes, req.user.id]);
  await audit(req, { action: 'supplier.create', entity: 'supplier', entity_id: r.insertId, details: { name: d.name } });
  res.json({ id: r.insertId });
}));
router.put('/suppliers/:id', gate, wrap(async (req, res) => {
  const d = readSupplier(req.body);
  const r = await q('UPDATE suppliers SET name=?,contact_person=?,phone=?,email=?,address=?,notes=? WHERE id=? AND business_id=?', [d.name, d.contact_person, d.phone, d.email, d.address, d.notes, req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('Supplier not found');
  await audit(req, { action: 'supplier.update', entity: 'supplier', entity_id: int(req.params.id), details: { name: d.name } });
  res.json({ ok: true });
}));
router.post('/suppliers/:id/archive', gate, wrap(async (req, res) => {
  const restore = !!req.body.restore;
  const r = await q('UPDATE suppliers SET status=? WHERE id=? AND business_id=?', [restore ? 'active' : 'archived', req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('Supplier not found');
  await audit(req, { action: restore ? 'supplier.restore' : 'supplier.archive', entity: 'supplier', entity_id: int(req.params.id) });
  res.json({ ok: true });
}));

router.get('/suppliers/:id', gate, wrap(async (req, res) => {
  const s = await one(`SELECT s.*, (${BAL}) AS balance FROM suppliers s WHERE s.id=? AND s.business_id=?`, [req.params.id, req.biz.id]);
  if (!s) throw notFound('Supplier not found');
  s.orders = await q(`SELECT po.id,po.po_no,po.status,po.total,po.received_value,po.created_at,po.received_at,
      COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.po_id=po.id),0) AS paid FROM purchase_orders po WHERE po.supplier_id=? ORDER BY po.id DESC LIMIT 100`, [s.id]);
  s.payments = await q('SELECT sp.*, u.name AS user_name, po.po_no FROM supplier_payments sp JOIN users u ON u.id=sp.created_by LEFT JOIN purchase_orders po ON po.id=sp.po_id WHERE sp.supplier_id=? ORDER BY sp.id DESC LIMIT 100', [s.id]);
  // performance: how complete and how fast were deliveries
  s.performance = await one(`SELECT COUNT(*) AS orders, COALESCE(SUM(status='received'),0) AS fully_received, COALESCE(SUM(status='partial'),0) AS partial,
      ROUND(AVG(CASE WHEN received_at IS NOT NULL AND ordered_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR, ordered_at, received_at)/24 END),1) AS avg_days_to_receive,
      COALESCE(SUM(CASE WHEN status IN ('received','partial') AND expected_date IS NOT NULL AND DATE(received_at)>expected_date THEN 1 ELSE 0 END),0) AS late
      FROM purchase_orders WHERE supplier_id=? AND status<>'cancelled' AND status<>'draft'`, [s.id]);
  res.json(s);
}));

router.post('/suppliers/:id/payments', gate, wrap(async (req, res) => {
  const amount = money(req.body.amount, 0); if (!(amount > 0)) throw bad('Enter the amount paid');
  const method = ['cash', 'mobile_money', 'card', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  const s = await one(`SELECT s.id,s.name,(${BAL}) AS balance FROM suppliers s WHERE s.id=? AND s.business_id=?`, [req.params.id, req.biz.id]); if (!s) throw notFound('Supplier not found');
  if (amount > s.balance + 0.009 && req.body.allow_overpay !== true) throw bad(`That is more than the ${round2(s.balance)} owed. Tick "advance payment" to record it anyway.`);
  let po = null; if (req.body.po_id) { po = await one('SELECT id FROM purchase_orders WHERE id=? AND supplier_id=?', [int(req.body.po_id), s.id]); if (!po) throw bad('Unknown purchase order'); }
  const date = isDate(req.body.paid_date) ? req.body.paid_date : require('../lib/tz').today(req.biz);
  const r = await q('INSERT INTO supplier_payments (business_id,supplier_id,po_id,amount,method,reference,note,paid_date,created_by) VALUES (?,?,?,?,?,?,?,?,?)', [req.biz.id, s.id, po ? po.id : null, amount, method, clip(req.body.reference, 80) || null, clip(req.body.note, 255) || null, date, req.user.id]);
  await audit(req, { action: 'supplier.payment', entity: 'supplier', entity_id: s.id, details: { name: s.name, amount, method } });
  res.json({ id: r.insertId, balance: round2(s.balance - amount) });
}));

router.get('/payables', requireModule('suppliers'), can('suppliers.manage'), wrap(async (req, res) => {
  const rows = await q(`SELECT s.id,s.name,s.phone,(${BAL}) AS balance FROM suppliers s WHERE s.business_id=? AND s.status='active' HAVING balance>0.009 ORDER BY balance DESC`, [req.biz.id]);
  res.json({ rows, total: round2(rows.reduce((t, r) => t + r.balance, 0)) });
}));

// ---------- purchase orders ----------
async function readItems(conn, biz, items) {
  if (!Array.isArray(items) || !items.length) throw bad('Add at least one product');
  const out = []; const seen = new Set();
  for (const it of items) {
    const pid = int(it.product_id), qty = int(it.qty), cost = money(it.unit_cost, NaN);
    if (!pid || qty < 1 || qty > 100000 || !(cost >= 0)) throw bad('Check the product, quantity and cost on every line');
    if (seen.has(pid)) throw bad('A product appears twice. Combine the quantities.'); seen.add(pid);
    const [[p]] = await conn.query("SELECT id,name,track_stock FROM products WHERE id=? AND business_id=? AND status='active'", [pid, biz.id]);
    if (!p) throw bad('A selected product was not found'); if (!p.track_stock) throw bad(`"${p.name}" does not track stock`);
    out.push({ product_id: pid, name: p.name, qty, unit_cost: cost });
  }
  return out;
}
const poTotal = items => round2(items.reduce((t, i) => t + i.qty * i.unit_cost, 0));

router.get('/purchase-orders', gate, wrap(async (req, res) => {
  const w = ['po.business_id=?']; const a = [req.biz.id];
  if (['draft', 'ordered', 'partial', 'received', 'cancelled'].includes(req.query.status)) { w.push('po.status=?'); a.push(req.query.status); }
  if (req.query.status === 'open') w.push("po.status IN ('ordered','partial')");
  if (req.query.supplier) { w.push('po.supplier_id=?'); a.push(int(req.query.supplier)); }
  const rows = await q(`SELECT po.*, s.name AS supplier_name, u.name AS user_name, COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.po_id=po.id),0) AS paid,
      (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id=po.id) AS line_count FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN users u ON u.id=po.created_by
      WHERE ${w.join(' AND ')} ORDER BY po.id DESC LIMIT 200`, a);
  res.json(rows);
}));

router.get('/purchase-orders/:id', gate, wrap(async (req, res) => {
  const po = await one('SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=? AND po.business_id=?', [req.params.id, req.biz.id]);
  if (!po) throw notFound('Purchase order not found');
  po.items = await q('SELECT i.*, p.sku FROM purchase_order_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.po_id=? ORDER BY i.id', [po.id]);
  po.payments = await q('SELECT amount,method,paid_date,reference FROM supplier_payments WHERE po_id=? ORDER BY id', [po.id]);
  res.json(po);
}));

router.post('/purchase-orders', gate, wrap(async (req, res) => {
  const sup = await one("SELECT id FROM suppliers WHERE id=? AND business_id=? AND status='active'", [int(req.body.supplier_id), req.biz.id]); if (!sup) throw bad('Choose a supplier');
  const out = await tx(async conn => {
    const items = await readItems(conn, req.biz, req.body.items);
    await conn.query('UPDATE businesses SET next_po = LAST_INSERT_ID(next_po + 1) WHERE id=?', [req.biz.id]);
    const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const po_no = `${req.biz.code}-PO${String(seq).padStart(5, '0')}`;
    const ordered = req.body.status === 'ordered';
    const [r] = await conn.query('INSERT INTO purchase_orders (business_id,po_no,supplier_id,status,expected_date,notes,total,created_by,ordered_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.biz.id, po_no, sup.id, ordered ? 'ordered' : 'draft', isDate(req.body.expected_date) ? req.body.expected_date : null, clip(req.body.notes, 500) || null, poTotal(items), req.user.id, ordered ? new Date() : null]);
    for (const i of items) await conn.query('INSERT INTO purchase_order_items (po_id,product_id,name,qty_ordered,unit_cost) VALUES (?,?,?,?,?)', [r.insertId, i.product_id, i.name, i.qty, i.unit_cost]);
    await audit(req, { action: 'po.create', entity: 'po', entity_id: r.insertId, details: { po_no, total: poTotal(items), status: ordered ? 'ordered' : 'draft' }, conn });
    return { id: r.insertId, po_no };
  });
  res.json(out);
}));

router.put('/purchase-orders/:id', gate, wrap(async (req, res) => {
  await tx(async conn => {
    const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]);
    if (!po) throw notFound('Purchase order not found'); if (po.status !== 'draft') throw conflict('Only draft orders can be edited');
    const items = await readItems(conn, req.biz, req.body.items);
    await conn.query('DELETE FROM purchase_order_items WHERE po_id=?', [po.id]);
    for (const i of items) await conn.query('INSERT INTO purchase_order_items (po_id,product_id,name,qty_ordered,unit_cost) VALUES (?,?,?,?,?)', [po.id, i.product_id, i.name, i.qty, i.unit_cost]);
    await conn.query('UPDATE purchase_orders SET total=?, expected_date=?, notes=? WHERE id=?', [poTotal(items), isDate(req.body.expected_date) ? req.body.expected_date : null, clip(req.body.notes, 500) || null, po.id]);
    await audit(req, { action: 'po.update', entity: 'po', entity_id: po.id, details: { po_no: po.po_no }, conn });
  });
  res.json({ ok: true });
}));

router.post('/purchase-orders/:id/order', gate, wrap(async (req, res) => {
  const r = await q("UPDATE purchase_orders SET status='ordered', ordered_at=UTC_TIMESTAMP() WHERE id=? AND business_id=? AND status='draft'", [req.params.id, req.biz.id]);
  if (!r.affectedRows) throw conflict('Only a draft order can be placed');
  await audit(req, { action: 'po.ordered', entity: 'po', entity_id: int(req.params.id) }); res.json({ ok: true });
}));

router.post('/purchase-orders/:id/cancel', gate, wrap(async (req, res) => {
  const reason = clip(req.body.reason, 255); if (reason.length < 3) throw bad('Give a reason for cancelling');
  const po = await one('SELECT * FROM purchase_orders WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); if (!po) throw notFound('Purchase order not found');
  if (['received', 'cancelled'].includes(po.status) || po.status === 'partial') throw conflict('This order already has stock received and cannot be cancelled');
  await q("UPDATE purchase_orders SET status='cancelled', notes=CONCAT(COALESCE(notes,''),' [Cancelled: ',?,']') WHERE id=?", [reason, po.id]);
  await audit(req, { action: 'po.cancel', entity: 'po', entity_id: po.id, details: { po_no: po.po_no, reason } }); res.json({ ok: true });
}));

// Receiving writes permanent stock-ledger rows and re-averages the product's cost price.
router.post('/purchase-orders/:id/receive', gate, wrap(async (req, res) => {
  const lines = Array.isArray(req.body.items) ? req.body.items : []; if (!lines.length) throw bad('Enter the quantities received');
  const out = await tx(async conn => {
    const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]);
    if (!po) throw notFound('Purchase order not found'); if (!['ordered', 'partial'].includes(po.status)) throw conflict('This order is not waiting for stock');
    const [items] = await conn.query('SELECT * FROM purchase_order_items WHERE po_id=? ORDER BY id', [po.id]);
    let value = 0, units = 0; const low = [];
    for (const l of lines) {
      const it = items.find(x => x.id === int(l.item_id)); const qty = int(l.qty);
      if (!it) throw bad('Unknown line on this order'); if (qty < 0) throw bad('Quantity cannot be negative'); if (!qty) continue;
      if (it.qty_received + qty > it.qty_ordered) throw bad(`"${it.name}": only ${it.qty_ordered - it.qty_received} still expected`);
      const cost = l.unit_cost !== undefined && l.unit_cost !== '' ? money(l.unit_cost, NaN) : it.unit_cost; if (!(cost >= 0)) throw bad('Invalid unit cost');
      const [[p]] = await conn.query('SELECT * FROM products WHERE id=? AND business_id=? FOR UPDATE', [it.product_id, req.biz.id]); if (!p) throw bad(`"${it.name}" no longer exists`);
      const bal = p.stock_qty + qty; const avg = round2(((Math.max(p.stock_qty, 0) * p.cost_price) + qty * cost) / (Math.max(p.stock_qty, 0) + qty));
      const exp = isDate(l.expiry_date) ? l.expiry_date : null;
      const expNew = !exp ? p.expiry_date : (p.expiry_date && p.stock_qty > 0 && p.expiry_date < exp ? p.expiry_date : exp); // keep the earliest expiry that is still on the shelf
      await conn.query('UPDATE products SET stock_qty=?, cost_price=?, expiry_date=? WHERE id=?', [bal, avg, expNew, p.id]);
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,note,user_id) VALUES (?,?,'purchase',?,?,?,'po',?,?,?)", [req.biz.id, p.id, qty, bal, cost, po.id, `Received on ${po.po_no}`, req.user.id]);
      await conn.query('UPDATE purchase_order_items SET qty_received=qty_received+?, unit_cost=?, expiry_date=COALESCE(?,expiry_date) WHERE id=?', [qty, cost, exp, it.id]);
      value += qty * cost; units += qty;
    }
    if (!units) throw bad('Enter at least one received quantity');
    const [after] = await conn.query('SELECT qty_ordered, qty_received FROM purchase_order_items WHERE po_id=?', [po.id]);
    const done = after.every(i => i.qty_received >= i.qty_ordered);
    await conn.query('UPDATE purchase_orders SET status=?, received_value=received_value+?, received_at=UTC_TIMESTAMP() WHERE id=?', [done ? 'received' : 'partial', round2(value), po.id]);
    await audit(req, { action: 'po.receive', entity: 'po', entity_id: po.id, details: { po_no: po.po_no, units, value: round2(value), complete: done }, conn });
    return { status: done ? 'received' : 'partial', units, value: round2(value) };
  });
  rt.broadcast(req.biz.id, 'product.changed', {});
  res.json(out);
}));

module.exports = router;
