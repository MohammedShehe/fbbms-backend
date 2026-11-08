// Barber Shop module: services, barbers & commissions, appointments / walk-in queue, supplies used, dashboard, reports.
// Every completed service creates a normal `sales` row (sale_type='service'), so the central dashboard, finance and customer
// history all include it automatically.
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, canAny, requireModule, has } = require('../middleware/auth');
const { bad, conflict, forbidden, notFound, wrap, clip, int, money, round2, isDate, addDays, startOfMonth, phoneOk, normPhone } = require('../lib/util');
const { PAYMENTS, taxOf } = require('../lib/sales');
const customers = require('../lib/customers');
const modules = require('../lib/modules');
const tzu = require('../lib/tz');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');
const { notify } = require('../lib/notify');

router.use('/barber', requireModule('barber'));
const view = canAny('services.manage', 'appointments.manage', 'commissions.view', 'reports.view', 'sales.create');
const work = canAny('appointments.manage', 'services.manage');
const OPEN = ['booked', 'waiting', 'in_service'];
const timeOf = v => { if (v === undefined || v === null || v === '') return null; const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v)); if (!m || +m[1] > 23 || +m[2] > 59) throw bad('Enter a valid time (HH:MM)'); return `${m[1].padStart(2, '0')}:${m[2]}:00`; };
const secs = t => { const [h, m] = String(t).split(':'); return (+h) * 3600 + (+m) * 60; };
const changed = (req, d = {}) => rt.broadcast(req.biz.id, 'appointment.changed', d);

// ---------------------------------------------------------------- services
router.get('/barber/services', view, wrap(async (req, res) => {
  const all = req.query.all === '1' && has(req, 'services.manage');
  res.json(await q(`SELECT s.*, (SELECT COUNT(*) FROM appointments a WHERE a.service_id=s.id AND a.status='completed') AS done FROM barber_services s WHERE s.business_id=? ${all ? '' : "AND s.status='active'"} ORDER BY s.sort_order, s.name`, [req.biz.id]));
}));
const serviceBody = (b, cur = {}) => {
  const name = clip(b.name !== undefined ? b.name : cur.name, 120); if (name.length < 2) throw bad('Enter the service name');
  const price = b.price !== undefined ? money(b.price, NaN) : Number(cur.price || 0); if (!(price >= 0) || price > 100000000) throw bad('Enter a valid price');
  const duration = b.duration_min !== undefined ? int(b.duration_min, 0) : Number(cur.duration_min || 30); if (duration < 5 || duration > 600) throw bad('Duration must be between 5 and 600 minutes');
  const status = ['active', 'inactive'].includes(b.status) ? b.status : (cur.status || 'active');
  return { name, price, duration, status };
};
router.post('/barber/services', can('services.manage'), wrap(async (req, res) => {
  const d = serviceBody(req.body);
  try { const r = await q('INSERT INTO barber_services (business_id,name,price,duration_min,status) VALUES (?,?,?,?,?)', [req.biz.id, d.name, d.price, d.duration, d.status]); await audit(req, { action: 'service.create', entity: 'service', entity_id: r.insertId, details: d }); res.json({ id: r.insertId }); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('You already have a service with that name'); throw e; }
}));
router.put('/barber/services/:id', can('services.manage'), wrap(async (req, res) => {
  const s = await one('SELECT * FROM barber_services WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!s) throw notFound('Service not found');
  const d = serviceBody(req.body, s);
  try { await q('UPDATE barber_services SET name=?, price=?, duration_min=?, status=? WHERE id=?', [d.name, d.price, d.duration, d.status, s.id]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('You already have a service with that name'); throw e; }
  await audit(req, { action: 'service.update', entity: 'service', entity_id: s.id, details: { from: { name: s.name, price: s.price, duration: s.duration_min }, to: d } });
  res.json({ ok: true });
}));
router.delete('/barber/services/:id', can('services.manage'), wrap(async (req, res) => {
  const s = await one('SELECT * FROM barber_services WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!s) throw notFound('Service not found');
  const used = await one('SELECT COUNT(*) AS n FROM appointments WHERE service_id=? AND business_id=?', [s.id, req.biz.id]);
  if (used.n) { await q("UPDATE barber_services SET status='inactive' WHERE id=?", [s.id]); await audit(req, { action: 'service.deactivate', entity: 'service', entity_id: s.id, details: { name: s.name } }); return res.json({ ok: true, deactivated: true }); }
  await q('DELETE FROM barber_services WHERE id=?', [s.id]); await audit(req, { action: 'service.delete', entity: 'service', entity_id: s.id, details: { name: s.name } });
  res.json({ ok: true, deleted: true });
}));

// ---------------------------------------------------------------- barbers
router.get('/barber/barbers', view, wrap(async (req, res) => {
  const all = req.query.all === '1' && has(req, 'services.manage');
  res.json(await q(`SELECT * FROM barbers WHERE business_id=? ${all ? '' : "AND status='active'"} ORDER BY status, name`, [req.biz.id]));
}));
const barberBody = (b, cur = {}, biz) => {
  const name = clip(b.name !== undefined ? b.name : cur.name, 120); if (name.length < 2) throw bad('Enter the barber\'s name');
  const phone = b.phone !== undefined ? clip(b.phone, 30) || null : (cur.phone || null); if (phone && !phoneOk(phone)) throw bad('Enter a valid phone number');
  const dflt = Number(biz.settings.default_commission_pct) || 0;
  const pct = b.commission_pct !== undefined && b.commission_pct !== '' ? Number(b.commission_pct) : (cur.commission_pct !== undefined ? Number(cur.commission_pct) : dflt);
  if (!(pct >= 0 && pct <= 100)) throw bad('Commission must be between 0 and 100%');
  return { name, phone: phone ? normPhone(phone) : null, pct: round2(pct), status: ['active', 'inactive'].includes(b.status) ? b.status : (cur.status || 'active'), notes: b.notes !== undefined ? clip(b.notes, 255) || null : (cur.notes || null) };
};
router.post('/barber/barbers', can('services.manage'), wrap(async (req, res) => {
  const d = barberBody(req.body, {}, req.biz);
  const r = await q('INSERT INTO barbers (business_id,name,phone,commission_pct,status,notes) VALUES (?,?,?,?,?,?)', [req.biz.id, d.name, d.phone, d.pct, d.status, d.notes]);
  await audit(req, { action: 'barber.create', entity: 'barber', entity_id: r.insertId, details: { name: d.name, commission_pct: d.pct } }); res.json({ id: r.insertId });
}));
router.put('/barber/barbers/:id', can('services.manage'), wrap(async (req, res) => {
  const b = await one('SELECT * FROM barbers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!b) throw notFound('Barber not found');
  const d = barberBody(req.body, b, req.biz);
  await q('UPDATE barbers SET name=?, phone=?, commission_pct=?, status=?, notes=? WHERE id=?', [d.name, d.phone, d.pct, d.status, d.notes, b.id]);
  await audit(req, { action: 'barber.update', entity: 'barber', entity_id: b.id, details: { from: { commission_pct: b.commission_pct, status: b.status }, to: { commission_pct: d.pct, status: d.status } } }); res.json({ ok: true });
}));

// ---------------------------------------------------------------- customers (visit history + preferences)
router.get('/barber/customers/search', work, wrap(async (req, res) => {
  const s = `%${clip(req.query.q, 60)}%`; if (clip(req.query.q, 60).length < 2) return res.json([]);
  res.json(await q(`SELECT c.id,c.name,c.phone,c.notes, (SELECT COUNT(*) FROM sales x WHERE x.customer_id=c.id AND x.status='completed' AND x.sale_type='service') AS visits FROM customers c WHERE c.business_id=? AND c.status='active' AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT 8`, [req.biz.id, s, s]));
}));
router.get('/barber/customers/:id', view, wrap(async (req, res) => {
  const c = await one('SELECT id,name,phone,email,notes,birthday,created_at FROM customers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!c) throw notFound('Customer not found');
  const visits = await q(`SELECT s.id AS sale_id, s.receipt_no, s.sale_date, s.sold_at, s.total, s.payment_method, s.status, b.name AS barber, (SELECT GROUP_CONCAT(i.name SEPARATOR ', ') FROM sale_items i WHERE i.sale_id=s.id) AS services
    FROM sales s LEFT JOIN barbers b ON b.id=s.barber_id WHERE s.business_id=? AND s.customer_id=? AND s.status='completed' ORDER BY s.id DESC LIMIT 100`, [req.biz.id, c.id]);
  const upcoming = await q("SELECT id,appt_date,appt_time,service_name,status FROM appointments WHERE business_id=? AND customer_id=? AND status IN ('booked','waiting','in_service') ORDER BY appt_date, appt_time LIMIT 10", [req.biz.id, c.id]);
  const missed = await one("SELECT COALESCE(SUM(status='missed'),0) AS missed, COALESCE(SUM(status='cancelled'),0) AS cancelled FROM appointments WHERE business_id=? AND customer_id=?", [req.biz.id, c.id]);
  const byService = await q(`SELECT i.name, COUNT(*) AS times, SUM(i.line_total) AS spent FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.customer_id=? AND s.status='completed' AND s.sale_type='service' GROUP BY i.name ORDER BY times DESC`, [req.biz.id, c.id]);
  res.json({ customer: c, visits, upcoming, by_service: byService, visit_count: visits.length, total_spent: round2(visits.reduce((a, v) => a + Number(v.total), 0)), last_visit: visits[0] ? visits[0].sale_date : null, missed: Number(missed.missed), cancelled: Number(missed.cancelled) });
}));
router.put('/barber/customers/:id/notes', work, wrap(async (req, res) => {
  const c = await one('SELECT id FROM customers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!c) throw notFound('Customer not found');
  await q('UPDATE customers SET notes=? WHERE id=?', [clip(req.body.notes, 500) || null, c.id]); res.json({ ok: true });
}));

// ---------------------------------------------------------------- appointments + walk-in queue
const apptSelect = `SELECT a.*, b.name AS barber_name, c.notes AS customer_notes, s.receipt_no, s.total AS sale_total
  FROM appointments a LEFT JOIN barbers b ON b.id=a.barber_id LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN sales s ON s.id=a.sale_id`;

router.get('/barber/queue', view, wrap(async (req, res) => {
  const day = isDate(req.query.date) ? req.query.date : tzu.today(req.biz);
  const rows = await q(`${apptSelect} WHERE a.business_id=? AND a.appt_date=? ORDER BY FIELD(a.status,'in_service','waiting','booked','completed','missed','cancelled'), COALESCE(a.queue_no, 9999), a.appt_time, a.id`, [req.biz.id, day]);
  const count = st => rows.filter(r => r.status === st).length;
  res.json({ date: day, rows, summary: { waiting: count('waiting'), in_service: count('in_service'), booked: count('booked'), completed: count('completed'), cancelled: count('cancelled'), missed: count('missed'), total: rows.length } });
}));

router.get('/barber/appointments', view, wrap(async (req, res) => {
  const w = ['a.business_id=?']; const a = [req.biz.id];
  if (isDate(req.query.from)) { w.push('a.appt_date>=?'); a.push(req.query.from); }
  if (isDate(req.query.to)) { w.push('a.appt_date<=?'); a.push(req.query.to); }
  if (['booked', 'waiting', 'in_service', 'completed', 'cancelled', 'missed'].includes(req.query.status)) { w.push('a.status=?'); a.push(req.query.status); }
  if (['appointment', 'walkin'].includes(req.query.kind)) { w.push('a.kind=?'); a.push(req.query.kind); }
  if (int(req.query.barber_id)) { w.push('a.barber_id=?'); a.push(int(req.query.barber_id)); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(a.customer_name LIKE ? OR a.customer_phone LIKE ? OR a.service_name LIKE ?)'); a.push(s, s, s); }
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(200, Math.max(1, int(req.query.limit, 30)));
  const total = (await one(`SELECT COUNT(*) AS n FROM appointments a WHERE ${w.join(' AND ')}`, a)).n;
  const rows = await q(`${apptSelect} WHERE ${w.join(' AND ')} ORDER BY a.appt_date DESC, a.appt_time DESC, a.id DESC LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  res.json({ rows, total, page, limit });
}));

async function checkBarberFree(conn, biz, { barber_id, date, time, duration, exceptId = 0 }) {
  if (!barber_id || !time) return;
  const start = secs(time), end = start + duration * 60;
  const [rows] = await conn.query("SELECT customer_name, appt_time, duration_min FROM appointments WHERE business_id=? AND barber_id=? AND appt_date=? AND status IN ('booked','waiting','in_service') AND appt_time IS NOT NULL AND id<>? AND TIME_TO_SEC(appt_time) < ? AND TIME_TO_SEC(appt_time) + duration_min*60 > ? LIMIT 1", [biz.id, barber_id, date, exceptId, end, start]);
  if (rows.length) throw conflict(`That barber is already booked at ${String(rows[0].appt_time).slice(0, 5)} (${rows[0].customer_name}). Pick another time or barber.`);
}

async function resolveParts(conn, req, b) {
  const biz = req.biz;
  const [[svc]] = await conn.query('SELECT * FROM barber_services WHERE id=? AND business_id=?', [int(b.service_id), biz.id]);
  if (!svc || svc.status !== 'active') throw bad('Choose one of your services');
  let barber = null;
  if (int(b.barber_id)) { [[barber]] = await conn.query("SELECT * FROM barbers WHERE id=? AND business_id=? AND status='active'", [int(b.barber_id), biz.id]); if (!barber) throw bad('Choose an active barber'); }
  const name = clip(b.customer_name, 120); if (name.length < 2) throw bad('Enter the customer name');
  const phone = clip(b.customer_phone, 30); if (phone && !phoneOk(phone)) throw bad('Enter a valid phone number');
  let cust = null;
  if (modules.enabled(biz, 'customers') && (b.customer_id || phone)) cust = await customers.resolve(conn, biz, { id: b.customer_id, name, phone, source: 'pos', lock: true });
  return { svc, barber, name: cust ? (name || cust.name) : name, phone: phone ? normPhone(phone) : (cust ? cust.phone : null), cust };
}

router.post('/barber/appointments', can('appointments.manage'), wrap(async (req, res) => {
  const kind = req.body.kind === 'appointment' ? 'appointment' : 'walkin';
  const today = tzu.today(req.biz);
  const date = kind === 'walkin' ? today : req.body.appt_date; if (!isDate(date)) throw bad('Choose the appointment date');
  if (date < today) throw bad('The appointment date cannot be in the past');
  const time = kind === 'appointment' ? timeOf(req.body.appt_time) : timeOf(req.body.appt_time);
  if (kind === 'appointment' && !time) throw bad('Choose the appointment time');
  const out = await tx(async conn => {
    await conn.query('SELECT id FROM businesses WHERE id=? FOR UPDATE', [req.biz.id]);
    const P = await resolveParts(conn, req, req.body);
    await checkBarberFree(conn, req.biz, { barber_id: P.barber && P.barber.id, date, time, duration: P.svc.duration_min });
    let queue = null; if (kind === 'walkin') { const [[m]] = await conn.query('SELECT COALESCE(MAX(queue_no),0)+1 AS n FROM appointments WHERE business_id=? AND appt_date=?', [req.biz.id, date]); queue = m.n; }
    const [r] = await conn.query('INSERT INTO appointments (business_id,customer_id,customer_name,customer_phone,service_id,service_name,barber_id,kind,appt_date,appt_time,queue_no,status,price,duration_min,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.biz.id, P.cust ? P.cust.id : null, P.name, P.phone, P.svc.id, P.svc.name, P.barber ? P.barber.id : null, kind, date, time, queue, kind === 'walkin' ? 'waiting' : 'booked', P.svc.price, P.svc.duration_min, clip(req.body.notes, 255) || null, req.user.id]);
    await audit(req, { action: kind === 'walkin' ? 'walkin.create' : 'appointment.create', entity: 'appointment', entity_id: r.insertId, details: { customer: P.name, service: P.svc.name, date, time }, conn });
    return { id: r.insertId, queue_no: queue };
  });
  changed(req, { id: out.id }); res.json(out);
}));

router.put('/barber/appointments/:id', can('appointments.manage'), wrap(async (req, res) => {
  const a = await one('SELECT * FROM appointments WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!a) throw notFound('Appointment not found');
  if (!OPEN.includes(a.status)) throw conflict('This visit is already closed and can no longer be edited');
  const date = req.body.appt_date !== undefined ? req.body.appt_date : a.appt_date; if (!isDate(date)) throw bad('Choose a valid date');
  const time = req.body.appt_time !== undefined ? timeOf(req.body.appt_time) : a.appt_time;
  await tx(async conn => {
    await conn.query('SELECT id FROM businesses WHERE id=? FOR UPDATE', [req.biz.id]);
    const P = await resolveParts(conn, req, { service_id: req.body.service_id || a.service_id, barber_id: req.body.barber_id !== undefined ? req.body.barber_id : a.barber_id, customer_name: req.body.customer_name || a.customer_name, customer_phone: req.body.customer_phone !== undefined ? req.body.customer_phone : a.customer_phone, customer_id: a.customer_id });
    await checkBarberFree(conn, req.biz, { barber_id: P.barber && P.barber.id, date, time, duration: P.svc.duration_min, exceptId: a.id });
    const price = P.svc.id === a.service_id ? a.price : P.svc.price;
    await conn.query('UPDATE appointments SET customer_id=?, customer_name=?, customer_phone=?, service_id=?, service_name=?, barber_id=?, appt_date=?, appt_time=?, price=?, duration_min=?, notes=? WHERE id=?',
      [P.cust ? P.cust.id : a.customer_id, P.name, P.phone, P.svc.id, P.svc.name, P.barber ? P.barber.id : null, date, time, price, P.svc.duration_min, req.body.notes !== undefined ? clip(req.body.notes, 255) || null : a.notes, a.id]);
    await audit(req, { action: 'appointment.update', entity: 'appointment', entity_id: a.id, details: { date, time, service: P.svc.name }, conn });
  });
  changed(req, { id: a.id }); res.json({ ok: true });
}));

const FLOW = { booked: ['waiting', 'cancelled', 'missed'], waiting: ['in_service', 'cancelled', 'missed'], in_service: ['waiting', 'cancelled'] };
router.post('/barber/appointments/:id/status', can('appointments.manage'), wrap(async (req, res) => {
  const to = req.body.status;
  await tx(async conn => {
    const [[a]] = await conn.query('SELECT * FROM appointments WHERE id=? AND business_id=? FOR UPDATE', [int(req.params.id), req.biz.id]); if (!a) throw notFound('Appointment not found');
    if (!(FLOW[a.status] || []).includes(to)) throw conflict(`A ${a.status.replace('_', ' ')} visit cannot be changed to ${String(to).replace('_', ' ')}`);
    if (int(req.body.barber_id) && int(req.body.barber_id) !== a.barber_id) { const [[b]] = await conn.query("SELECT id FROM barbers WHERE id=? AND business_id=? AND status='active'", [int(req.body.barber_id), req.biz.id]); if (!b) throw bad('Choose an active barber'); await conn.query('UPDATE appointments SET barber_id=? WHERE id=?', [b.id, a.id]); }
    let queue = a.queue_no;
    if (to === 'waiting' && !queue) { await conn.query('SELECT id FROM businesses WHERE id=? FOR UPDATE', [req.biz.id]); const [[m]] = await conn.query('SELECT COALESCE(MAX(queue_no),0)+1 AS n FROM appointments WHERE business_id=? AND appt_date=?', [req.biz.id, a.appt_date]); queue = m.n; }
    await conn.query('UPDATE appointments SET status=?, queue_no=?, notes=? WHERE id=?', [to, queue, to === 'cancelled' && req.body.reason ? clip(`Cancelled: ${req.body.reason}`, 255) : a.notes, a.id]);
    await audit(req, { action: 'appointment.' + to, entity: 'appointment', entity_id: a.id, details: { customer: a.customer_name, service: a.service_name }, conn });
  });
  changed(req, { id: int(req.params.id) }); res.json({ ok: true });
}));

/** Takes products out of stock as "used" (supplies). Returns the products that are now low. Runs inside the caller's transaction. */
async function consumeStock(conn, biz, userId, items, ctx = {}) {
  const merged = new Map();
  for (const it of items || []) { const pid = int(it.product_id), qty = int(it.qty); if (!pid || qty < 1 || qty > 100000) throw bad('Invalid product or quantity'); merged.set(pid, (merged.get(pid) || 0) + qty); }
  const low = []; const day = ctx.date || tzu.today(biz);
  for (const pid of [...merged.keys()].sort((a, b) => a - b)) {
    const qty = merged.get(pid);
    const [[p]] = await conn.query("SELECT * FROM products WHERE id=? AND business_id=? AND status='active' FOR UPDATE", [pid, biz.id]); if (!p) throw bad('A selected product is no longer available');
    if (p.track_stock && p.stock_qty < qty) throw conflict(`Only ${p.stock_qty} left of "${p.name}"`, { product_id: p.id, available: p.stock_qty });
    const bal = p.track_stock ? p.stock_qty - qty : p.stock_qty;
    if (p.track_stock) { await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [bal, p.id]); await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,note,user_id) VALUES (?,?,'usage',?,?,?,'usage',?,?,?)", [biz.id, p.id, -qty, bal, p.cost_price, ctx.appointment_id || null, clip(ctx.note, 200) || 'Used in the shop', userId]); }
    await conn.query('INSERT INTO product_usage (business_id,product_id,qty,barber_id,appointment_id,used_on,note,created_by) VALUES (?,?,?,?,?,?,?,?)', [biz.id, p.id, qty, ctx.barber_id || null, ctx.appointment_id || null, day, clip(ctx.note, 255) || null, userId]);
    if (p.track_stock && bal <= p.low_stock_at) low.push({ id: p.id, name: p.name, stock_qty: bal, low_stock_at: p.low_stock_at });
  }
  return low;
}
async function lowAlerts(req, low) {
  const today = tzu.today(req.biz);
  for (const p of low) { rt.broadcast(req.biz.id, 'stock.low', p); await notify(req.biz, { type: 'stock.low', severity: p.stock_qty <= 0 ? 'warn' : 'info', audience: 'all', title: p.stock_qty <= 0 ? `${p.name} is out of stock` : `Low stock: ${p.name} (${p.stock_qty} left)`, dedupe: `low:${p.id}:${today}` }); }
  if (low.length) rt.broadcast(req.biz.id, 'product.changed', {});
}

router.post('/barber/appointments/:id/complete', can('appointments.manage'), wrap(async (req, res) => {
  const isSuper = req.member.role === 'super_admin'; const perms = req.member.permissions; const biz = req.biz;
  const method = PAYMENTS.includes(req.body.payment_method) ? req.body.payment_method : null; if (!method) throw bad('Choose how the customer paid');
  const result = await tx(async conn => {
    const [[a]] = await conn.query('SELECT * FROM appointments WHERE id=? AND business_id=? FOR UPDATE', [int(req.params.id), biz.id]); if (!a) throw notFound('Appointment not found');
    if (!OPEN.includes(a.status)) throw conflict('This visit is already closed');
    // price
    let price = a.price;
    if (req.body.price !== undefined && req.body.price !== '' && money(req.body.price, NaN) !== Number(a.price)) {
      if (Number(a.price) > 0 && !(isSuper || perms.has('sales.price_override'))) throw forbidden('You are not allowed to change the service price');
      price = money(req.body.price, NaN);
    }
    if (!(price > 0)) throw bad('Set the service price before completing (this service has no price yet)');
    let discount = money(req.body.discount, 0); if (discount < 0) throw bad('Invalid discount');
    if (discount > 0) {
      if (!(isSuper || perms.has('sales.discount'))) throw forbidden('You are not allowed to give discounts');
      if (discount > price) throw bad('Discount cannot exceed the service price');
      const cap = Number(biz.settings.max_discount_pct ?? 15); if (!isSuper && discount > round2(price * cap / 100)) throw forbidden(`Discount is limited to ${cap}% of the service`);
    }
    const T = taxOf(biz, round2(price - discount)); const total = T.total;
    // barber + commission
    const barberId = int(req.body.barber_id) || a.barber_id || null; let barber = null;
    if (barberId) { [[barber]] = await conn.query('SELECT * FROM barbers WHERE id=? AND business_id=?', [barberId, biz.id]); if (!barber) throw bad('Choose a valid barber'); }
    const pct = barber ? Number(barber.commission_pct) : 0; const commission = round2((total - T.tax) * pct / 100);
    // customer
    let cust = null; if (modules.enabled(biz, 'customers') && (a.customer_id || a.customer_phone)) cust = await customers.resolve(conn, biz, { id: a.customer_id, name: a.customer_name, phone: a.customer_phone, source: 'pos', lock: true });
    const L = customers.loyalty(biz); const points = L.on && cust ? Math.floor(total / L.per) : 0;
    // receipt
    await conn.query('UPDATE businesses SET next_receipt = LAST_INSERT_ID(next_receipt + 1) WHERE id=?', [biz.id]); const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const receipt = `${biz.code}-${String(seq).padStart(6, '0')}`; const now = new Date(); const day = tzu.today(biz);
    const [ins] = await conn.query(`INSERT INTO sales (business_id,receipt_no,source,customer_id,customer_name,customer_phone,payment_method,subtotal,discount,total,tax_amount,cost_total,profit,amount_paid,paid_status,points_earned,notes,sold_by,sold_at,sale_date,sale_type,barber_id,commission_pct,commission_amount,appointment_id)
      VALUES (?,?,'pos',?,?,?,?,?,?,?,?,0,?,?,'paid',?,?,?,?,?,'service',?,?,?,?)`,
      [biz.id, receipt, cust ? cust.id : null, a.customer_name, a.customer_phone, method, price, discount, total, T.tax, round2(total - T.tax), total, points, clip(req.body.notes, 255) || null, req.user.id, now, day, barber ? barber.id : null, pct, commission, a.id]);
    const saleId = ins.insertId;
    await conn.query("INSERT INTO sale_items (sale_id,product_id,name,sku,category,qty,list_price,unit_price,unit_cost,line_total) VALUES (?,NULL,?,NULL,'Service',1,?,?,0,?)", [saleId, a.service_name, a.price || price, price, price]);
    if (total > 0) await conn.query('INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [biz.id, saleId, cust ? cust.id : null, method, total, clip(req.body.reference, 80) || null, req.user.id, now]);
    if (cust && points) await customers.addPoints(conn, biz.id, cust.id, points, `Earned on ${receipt}`, 'sale', saleId, req.user.id);
    const low = await consumeStock(conn, biz, req.user.id, req.body.products_used, { barber_id: barber ? barber.id : null, appointment_id: a.id, date: day, note: `Used for ${a.service_name}` });
    await conn.query("UPDATE appointments SET status='completed', sale_id=?, customer_id=?, barber_id=?, price=? WHERE id=?", [saleId, cust ? cust.id : a.customer_id, barber ? barber.id : null, price, a.id]);
    return { id: saleId, receipt_no: receipt, total, discount, tax: T.tax, commission, commission_pct: pct, barber: barber ? barber.name : null, low, customer: a.customer_name };
  });
  await audit(req, { action: 'sale.create', entity: 'sale', entity_id: result.id, details: { receipt: result.receipt_no, total: result.total, service: true } });
  rt.broadcast(req.biz.id, 'sale.new', { id: result.id, receipt_no: result.receipt_no, total: result.total, by: req.user.name, by_id: req.user.id, discount: result.discount });
  changed(req, { id: int(req.params.id) }); await lowAlerts(req, result.low); delete result.low;
  res.json(result);
}));

// ---------------------------------------------------------------- supplies used (stock goes down automatically)
router.get('/barber/supplies', canAny('appointments.manage', 'stock.adjust'), wrap(async (req, res) => {
  res.json(await q("SELECT id,name,stock_qty,low_stock_at,track_stock FROM products WHERE business_id=? AND status='active' AND track_stock=1 ORDER BY name", [req.biz.id]));
}));
router.get('/barber/usage', canAny('appointments.manage', 'stock.adjust', 'products.view', 'reports.view'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : addDays(today, -29); const to = isDate(req.query.to) ? req.query.to : today;
  const w = ['u.business_id=?', 'u.used_on BETWEEN ? AND ?']; const a = [req.biz.id, from, to]; if (int(req.query.product_id)) { w.push('u.product_id=?'); a.push(int(req.query.product_id)); }
  const rows = await q(`SELECT u.id,u.qty,u.used_on,u.note,u.created_at,p.name AS product,p.id AS product_id,b.name AS barber,us.name AS by_name FROM product_usage u JOIN products p ON p.id=u.product_id LEFT JOIN barbers b ON b.id=u.barber_id LEFT JOIN users us ON us.id=u.created_by WHERE ${w.join(' AND ')} ORDER BY u.id DESC LIMIT 300`, a);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const summary = await q(`SELECT p.id,p.name,p.stock_qty,p.low_stock_at,p.track_stock, COALESCE(SUM(u.qty),0) AS used, COUNT(u.id) AS times, MAX(u.used_on) AS last_used
     FROM products p LEFT JOIN product_usage u ON u.product_id=p.id AND u.used_on BETWEEN ? AND ? WHERE p.business_id=? AND p.status='active' AND p.track_stock=1 GROUP BY p.id,p.name,p.stock_qty,p.low_stock_at,p.track_stock ORDER BY used DESC, p.name`, [from, to, req.biz.id]);
  summary.forEach(s => { s.per_day = round2(Number(s.used) / days); s.days_left = Number(s.used) > 0 ? Math.floor(s.stock_qty / (Number(s.used) / days)) : null; s.low = s.stock_qty <= s.low_stock_at; });
  res.json({ from, to, days, rows, summary });
}));
router.post('/barber/usage', canAny('appointments.manage', 'stock.adjust'), wrap(async (req, res) => {
  const barberId = int(req.body.barber_id) || null; const day = isDate(req.body.used_on) ? req.body.used_on : tzu.today(req.biz); if (day > tzu.today(req.biz)) throw bad('The date cannot be in the future');
  const low = await tx(async conn => {
    if (barberId) { const [[b]] = await conn.query('SELECT id FROM barbers WHERE id=? AND business_id=?', [barberId, req.biz.id]); if (!b) throw bad('Choose a valid barber'); }
    const l = await consumeStock(conn, req.biz, req.user.id, [{ product_id: req.body.product_id, qty: req.body.qty }], { barber_id: barberId, date: day, note: req.body.note });
    await audit(req, { action: 'stock.usage', entity: 'product', entity_id: int(req.body.product_id), details: { qty: int(req.body.qty), note: clip(req.body.note, 120) }, conn });
    return l;
  });
  await lowAlerts(req, low); res.json({ ok: true, low });
}));

// ---------------------------------------------------------------- commissions
const SRV = "s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date BETWEEN ? AND ?";
router.get('/barber/commissions', canAny('commissions.view', 'reports.view'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today;
  const rows = await q(`SELECT b.id,b.name,b.commission_pct,b.status,
     (SELECT COUNT(*) FROM sales s WHERE ${SRV} AND s.barber_id=b.id) AS services,
     (SELECT COALESCE(SUM(s.total - s.tax_amount),0) FROM sales s WHERE ${SRV} AND s.barber_id=b.id) AS revenue,
     (SELECT COALESCE(SUM(s.commission_amount),0) FROM sales s WHERE ${SRV} AND s.barber_id=b.id) AS earned,
     (SELECT COALESCE(SUM(s.commission_amount),0) FROM sales s WHERE s.business_id=b.business_id AND s.status='completed' AND s.barber_id=b.id) AS earned_all,
     (SELECT COALESCE(SUM(p.amount),0) FROM commission_payouts p WHERE p.business_id=b.business_id AND p.barber_id=b.id) AS paid_all,
     (SELECT COALESCE(SUM(p.amount),0) FROM commission_payouts p WHERE p.business_id=b.business_id AND p.barber_id=b.id AND p.paid_on BETWEEN ? AND ?) AS paid_range
     FROM barbers b WHERE b.business_id=? ORDER BY earned DESC, b.name`, [req.biz.id, from, to, req.biz.id, from, to, req.biz.id, from, to, req.biz.id, from, to, req.biz.id]);
  rows.forEach(r => { r.owing = round2(Number(r.earned_all) - Number(r.paid_all)); r.avg_ticket = r.services ? round2(Number(r.revenue) / r.services) : 0; });
  const unassigned = await one(`SELECT COUNT(*) AS services, COALESCE(SUM(s.total - s.tax_amount),0) AS revenue FROM sales s WHERE ${SRV} AND s.barber_id IS NULL`, [req.biz.id, from, to]);
  res.json({ from, to, rows, unassigned, totals: { services: rows.reduce((a, r) => a + r.services, 0), revenue: round2(rows.reduce((a, r) => a + Number(r.revenue), 0)), earned: round2(rows.reduce((a, r) => a + Number(r.earned), 0)), owing: round2(rows.reduce((a, r) => a + r.owing, 0)) } });
}));
router.get('/barber/commissions/:id', canAny('commissions.view', 'reports.view'), wrap(async (req, res) => {
  const b = await one('SELECT * FROM barbers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!b) throw notFound('Barber not found');
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today;
  const sales = await q(`SELECT s.id,s.receipt_no,s.sale_date,s.customer_name,s.total,s.tax_amount,s.commission_pct,s.commission_amount,(SELECT GROUP_CONCAT(i.name SEPARATOR ', ') FROM sale_items i WHERE i.sale_id=s.id) AS service FROM sales s WHERE ${SRV} AND s.barber_id=? ORDER BY s.id DESC LIMIT 500`, [req.biz.id, from, to, b.id]);
  const payouts = await q('SELECT p.*, u.name AS by_name FROM commission_payouts p LEFT JOIN users u ON u.id=p.created_by WHERE p.business_id=? AND p.barber_id=? ORDER BY p.paid_on DESC, p.id DESC LIMIT 100', [req.biz.id, b.id]);
  res.json({ barber: b, from, to, sales, payouts });
}));
router.post('/barber/commissions/payout', can('services.manage'), wrap(async (req, res) => {
  const b = await one('SELECT * FROM barbers WHERE id=? AND business_id=?', [int(req.body.barber_id), req.biz.id]); if (!b) throw bad('Choose a barber');
  const amount = money(req.body.amount, NaN); if (!(amount > 0)) throw bad('Enter the amount paid');
  const paidOn = isDate(req.body.paid_on) ? req.body.paid_on : tzu.today(req.biz); if (paidOn > tzu.today(req.biz)) throw bad('The payment date cannot be in the future');
  const owing = await one("SELECT (SELECT COALESCE(SUM(commission_amount),0) FROM sales WHERE business_id=? AND status='completed' AND barber_id=?) - (SELECT COALESCE(SUM(amount),0) FROM commission_payouts WHERE business_id=? AND barber_id=?) AS v", [req.biz.id, b.id, req.biz.id, b.id]);
  if (amount > round2(owing.v) + 0.009) throw bad(`That is more than the ${round2(owing.v)} currently owed to ${b.name}`);
  const r = await q('INSERT INTO commission_payouts (business_id,barber_id,amount,method,paid_on,note,created_by) VALUES (?,?,?,?,?,?,?)', [req.biz.id, b.id, amount, clip(req.body.method, 20) || 'cash', paidOn, clip(req.body.note, 255) || null, req.user.id]);
  await audit(req, { action: 'commission.payout', entity: 'barber', entity_id: b.id, details: { name: b.name, amount, paid_on: paidOn } }); res.json({ id: r.insertId });
}));

// ---------------------------------------------------------------- dashboard
router.get('/barber/dashboard', view, wrap(async (req, res) => {
  const B = req.biz.id; const today = tzu.today(req.biz); const mtd = startOfMonth(today); const full = has(req, 'reports.view'); const d14 = addDays(today, -13);
  const queue = await one("SELECT COALESCE(SUM(status='waiting'),0) AS waiting, COALESCE(SUM(status='in_service'),0) AS in_service, COALESCE(SUM(status='booked'),0) AS booked, COALESCE(SUM(status='completed'),0) AS completed, COALESCE(SUM(status='cancelled'),0) AS cancelled, COALESCE(SUM(status='missed'),0) AS missed FROM appointments WHERE business_id=? AND appt_date=?", [B, today]);
  const next = await q(`${apptSelect} WHERE a.business_id=? AND a.appt_date=? AND a.status IN ('booked','waiting','in_service') ORDER BY FIELD(a.status,'in_service','waiting','booked'), COALESCE(a.queue_no,9999), a.appt_time LIMIT 8`, [B, today]);
  const low = await q("SELECT id,name,stock_qty,low_stock_at FROM products WHERE business_id=? AND status='active' AND track_stock=1 AND stock_qty<=low_stock_at ORDER BY stock_qty LIMIT 8", [B]);
  const out = { today, queue, next, low_stock: low, full, unpriced: (await one("SELECT COUNT(*) AS n FROM barber_services WHERE business_id=? AND status='active' AND price<=0", [B])).n };
  if (full) {
    const m = await one(`SELECT COALESCE(SUM(IF(s.sale_date=?,s.total,0)),0) AS sales_today, COALESCE(SUM(IF(s.sale_date=? AND s.sale_type='service',1,0)),0) AS customers_today, COALESCE(SUM(IF(s.sale_date=?,s.profit,0)),0) AS gross_today, COALESCE(SUM(IF(s.sale_date=?,s.commission_amount,0)),0) AS commission_today,
        COALESCE(SUM(s.total),0) AS revenue_month, COALESCE(SUM(s.profit),0) AS gross_month, COALESCE(SUM(s.commission_amount),0) AS commission_month FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ?`, [today, today, today, today, B, mtd, today]);
    const ex = await one("SELECT COALESCE(SUM(IF(expense_date=?,amount,0)),0) AS today, COALESCE(SUM(amount),0) AS month FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ?", [today, B, mtd, today]);
    const pop = await one("SELECT i.name, COUNT(*) AS times, SUM(i.line_total) AS revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date BETWEEN ? AND ? GROUP BY i.name ORDER BY times DESC, revenue DESC LIMIT 1", [B, mtd, today])
      || await one("SELECT i.name, COUNT(*) AS times, SUM(i.line_total) AS revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' GROUP BY i.name ORDER BY times DESC, revenue DESC LIMIT 1", [B]);
    const daily = await q("SELECT sale_date AS d, SUM(total) AS revenue, COUNT(*) AS sales FROM sales WHERE business_id=? AND status='completed' AND sale_date BETWEEN ? AND ? GROUP BY sale_date", [B, d14, today]);
    const dex = await q("SELECT expense_date AS d, SUM(amount) AS amount FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY expense_date", [B, d14, today]);
    const days = Array.from({ length: 14 }, (_, i) => addDays(d14, i));
    out.kpi = { sales_today: Number(m.sales_today), customers_today: Number(m.customers_today), expenses_today: Number(ex.today), profit_today: round2(Number(m.gross_today) - Number(ex.today) - Number(m.commission_today)), commission_today: Number(m.commission_today), revenue_month: Number(m.revenue_month), expenses_month: Number(ex.month), profit_month: round2(Number(m.gross_month) - Number(ex.month) - Number(m.commission_month)), popular: pop ? { name: pop.name, times: Number(pop.times), revenue: Number(pop.revenue) } : null };
    out.series = days.map(d => ({ d, revenue: Number((daily.find(x => x.d === d) || {}).revenue || 0), expenses: Number((dex.find(x => x.d === d) || {}).amount || 0) }));
    const byBarber = await q("SELECT COALESCE(b.name,'No barber') AS name, COUNT(*) AS services, SUM(s.total) AS revenue, SUM(s.commission_amount) AS commission FROM sales s LEFT JOIN barbers b ON b.id=s.barber_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date=? GROUP BY b.id, b.name ORDER BY revenue DESC", [B, today]);
    out.barbers_today = byBarber;
  }
  res.json(out);
}));

// ---------------------------------------------------------------- reports
router.get('/barber/reports', can('reports.view'), wrap(async (req, res) => {
  const B = req.biz.id; const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today;
  if (from > to) throw bad('The start date is after the end date');
  if ((new Date(to) - new Date(from)) / 86400000 > 800) throw bad('Choose a range of at most about two years');
  const daily = await q(`SELECT s.sale_date AS d, COUNT(*) AS sales, COALESCE(SUM(s.sale_type='service'),0) AS services,
      COALESCE(SUM(IF(s.sale_type='service',s.total,0)),0) AS service_revenue, COALESCE(SUM(IF(s.sale_type<>'service',s.total,0)),0) AS product_revenue,
      COALESCE(SUM(s.discount),0) AS discounts, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.profit),0) AS gross, COALESCE(SUM(s.commission_amount),0) AS commission
      FROM sales s WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY s.sale_date ORDER BY s.sale_date`, [B, from, to]);
  const exByDay = await q("SELECT expense_date AS d, SUM(amount) AS amount FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY expense_date", [B, from, to]);
  const byDay = new Map(daily.map(r => [r.d, r])); exByDay.forEach(e => { if (!byDay.has(e.d)) byDay.set(e.d, { d: e.d, sales: 0, services: 0, service_revenue: 0, product_revenue: 0, discounts: 0, revenue: 0, gross: 0, commission: 0 }); });
  const days = [...byDay.values()].sort((a, b) => a.d < b.d ? -1 : 1).map(r => { const exp = Number((exByDay.find(e => e.d === r.d) || {}).amount || 0); return { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'd' ? v : Number(v)])), expenses: exp, profit: round2(Number(r.gross) - exp - Number(r.commission)) }; });
  const by_service = await q(`SELECT i.name, COUNT(*) AS times, COALESCE(SUM(i.line_total),0) AS revenue, ROUND(AVG(i.unit_price),2) AS avg_price FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date BETWEEN ? AND ? GROUP BY i.name ORDER BY revenue DESC`, [B, from, to]);
  const by_barber = await q(`SELECT COALESCE(b.name,'No barber') AS name, COUNT(*) AS services, COALESCE(SUM(s.total - s.tax_amount),0) AS revenue, COALESCE(SUM(s.commission_amount),0) AS commission FROM sales s LEFT JOIN barbers b ON b.id=s.barber_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date BETWEEN ? AND ? GROUP BY b.id, b.name ORDER BY revenue DESC`, [B, from, to]);
  const visits = await q(`SELECT COALESCE(c.name, s.customer_name, 'Walk-in') AS name, COALESCE(c.phone, s.customer_phone) AS phone, COUNT(*) AS visits, COALESCE(SUM(s.total),0) AS spent, MAX(s.sale_date) AS last_visit
      FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.business_id=? AND s.status='completed' AND s.sale_type='service' AND s.sale_date BETWEEN ? AND ? GROUP BY COALESCE(s.customer_id, CONCAT('n:', COALESCE(s.customer_name,''), COALESCE(s.customer_phone,''))), name, phone ORDER BY visits DESC, spent DESC LIMIT 300`, [B, from, to]);
  const inventory = await q(`SELECT p.name, p.stock_qty, p.low_stock_at, p.cost_price, p.price, COALESCE((SELECT SUM(u.qty) FROM product_usage u WHERE u.product_id=p.id AND u.used_on BETWEEN ? AND ?),0) AS used,
      COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.product_id=p.id AND m.type='purchase' AND DATE(m.created_at) BETWEEN ? AND ?),0) AS restocked,
      COALESCE((SELECT SUM(i.qty) FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE i.product_id=p.id AND s.status='completed' AND s.sale_date BETWEEN ? AND ?),0) AS sold
      FROM products p WHERE p.business_id=? AND p.status='active' AND p.track_stock=1 ORDER BY p.name`, [from, to, from, to, from, to, B]);
  const expenses = await q("SELECT category, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC", [B, from, to]);
  const expense_rows = await q("SELECT e.expense_date, e.category, e.description, e.amount, u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.created_by WHERE e.business_id=? AND e.voided=0 AND e.status='approved' AND e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date DESC, e.id DESC LIMIT 500", [B, from, to]);
  const tot = days.reduce((a, r) => { Object.keys(r).forEach(k => { if (k !== 'd') a[k] = round2((a[k] || 0) + r[k]); }); return a; }, {});
  const pnl = { revenue_services: tot.service_revenue || 0, revenue_products: tot.product_revenue || 0, revenue: tot.revenue || 0, cost_of_goods: round2((tot.revenue || 0) - (tot.gross || 0)), gross_profit: tot.gross || 0, commissions: tot.commission || 0, expenses: round2(expenses.reduce((a, e) => a + Number(e.total), 0)), expense_breakdown: expenses.map(e => ({ category: e.category, total: Number(e.total) })) };
  pnl.net_profit = round2(pnl.gross_profit - pnl.commissions - pnl.expenses);
  res.json({ from, to, days, totals: tot, by_service, by_barber, visits, inventory, expenses, expense_rows, pnl, appointments: await one("SELECT COALESCE(SUM(status='completed'),0) AS completed, COALESCE(SUM(status='cancelled'),0) AS cancelled, COALESCE(SUM(status='missed'),0) AS missed, COALESCE(SUM(kind='walkin'),0) AS walkins, COUNT(*) AS total FROM appointments WHERE business_id=? AND appt_date BETWEEN ? AND ?", [B, from, to]) });
}));

module.exports = router;
module.exports.consumeStock = consumeStock;
