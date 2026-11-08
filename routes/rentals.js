// Car Rental module: vehicles, bookings (with double-booking protection), customers, payments/refunds/deductions,
// rental calendar, maintenance & reminders, dashboard and reports.
// A confirmed booking creates ONE normal `sales` row (sale_type='rental'); payments/refunds are `sale_payments`, so the central
// dashboard, finance statements, customer balances (receivables) and the till all include rentals automatically.
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, canAny, requireModule, has } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, money, round2, isDate, addDays, startOfMonth, phoneOk, normPhone } = require('../lib/util');
const tzu = require('../lib/tz');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');
const { notify } = require('../lib/notify');
const { uploadImage, destroyImage, publicIdFromUrl } = require('../lib/cloudinary');
const { checkImage } = require('../lib/logo');
const reminders = require('../lib/rental-reminders');

router.use('/rentals', requireModule('rentals'));
const view = canAny('vehicles.manage', 'bookings.manage', 'rental.payments', 'maintenance.manage', 'reports.view');
const book = canAny('bookings.manage', 'rental.payments');
const METHODS = ['cash', 'bank', 'ewallet'];
const ACTIVE = ['pending', 'confirmed', 'ongoing'];
const bchanged = (req, d = {}) => rt.broadcast(req.biz.id, 'booking.changed', d);
const vchanged = (req, d = {}) => rt.broadcast(req.biz.id, 'vehicle.changed', d);
const runOn = conn => async (s, p) => (await conn.query(s, p))[0];

// ---------- date/time helpers (wall-clock values; no timezone conversion needed) ----------
const timeOf = (v, dflt) => { if (v === undefined || v === null || v === '') return dflt; const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v)); if (!m || +m[1] > 23 || +m[2] > 59) throw bad('Enter a valid time (HH:MM)'); return `${m[1].padStart(2, '0')}:${m[2]}:00`; };
const ms = (d, t) => Date.parse(`${d}T${t}Z`);
const calcDays = (pd, pt, rd, rtm) => Math.max(1, Math.ceil((ms(rd, rtm) - ms(pd, pt)) / 86400000 - 1e-9));
const ts = (d, t) => `${d} ${t}`;

/** First booking that overlaps [start,end) for the vehicle, or null. Back-to-back bookings (return = next pickup) are allowed. */
async function findConflict(run, bizId, vehicleId, start, end, exclude, today) {
  const rows = await run(`SELECT b.id,b.booking_no,b.customer_name,b.pickup_date,b.pickup_time,b.return_date,b.return_time,b.status FROM rental_bookings b
    WHERE b.business_id=? AND b.vehicle_id=? AND b.id<>? AND b.status IN ('pending','confirmed','ongoing','completed')
      AND TIMESTAMP(b.pickup_date,b.pickup_time) < ?
      AND (CASE WHEN b.status='completed' AND b.actual_return_date IS NOT NULL THEN LEAST(TIMESTAMP(b.return_date,b.return_time), TIMESTAMP(b.actual_return_date,b.return_time))
                WHEN b.status='ongoing' THEN GREATEST(TIMESTAMP(b.return_date,b.return_time), TIMESTAMP(?, '23:59:59'))
                ELSE TIMESTAMP(b.return_date,b.return_time) END) > ?
    ORDER BY b.pickup_date LIMIT 1`, [bizId, vehicleId, exclude || 0, end, today, start]);
  return rows[0] || null;
}
const conflictMsg = c => `Double booking blocked: this vehicle is already ${c.status === 'ongoing' ? 'out' : 'booked'} for ${c.booking_no} (${c.customer_name}) from ${c.pickup_date} ${String(c.pickup_time).slice(0, 5)} to ${c.return_date} ${String(c.return_time).slice(0, 5)}.`;

// ---------- customers ----------
async function ensureCustomer(conn, biz, { name, phone, notes }) {
  const nm = clip(name, 120); if (nm.length < 2) throw bad('Enter the customer\'s full name');
  const ph = normPhone(clip(phone, 30)); if (!phoneOk(ph)) throw bad('Enter a valid contact number');
  const [[ex]] = await conn.query('SELECT * FROM customers WHERE business_id=? AND phone=? FOR UPDATE', [biz.id, ph]);
  if (ex) { if (ex.status === 'archived') await conn.query("UPDATE customers SET status='active' WHERE id=?", [ex.id]); return ex; }
  const [r] = await conn.query("INSERT INTO customers (business_id,name,phone,notes,source) VALUES (?,?,?,?,'admin')", [biz.id, nm, ph, clip(notes, 500) || null]);
  const [[c]] = await conn.query('SELECT * FROM customers WHERE id=?', [r.insertId]); return c;
}

// ---------- ledger + sale sync ----------
async function ledger(conn, bookingId) {
  const [[a]] = await conn.query("SELECT COALESCE(SUM(IF(type='payment',amount,0)),0) AS pay, COALESCE(SUM(IF(type='refund',amount,0)),0) AS ref, COALESCE(SUM(IF(type='deduction',amount,0)),0) AS ded FROM rental_payments WHERE booking_id=?", [bookingId]);
  const paid = round2(Number(a.pay) - Number(a.ref)); const ded = round2(Number(a.ded));
  return { paid, ded, received: Number(a.pay), refunded: Number(a.ref) };
}
const dueOf = (bk, L) => round2(Math.max(0, Number(bk.charge) - L.ded - L.paid));

/** Keeps the booking's sale in step with charge, deductions and payments (creates it the first time). */
async function syncSale(conn, biz, userId, bk, method = 'cash') {
  const L = await ledger(conn, bk.id); const total = round2(Math.max(0, Number(bk.charge) - L.ded));
  const status = total === 0 || L.paid >= total - 0.009 ? 'paid' : L.paid > 0 ? 'partial' : 'unpaid';
  const [[veh]] = await conn.query('SELECT make,model,plate FROM vehicles WHERE id=?', [bk.vehicle_id]);
  const label = `${veh.make} ${veh.model} (${veh.plate}) · ${bk.days} day${bk.days === 1 ? '' : 's'} · ${bk.pickup_date} → ${bk.return_date}`.slice(0, 160);
  let saleId = bk.sale_id; const [[cust]] = await conn.query('SELECT id,name,phone FROM customers WHERE id=?', [bk.customer_id]);
  if (!saleId) {
    await conn.query('UPDATE businesses SET next_receipt = LAST_INSERT_ID(next_receipt + 1) WHERE id=?', [biz.id]); const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const receipt = `${biz.code}-${String(seq).padStart(6, '0')}`;
    const [r] = await conn.query(`INSERT INTO sales (business_id,receipt_no,source,customer_id,customer_name,customer_phone,payment_method,subtotal,discount,total,tax_amount,cost_total,profit,amount_paid,paid_status,notes,sold_by,sold_at,sale_date,sale_type,booking_id)
      VALUES (?,?,'pos',?,?,?,?,?,?,?,0,0,?,?,?,?,?,UTC_TIMESTAMP(),?,'rental',?)`, [biz.id, receipt, cust.id, cust.name, cust.phone, method, bk.charge, L.ded, total, total, L.paid, status, `Booking ${bk.booking_no}`, userId, bk.pickup_date, bk.id]);
    saleId = r.insertId;
    await conn.query("INSERT INTO sale_items (sale_id,product_id,name,sku,category,qty,list_price,unit_price,unit_cost,line_total) VALUES (?,NULL,?,NULL,'Vehicle rental',1,?,?,0,?)", [saleId, label, bk.charge, bk.charge, bk.charge]);
    await conn.query('UPDATE rental_bookings SET sale_id=? WHERE id=?', [saleId, bk.id]);
  } else {
    await conn.query("UPDATE sales SET customer_id=?, customer_name=?, customer_phone=?, subtotal=?, discount=?, total=?, profit=?, amount_paid=?, paid_status=?, sale_date=?, status='completed', void_reason=NULL, voided_by=NULL, voided_at=NULL WHERE id=?", [cust.id, cust.name, cust.phone, bk.charge, L.ded, total, total, L.paid, status, bk.pickup_date, saleId]);
    await conn.query("UPDATE sale_items SET name=?, list_price=?, unit_price=?, line_total=? WHERE sale_id=?", [label, bk.charge, bk.charge, bk.charge, saleId]);
  }
  await conn.query('UPDATE rental_bookings SET deduction=? WHERE id=?', [L.ded, bk.id]);
  return { saleId, ...L, total, due: round2(Math.max(0, total - L.paid)), status };
}
const lockBooking = async (conn, req, id) => { const [[b]] = await conn.query('SELECT * FROM rental_bookings WHERE id=? AND business_id=? FOR UPDATE', [int(id), req.biz.id]); if (!b) throw notFound('Booking not found'); return b; };

// =============================================================== vehicles
const vehSelect = `SELECT v.*,
  (SELECT JSON_OBJECT('id',b.id,'booking_no',b.booking_no,'customer',b.customer_name,'return_date',b.return_date,'return_time',b.return_time) FROM rental_bookings b WHERE b.vehicle_id=v.id AND b.status='ongoing' ORDER BY b.pickup_date LIMIT 1) AS current_booking,
  (SELECT JSON_OBJECT('id',b.id,'booking_no',b.booking_no,'customer',b.customer_name,'pickup_date',b.pickup_date,'pickup_time',b.pickup_time) FROM rental_bookings b WHERE b.vehicle_id=v.id AND b.status IN ('confirmed','pending') AND b.pickup_date>=? ORDER BY b.pickup_date, b.pickup_time LIMIT 1) AS next_booking
  FROM vehicles v`;
const parseJ = r => { ['current_booking', 'next_booking'].forEach(k => { if (typeof r[k] === 'string') { try { r[k] = JSON.parse(r[k]); } catch { r[k] = null; } } }); return r; };

router.get('/rentals/vehicles', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const w = ['v.business_id=?']; const a = [today, req.biz.id];
  if (!(req.query.archived === '1' && has(req, 'vehicles.manage'))) w.push('v.archived=0');
  if (['available', 'rented', 'maintenance'].includes(req.query.status)) { w.push('v.status=?'); a.push(req.query.status); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(v.make LIKE ? OR v.model LIKE ? OR v.plate LIKE ?)'); a.push(s, s, s); }
  const rows = (await q(`${vehSelect} WHERE ${w.join(' AND ')} ORDER BY v.archived, v.make, v.model, v.plate`, a)).map(parseJ);
  const rem = reminders.build(rows, today, Number(req.biz.settings.maintenance_reminder_days) || 14);
  rows.forEach(r => { r.reminders = rem.filter(x => x.vehicle_id === r.id).length; });
  res.json(rows);
}));

const vehBody = (b, cur = {}) => {
  const make = clip(b.make !== undefined ? b.make : cur.make, 60), model = clip(b.model !== undefined ? b.model : cur.model, 60);
  if (!make || !model) throw bad('Enter the vehicle make and model');
  const year = b.year !== undefined && b.year !== '' ? int(b.year, 0) : (b.year === '' ? null : cur.year || null); if (year && (year < 1980 || year > new Date().getUTCFullYear() + 1)) throw bad('Enter a valid year');
  const plate = clip(b.plate !== undefined ? b.plate : cur.plate, 20).toUpperCase().replace(/\s+/g, ' '); if (plate.length < 2) throw bad('Enter the plate number');
  const rate = b.daily_rate !== undefined ? money(b.daily_rate, NaN) : Number(cur.daily_rate || 0); if (!(rate >= 0) || rate > 100000000) throw bad('Enter a valid daily price');
  const status = ['available', 'rented', 'maintenance'].includes(b.status) ? b.status : (cur.status || 'available');
  const date = (k) => b[k] !== undefined ? (b[k] === '' || b[k] === null ? null : (isDate(b[k]) ? b[k] : (() => { throw bad('Enter dates as YYYY-MM-DD'); })())) : (cur[k] || null);
  const num = (k) => b[k] !== undefined ? (b[k] === '' || b[k] === null ? null : Math.max(0, int(b[k], 0))) : (cur[k] ?? null);
  return { make, model, year, plate, color: b.color !== undefined ? clip(b.color, 30) || null : (cur.color || null), transmission: b.transmission !== undefined ? clip(b.transmission, 20) || null : (cur.transmission || null), seats: b.seats !== undefined ? (b.seats === '' ? null : Math.min(60, Math.max(1, int(b.seats, 5)))) : (cur.seats || null), rate, status, mileage: num('mileage'), insurance_expiry: date('insurance_expiry'), road_tax_expiry: date('road_tax_expiry'), next_service_date: date('next_service_date'), next_service_mileage: num('next_service_mileage'), notes: b.notes !== undefined ? clip(b.notes, 255) || null : (cur.notes || null) };
};
async function statusGuard(conn, vid, status) {
  if (status === 'available' || status === 'maintenance') { const [[o]] = await conn.query("SELECT booking_no, customer_name FROM rental_bookings WHERE vehicle_id=? AND status='ongoing' LIMIT 1", [vid]); if (o) throw conflict(`This vehicle is out with ${o.customer_name} (${o.booking_no}). Complete that rental first.`); }
}
router.post('/rentals/vehicles', can('vehicles.manage'), wrap(async (req, res) => {
  const d = vehBody(req.body); if (d.status === 'rented') d.status = 'available';
  try {
    const r = await q('INSERT INTO vehicles (business_id,make,model,year,plate,color,transmission,seats,daily_rate,status,mileage,insurance_expiry,road_tax_expiry,next_service_date,next_service_mileage,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.biz.id, d.make, d.model, d.year, d.plate, d.color, d.transmission, d.seats, d.rate, d.status, d.mileage, d.insurance_expiry, d.road_tax_expiry, d.next_service_date, d.next_service_mileage, d.notes]);
    await audit(req, { action: 'vehicle.create', entity: 'vehicle', entity_id: r.insertId, details: { vehicle: `${d.make} ${d.model}`, plate: d.plate, daily_rate: d.rate } }); vchanged(req); res.json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('A vehicle with that plate number already exists'); throw e; }
}));
router.put('/rentals/vehicles/:id', can('vehicles.manage'), wrap(async (req, res) => {
  const v = await one('SELECT * FROM vehicles WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!v) throw notFound('Vehicle not found');
  const d = vehBody(req.body, v);
  try {
    await tx(async conn => {
      if (d.status !== v.status) await statusGuard(conn, v.id, d.status);
      if (d.status === 'maintenance' && v.status !== 'maintenance') { const [[nx]] = await conn.query("SELECT booking_no,pickup_date FROM rental_bookings WHERE vehicle_id=? AND status IN ('confirmed','pending') AND pickup_date<=DATE_ADD(?, INTERVAL 7 DAY) AND return_date>=? LIMIT 1", [v.id, tzu.today(req.biz), tzu.today(req.biz)]); if (nx && req.body.force !== true) throw conflict(`${nx.booking_no} is booked from ${nx.pickup_date}. Move or cancel it first, or confirm to continue.`, { needs_force: true }); }
      await conn.query('UPDATE vehicles SET make=?,model=?,year=?,plate=?,color=?,transmission=?,seats=?,daily_rate=?,status=?,mileage=?,insurance_expiry=?,road_tax_expiry=?,next_service_date=?,next_service_mileage=?,notes=? WHERE id=?',
        [d.make, d.model, d.year, d.plate, d.color, d.transmission, d.seats, d.rate, d.status, d.mileage, d.insurance_expiry, d.road_tax_expiry, d.next_service_date, d.next_service_mileage, d.notes, v.id]);
      await audit(req, { action: 'vehicle.update', entity: 'vehicle', entity_id: v.id, details: { plate: d.plate, status: d.status, daily_rate: d.rate, was: { status: v.status, daily_rate: v.daily_rate } }, conn });
    });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('A vehicle with that plate number already exists'); throw e; }
  vchanged(req, { id: v.id }); res.json({ ok: true });
}));
router.delete('/rentals/vehicles/:id', can('vehicles.manage'), wrap(async (req, res) => {
  const v = await one('SELECT * FROM vehicles WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!v) throw notFound('Vehicle not found');
  const open = await one("SELECT COUNT(*) AS n FROM rental_bookings WHERE vehicle_id=? AND status IN ('pending','confirmed','ongoing')", [v.id]); if (open.n) throw conflict('This vehicle has upcoming or ongoing bookings. Complete or cancel them first.');
  const hist = await one('SELECT (SELECT COUNT(*) FROM rental_bookings WHERE vehicle_id=?) + (SELECT COUNT(*) FROM vehicle_maintenance WHERE vehicle_id=?) AS n', [v.id, v.id]);
  if (hist.n) { await q('UPDATE vehicles SET archived=1, status=\'maintenance\' WHERE id=?', [v.id]); await audit(req, { action: 'vehicle.archive', entity: 'vehicle', entity_id: v.id, details: { plate: v.plate } }); vchanged(req); return res.json({ ok: true, archived: true }); }
  await q('DELETE FROM vehicles WHERE id=?', [v.id]); const pid = publicIdFromUrl(v.image_url); if (pid) destroyImage(pid).catch(() => {});
  await audit(req, { action: 'vehicle.delete', entity: 'vehicle', entity_id: v.id, details: { plate: v.plate } }); vchanged(req); res.json({ ok: true, deleted: true });
}));
router.post('/rentals/vehicles/:id/restore', can('vehicles.manage'), wrap(async (req, res) => {
  const v = await one('SELECT id,plate FROM vehicles WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!v) throw notFound('Vehicle not found');
  await q("UPDATE vehicles SET archived=0, status='available' WHERE id=?", [v.id]); await audit(req, { action: 'vehicle.restore', entity: 'vehicle', entity_id: v.id, details: { plate: v.plate } }); vchanged(req); res.json({ ok: true });
}));
router.post('/rentals/vehicles/:id/image', can('vehicles.manage'), wrap(async (req, res) => {
  const v = await one('SELECT * FROM vehicles WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!v) throw notFound('Vehicle not found');
  checkImage(req.body.data); const up = await uploadImage(req.body.data, `fbbms/${req.biz.slug}/vehicles`);
  await q('UPDATE vehicles SET image_url=? WHERE id=?', [up.url, v.id]); const old = publicIdFromUrl(v.image_url); if (old && old !== up.public_id) destroyImage(old).catch(() => {});
  await audit(req, { action: 'vehicle.photo', entity: 'vehicle', entity_id: v.id, details: { plate: v.plate } }); vchanged(req, { id: v.id }); res.json({ image_url: up.url });
}));
router.delete('/rentals/vehicles/:id/image', can('vehicles.manage'), wrap(async (req, res) => {
  const v = await one('SELECT * FROM vehicles WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!v) throw notFound('Vehicle not found');
  await q('UPDATE vehicles SET image_url=NULL WHERE id=?', [v.id]); const old = publicIdFromUrl(v.image_url); if (old) destroyImage(old).catch(() => {}); vchanged(req, { id: v.id }); res.json({ ok: true });
}));

// ---- availability for a period (used by the booking form so a taken vehicle cannot even be picked)
router.get('/rentals/availability', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const pd = req.query.pickup_date, rd = req.query.return_date; if (!isDate(pd) || !isDate(rd)) throw bad('Choose pickup and return dates');
  const pt = timeOf(req.query.pickup_time, '10:00:00'), rtm = timeOf(req.query.return_time, '10:00:00'); if (ms(rd, rtm) <= ms(pd, pt)) throw bad('The return must be after the pickup');
  const vs = await q('SELECT id,make,model,plate,year,daily_rate,status,image_url FROM vehicles WHERE business_id=? AND archived=0 ORDER BY make,model,plate', [req.biz.id]);
  const out = [];
  for (const v of vs) { const c = await findConflict(q, req.biz.id, v.id, ts(pd, pt), ts(rd, rtm), int(req.query.exclude), today); out.push({ ...v, available: !c && v.status !== 'maintenance', reason: v.status === 'maintenance' ? 'Under maintenance' : c ? `Booked (${c.booking_no}, ${c.pickup_date} → ${c.return_date})` : null }); }
  res.json({ days: calcDays(pd, pt, rd, rtm), vehicles: out });
}));

// =============================================================== bookings
const bkSelect = `SELECT b.*, v.make, v.model, v.plate, v.image_url, s.receipt_no,
  COALESCE((SELECT SUM(IF(p.type='payment',p.amount,IF(p.type='refund',-p.amount,0))) FROM rental_payments p WHERE p.booking_id=b.id),0) AS paid
  FROM rental_bookings b JOIN vehicles v ON v.id=b.vehicle_id LEFT JOIN sales s ON s.id=b.sale_id`;
const decorate = (r, today) => { r.total = round2(Math.max(0, Number(r.charge) - Number(r.deduction))); r.paid = round2(r.paid); r.balance = r.status === 'cancelled' || r.status === 'pending' ? 0 : round2(Math.max(0, r.total - r.paid)); r.overdue = r.status === 'ongoing' && r.return_date < today; return r; };

router.get('/rentals/bookings', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const w = ['b.business_id=?']; const a = [req.biz.id];
  const scope = req.query.scope;
  if (scope === 'upcoming') { w.push("b.status IN ('pending','confirmed') AND b.pickup_date>=?"); a.push(today); }
  else if (scope === 'ongoing') w.push("b.status='ongoing'");
  else if (scope === 'previous') w.push("(b.status IN ('completed','cancelled') OR (b.return_date<? AND b.status<>'ongoing'))"), a.push(today);
  if (['pending', 'confirmed', 'ongoing', 'completed', 'cancelled'].includes(req.query.status)) { w.push('b.status=?'); a.push(req.query.status); }
  if (int(req.query.vehicle_id)) { w.push('b.vehicle_id=?'); a.push(int(req.query.vehicle_id)); }
  if (int(req.query.customer_id)) { w.push('b.customer_id=?'); a.push(int(req.query.customer_id)); }
  if (isDate(req.query.from)) { w.push('b.return_date>=?'); a.push(req.query.from); }
  if (isDate(req.query.to)) { w.push('b.pickup_date<=?'); a.push(req.query.to); }
  if (req.query.unpaid === '1') w.push("b.status IN ('confirmed','ongoing','completed') AND b.charge - b.deduction > COALESCE((SELECT SUM(IF(p.type='payment',p.amount,IF(p.type='refund',-p.amount,0))) FROM rental_payments p WHERE p.booking_id=b.id),0) + 0.009");
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(b.booking_no LIKE ? OR b.customer_name LIKE ? OR b.customer_phone LIKE ? OR v.plate LIKE ? OR v.make LIKE ? OR v.model LIKE ?)'); a.push(s, s, s, s, s, s); }
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(200, Math.max(1, int(req.query.limit, 30)));
  const total = (await one(`SELECT COUNT(*) AS n FROM rental_bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE ${w.join(' AND ')}`, a)).n;
  const order = scope === 'upcoming' ? 'b.pickup_date ASC, b.pickup_time ASC' : 'b.pickup_date DESC, b.id DESC';
  const rows = (await q(`${bkSelect} WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit])).map(r => decorate(r, today));
  res.json({ rows, total, page, limit });
}));
router.get('/rentals/bookings/:id', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const r = await one(`${bkSelect} WHERE b.id=? AND b.business_id=?`, [int(req.params.id), req.biz.id]); if (!r) throw notFound('Booking not found');
  decorate(r, today); r.entries = await q('SELECT p.*, u.name AS by_name FROM rental_payments p LEFT JOIN users u ON u.id=p.created_by WHERE p.booking_id=? ORDER BY p.id', [r.id]);
  r.customer = await one('SELECT id,name,phone,notes FROM customers WHERE id=?', [r.customer_id]);
  r.business = { name: req.biz.name, phone: req.biz.settings.phone || null, whatsapp: req.biz.settings.whatsapp || req.biz.settings.phone || null, currency: req.biz.currency };
  res.json(r);
}));

const bookingDates = (b, cur = {}) => {
  const pd = b.pickup_date !== undefined ? b.pickup_date : cur.pickup_date, rd = b.return_date !== undefined ? b.return_date : cur.return_date;
  if (!isDate(pd) || !isDate(rd)) throw bad('Choose the pickup and return dates');
  const pt = timeOf(b.pickup_time !== undefined ? b.pickup_time : cur.pickup_time, '10:00:00'), rtm = timeOf(b.return_time !== undefined ? b.return_time : cur.return_time, '10:00:00');
  if (ms(rd, rtm) <= ms(pd, pt)) throw bad('The return must be after the pickup');
  if ((ms(rd, rtm) - ms(pd, pt)) / 86400000 > 366) throw bad('A rental cannot be longer than 366 days');
  return { pd, pt, rd, rtm, days: calcDays(pd, pt, rd, rtm) };
};

router.post('/rentals/bookings', can('bookings.manage'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const D = bookingDates(req.body);
  if (D.pd < addDays(today, -90)) throw bad('The pickup date is too far in the past');
  const status = req.body.status === 'pending' ? 'pending' : 'confirmed';
  const channel = ['whatsapp', 'phone', 'walkin', 'manual'].includes(req.body.channel) ? req.body.channel : 'whatsapp';
  const first = req.body.initial_payment && Number(req.body.initial_payment.amount) > 0 ? req.body.initial_payment : null;
  if (first && status === 'pending') throw bad('Confirm the booking before taking a payment');
  if (first && !has(req, 'rental.payments')) throw require('../lib/util').forbidden('You are not allowed to record payments');
  const out = await tx(async conn => {
    const [[veh]] = await conn.query('SELECT * FROM vehicles WHERE id=? AND business_id=? FOR UPDATE', [int(req.body.vehicle_id), req.biz.id]); // serialises bookings per vehicle
    if (!veh || veh.archived) throw bad('Choose a vehicle from the list');
    if (veh.status === 'maintenance') throw conflict('This vehicle is under maintenance. Set it to Available first.');
    const c = await findConflict(runOn(conn), req.biz.id, veh.id, ts(D.pd, D.pt), ts(D.rd, D.rtm), 0, today); if (c) throw conflict(conflictMsg(c), { booking_id: c.id });
    const cust = await ensureCustomer(conn, req.biz, { name: req.body.customer_name, phone: req.body.customer_phone });
    const rate = req.body.daily_rate !== undefined && req.body.daily_rate !== '' ? money(req.body.daily_rate, NaN) : Number(veh.daily_rate); if (!(rate >= 0)) throw bad('Enter a valid daily price');
    const charge = req.body.charge !== undefined && req.body.charge !== '' ? money(req.body.charge, NaN) : round2(rate * D.days); if (!(charge >= 0)) throw bad('Enter a valid rental charge');
    if (!(charge > 0)) throw bad('Set a daily price for this vehicle (or enter the rental charge) before booking');
    await conn.query('UPDATE businesses SET next_booking = LAST_INSERT_ID(next_booking + 1) WHERE id=?', [req.biz.id]); const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const no = `${req.biz.code}-B${String(seq).padStart(5, '0')}`;
    const [r] = await conn.query('INSERT INTO rental_bookings (business_id,booking_no,vehicle_id,customer_id,customer_name,customer_phone,pickup_date,pickup_time,return_date,return_time,days,daily_rate,charge,status,channel,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.biz.id, no, veh.id, cust.id, cust.name, cust.phone, D.pd, D.pt, D.rd, D.rtm, D.days, rate, charge, status, channel, clip(req.body.notes, 500) || null, req.user.id]);
    const [[bk]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [r.insertId]);
    let sale = null; if (status === 'confirmed') sale = await syncSale(conn, req.biz, req.user.id, bk);
    if (first) await addEntry(conn, req, bk, { type: 'payment', amount: first.amount, method: first.method, reference: first.reference, note: 'Booking payment' });
    await audit(req, { action: 'booking.create', entity: 'booking', entity_id: r.insertId, details: { booking: no, vehicle: veh.plate, customer: cust.name, from: D.pd, to: D.rd, charge, status }, conn });
    return { id: r.insertId, booking_no: no, charge, days: D.days, sale_id: sale ? sale.saleId : null };
  });
  bchanged(req, { id: out.id }); if (out.sale_id) rt.broadcast(req.biz.id, 'sale.new', { id: out.sale_id, receipt_no: out.booking_no, total: out.charge, by: req.user.name, by_id: req.user.id }); res.json(out);
}));

router.put('/rentals/bookings/:id', can('bookings.manage'), wrap(async (req, res) => {
  const today = tzu.today(req.biz);
  await tx(async conn => {
    const bk = await lockBooking(conn, req, req.params.id);
    if (!['pending', 'confirmed', 'ongoing'].includes(bk.status)) throw conflict('Completed or cancelled bookings cannot be edited');
    const ongoing = bk.status === 'ongoing';
    const D = bookingDates(ongoing ? { return_date: req.body.return_date, return_time: req.body.return_time } : req.body, bk);
    const vehId = !ongoing && int(req.body.vehicle_id) ? int(req.body.vehicle_id) : bk.vehicle_id;
    const [[veh]] = await conn.query('SELECT * FROM vehicles WHERE id=? AND business_id=? FOR UPDATE', [vehId, req.biz.id]); if (!veh || veh.archived) throw bad('Choose a vehicle from the list');
    if (vehId !== bk.vehicle_id && veh.status === 'maintenance') throw conflict('That vehicle is under maintenance');
    const c = await findConflict(runOn(conn), req.biz.id, veh.id, ts(D.pd, D.pt), ts(D.rd, D.rtm), bk.id, today); if (c) throw conflict(conflictMsg(c), { booking_id: c.id });
    let cust = { id: bk.customer_id, name: bk.customer_name, phone: bk.customer_phone };
    if (!ongoing && (req.body.customer_name !== undefined || req.body.customer_phone !== undefined)) cust = await ensureCustomer(conn, req.biz, { name: req.body.customer_name || bk.customer_name, phone: req.body.customer_phone || bk.customer_phone });
    const rate = req.body.daily_rate !== undefined && req.body.daily_rate !== '' ? money(req.body.daily_rate, NaN) : (vehId !== bk.vehicle_id && req.body.daily_rate === undefined ? Number(veh.daily_rate) : Number(bk.daily_rate)); if (!(rate >= 0)) throw bad('Enter a valid daily price');
    const rental = D.days !== bk.days || rate !== Number(bk.daily_rate);
    const charge = req.body.charge !== undefined && req.body.charge !== '' ? money(req.body.charge, NaN) : (rental ? round2(rate * D.days) : Number(bk.charge)); if (!(charge > 0)) throw bad('Enter a valid rental charge');
    const L = await ledger(conn, bk.id); if (bk.sale_id && charge - L.ded < L.paid - 0.009) throw conflict(`The customer has already paid ${L.paid}. Refund the difference first, then lower the charge.`);
    await conn.query('UPDATE rental_bookings SET vehicle_id=?, customer_id=?, customer_name=?, customer_phone=?, pickup_date=?, pickup_time=?, return_date=?, return_time=?, days=?, daily_rate=?, charge=?, channel=?, notes=? WHERE id=?',
      [veh.id, cust.id, cust.name, cust.phone, D.pd, D.pt, D.rd, D.rtm, D.days, rate, charge, ['whatsapp', 'phone', 'walkin', 'manual'].includes(req.body.channel) ? req.body.channel : bk.channel, req.body.notes !== undefined ? clip(req.body.notes, 500) || null : bk.notes, bk.id]);
    const [[fresh]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [bk.id]); if (bk.sale_id) await syncSale(conn, req.biz, req.user.id, fresh);
    await audit(req, { action: 'booking.update', entity: 'booking', entity_id: bk.id, details: { booking: bk.booking_no, from: D.pd, to: D.rd, charge, vehicle: veh.plate, was: { charge: bk.charge, from: bk.pickup_date, to: bk.return_date } }, conn });
  });
  bchanged(req, { id: int(req.params.id) }); res.json({ ok: true });
}));

router.post('/rentals/bookings/:id/status', can('bookings.manage'), wrap(async (req, res) => {
  const to = req.body.status; const today = tzu.today(req.biz); let outInfo = {};
  await tx(async conn => {
    const bk = await lockBooking(conn, req, req.params.id);
    const [[veh]] = await conn.query('SELECT * FROM vehicles WHERE id=? FOR UPDATE', [bk.vehicle_id]);
    const FLOW = { pending: ['confirmed', 'cancelled'], confirmed: ['ongoing', 'cancelled'], ongoing: ['completed'] };
    if (!(FLOW[bk.status] || []).includes(to)) throw conflict(`A ${bk.status} booking cannot be changed to ${to}`);
    if (to === 'confirmed') {
      const c = await findConflict(runOn(conn), req.biz.id, bk.vehicle_id, ts(bk.pickup_date, bk.pickup_time), ts(bk.return_date, bk.return_time), bk.id, today); if (c) throw conflict(conflictMsg(c));
      await conn.query("UPDATE rental_bookings SET status='confirmed' WHERE id=?", [bk.id]); const [[f]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [bk.id]); await syncSale(conn, req.biz, req.user.id, f);
    } else if (to === 'ongoing') {
      if (bk.pickup_date > today) throw conflict(`Pickup is on ${bk.pickup_date}. You can hand over the vehicle from that day.`);
      if (veh.status === 'maintenance') throw conflict('This vehicle is under maintenance. Set it to Available first.');
      const [[other]] = await conn.query("SELECT booking_no FROM rental_bookings WHERE vehicle_id=? AND status='ongoing' AND id<>? LIMIT 1", [veh.id, bk.id]); if (other) throw conflict(`This vehicle is still out on ${other.booking_no}. Complete that return first.`);
      await conn.query("UPDATE rental_bookings SET status='ongoing' WHERE id=?", [bk.id]); await conn.query("UPDATE vehicles SET status='rented' WHERE id=?", [veh.id]);
    } else if (to === 'completed') {
      const ret = isDate(req.body.return_date) ? req.body.return_date : today; if (ret < bk.pickup_date) throw bad('The return date cannot be before the pickup');
      const extra = money(req.body.extra_charge, 0); if (extra < 0) throw bad('Invalid extra charge');
      await conn.query("UPDATE rental_bookings SET status='completed', actual_return_date=?, charge=charge+? WHERE id=?", [ret, extra, bk.id]);
      const km = req.body.return_mileage !== undefined && req.body.return_mileage !== '' ? int(req.body.return_mileage, -1) : null; if (km !== null && km < 0) throw bad('Enter a valid mileage');
      if (km !== null && km >= Number(veh.mileage || 0)) await conn.query('UPDATE vehicles SET mileage=? WHERE id=?', [km, veh.id]);
      await conn.query("UPDATE vehicles SET status='available' WHERE id=? AND status='rented' AND NOT EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id=? AND status='ongoing' AND id<>?)", [veh.id, veh.id, bk.id]);
      const [[f]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [bk.id]); const s = await syncSale(conn, req.biz, req.user.id, f); outInfo = { balance: s.due, late_days: ret > bk.return_date ? Math.round((ms(ret, '00:00:00') - ms(bk.return_date, '00:00:00')) / 86400000) : 0 };
    } else if (to === 'cancelled') {
      const L = bk.sale_id ? await ledger(conn, bk.id) : { paid: 0, ded: 0 };
      if (L.paid > 0.009) {
        const mode = req.body.money; // 'refund' | 'keep'
        if (mode === 'refund') { if (!has(req, 'rental.payments')) throw require('../lib/util').forbidden('You are not allowed to record refunds'); await addEntry(conn, req, bk, { type: 'refund', amount: L.paid, method: METHODS.includes(req.body.refund_method) ? req.body.refund_method : 'cash', note: 'Refund on cancellation' }); }
        else if (mode === 'keep') { if (!has(req, 'rental.payments')) throw require('../lib/util').forbidden('You are not allowed to record deductions'); const waive = round2(Number(bk.charge) - L.ded - L.paid); if (waive > 0.009) await addEntry(conn, req, bk, { type: 'deduction', amount: waive, note: 'Cancellation: rest of the charge waived, amount paid kept as fee' }, true); }
        else throw conflict(`The customer has already paid ${L.paid}. Choose to refund it or keep it as a cancellation fee.`, { paid: L.paid });
      }
      const [[f]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [bk.id]); const L2 = bk.sale_id ? await ledger(conn, bk.id) : { paid: 0 };
      await conn.query("UPDATE rental_bookings SET status='cancelled', cancel_reason=? WHERE id=?", [clip(req.body.reason, 255) || null, bk.id]);
      if (bk.sale_id) { if (L2.paid > 0.009) await syncSale(conn, req.biz, req.user.id, { ...f, status: 'cancelled' }); else await conn.query("UPDATE sales SET status='voided', void_reason=?, voided_by=?, voided_at=UTC_TIMESTAMP() WHERE id=?", [`Booking ${bk.booking_no} cancelled`, req.user.id, bk.sale_id]); }
    }
    await audit(req, { action: 'booking.' + to, entity: 'booking', entity_id: bk.id, details: { booking: bk.booking_no, customer: bk.customer_name, vehicle: veh.plate }, conn });
  });
  bchanged(req, { id: int(req.params.id) }); vchanged(req); res.json({ ok: true, ...outInfo });
}));

// =============================================================== payments, refunds, deductions
async function addEntry(conn, req, bk, { type, amount, method, reference, note }, skipChecks = false) {
  if (!bk.sale_id && !['confirmed', 'ongoing', 'completed'].includes(bk.status)) throw conflict('Confirm the booking before recording money');
  const amt = money(amount, NaN); if (!(amt > 0)) throw bad('Enter an amount greater than zero');
  if (type !== 'deduction' && !METHODS.includes(method)) throw bad('Choose cash, bank transfer or e-wallet');
  const L = await ledger(conn, bk.id); const [[cur]] = await conn.query('SELECT * FROM rental_bookings WHERE id=?', [bk.id]); const due = dueOf(cur, L);
  if (!skipChecks) {
    if (type === 'payment' && amt > due + 0.009) throw bad(`That is more than the balance of ${due}`);
    if (type === 'deduction' && amt > due + 0.009) throw bad(`A deduction cannot exceed the balance of ${due}. Refund the customer instead.`);
    if (type === 'refund' && amt > L.paid + 0.009) throw bad(`Only ${L.paid} has been paid, so that much at most can be refunded`);
  }
  const [r] = await conn.query('INSERT INTO rental_payments (business_id,booking_id,type,amount,method,reference,note,created_by) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, bk.id, type, amt, type === 'deduction' ? null : method, clip(reference, 80) || null, clip(note, 255) || null, req.user.id]);
  const s = await syncSale(conn, req.biz, req.user.id, cur, method || 'cash');
  if (type !== 'deduction') await conn.query('INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())', [req.biz.id, s.saleId, cur.customer_id, method, type === 'refund' ? -amt : amt, clip(reference, 80) || (type === 'refund' ? 'Rental refund' : null), req.user.id]);
  if (type !== 'deduction') await conn.query('UPDATE sales SET payment_method=? WHERE id=?', [method, s.saleId]);
  return { id: r.insertId, ...s };
}
router.post('/rentals/bookings/:id/payments', can('rental.payments'), wrap(async (req, res) => {
  const type = ['payment', 'refund', 'deduction'].includes(req.body.type) ? req.body.type : 'payment';
  const out = await tx(async conn => { const bk = await lockBooking(conn, req, req.params.id); if (bk.status === 'cancelled') throw conflict('This booking is cancelled'); const r = await addEntry(conn, req, bk, { type, amount: req.body.amount, method: req.body.method, reference: req.body.reference, note: req.body.note }); await audit(req, { action: 'rental.' + type, entity: 'booking', entity_id: bk.id, details: { booking: bk.booking_no, amount: money(req.body.amount, 0), method: req.body.method || null, note: clip(req.body.note, 120) }, conn }); return r; });
  bchanged(req, { id: int(req.params.id) }); res.json({ ok: true, paid: out.paid, balance: out.due, status: out.status });
}));
router.get('/rentals/payments', canAny('rental.payments', 'reports.view', 'bookings.manage'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today; const off = tzu.offset(req.biz);
  const w = ['p.business_id=?', `DATE(DATE_ADD(p.created_at, INTERVAL ${off} MINUTE)) BETWEEN ? AND ?`]; const a = [req.biz.id, from, to];
  if (['payment', 'refund', 'deduction'].includes(req.query.type)) { w.push('p.type=?'); a.push(req.query.type); }
  if (METHODS.includes(req.query.method)) { w.push('p.method=?'); a.push(req.query.method); }
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(b.booking_no LIKE ? OR b.customer_name LIKE ? OR v.plate LIKE ?)'); a.push(s, s, s); }
  const rows = await q(`SELECT p.*, b.booking_no, b.customer_name, v.make, v.model, v.plate, u.name AS by_name FROM rental_payments p JOIN rental_bookings b ON b.id=p.booking_id JOIN vehicles v ON v.id=b.vehicle_id LEFT JOIN users u ON u.id=p.created_by WHERE ${w.join(' AND ')} ORDER BY p.id DESC LIMIT 500`, a);
  const sum = rows.reduce((s, r) => { const k = r.type; s[k] = round2((s[k] || 0) + Number(r.amount)); return s; }, {});
  const outstanding = await q(`SELECT * FROM (${bkSelect} WHERE b.business_id=? AND b.status IN ('confirmed','ongoing','completed')) x WHERE (x.charge - x.deduction - x.paid) > 0.009 ORDER BY x.return_date`, [req.biz.id]);
  outstanding.forEach(r => decorate(r, today));
  res.json({ from, to, rows, totals: { received: sum.payment || 0, refunded: sum.refund || 0, deductions: sum.deduction || 0, net: round2((sum.payment || 0) - (sum.refund || 0)) }, outstanding, outstanding_total: round2(outstanding.reduce((s, r) => s + r.balance, 0)) });
}));

// =============================================================== customers
router.get('/rentals/customers', view, wrap(async (req, res) => {
  const w = ["c.business_id=?", "c.status='active'"]; const a = [req.biz.id];
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(c.name LIKE ? OR c.phone LIKE ?)'); a.push(s, s); }
  const rows = await q(`SELECT c.id,c.name,c.phone,c.notes,c.created_at,
    (SELECT COUNT(*) FROM rental_bookings b WHERE b.customer_id=c.id AND b.status IN ('confirmed','ongoing','completed')) AS rentals,
    (SELECT COALESCE(SUM(b.charge-b.deduction),0) FROM rental_bookings b WHERE b.customer_id=c.id AND b.status IN ('confirmed','ongoing','completed')) AS billed,
    (SELECT MAX(b.pickup_date) FROM rental_bookings b WHERE b.customer_id=c.id AND b.status<>'cancelled') AS last_rental
    FROM customers c WHERE ${w.join(' AND ')} ORDER BY c.name LIMIT 300`, a);
  const bal = await q(`SELECT b.customer_id, COALESCE(SUM(b.charge-b.deduction - COALESCE((SELECT SUM(IF(p.type='payment',p.amount,IF(p.type='refund',-p.amount,0))) FROM rental_payments p WHERE p.booking_id=b.id),0)),0) AS due FROM rental_bookings b WHERE b.business_id=? AND b.status IN ('confirmed','ongoing','completed') GROUP BY b.customer_id`, [req.biz.id]);
  rows.forEach(r => { r.balance = round2(Math.max(0, Number((bal.find(x => x.customer_id === r.id) || {}).due || 0))); });
  res.json(rows);
}));
router.get('/rentals/customers/:id', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const c = await one('SELECT id,name,phone,notes,created_at FROM customers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!c) throw notFound('Customer not found');
  const rows = (await q(`${bkSelect} WHERE b.business_id=? AND b.customer_id=? ORDER BY b.pickup_date DESC, b.id DESC LIMIT 200`, [req.biz.id, c.id])).map(r => decorate(r, today));
  const live = rows.filter(r => ['confirmed', 'ongoing', 'completed'].includes(r.status));
  res.json({ customer: c, rentals: rows, summary: { rentals: live.length, billed: round2(live.reduce((s, r) => s + r.total, 0)), paid: round2(live.reduce((s, r) => s + r.paid, 0)), balance: round2(live.reduce((s, r) => s + r.balance, 0)) } });
}));
router.post('/rentals/customers', can('bookings.manage'), wrap(async (req, res) => { const c = await tx(conn => ensureCustomer(conn, req.biz, { name: req.body.name, phone: req.body.phone, notes: req.body.notes })); res.json({ id: c.id, name: c.name, phone: c.phone }); }));
router.put('/rentals/customers/:id', can('bookings.manage'), wrap(async (req, res) => {
  const c = await one('SELECT * FROM customers WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!c) throw notFound('Customer not found');
  const name = clip(req.body.name !== undefined ? req.body.name : c.name, 120); if (name.length < 2) throw bad('Enter the full name');
  const phone = req.body.phone !== undefined ? normPhone(clip(req.body.phone, 30)) : c.phone; if (!phoneOk(phone)) throw bad('Enter a valid contact number');
  try { await q('UPDATE customers SET name=?, phone=?, notes=? WHERE id=?', [name, phone, req.body.notes !== undefined ? clip(req.body.notes, 500) || null : c.notes, c.id]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Another customer already has that number'); throw e; }
  await q('UPDATE rental_bookings SET customer_name=?, customer_phone=? WHERE customer_id=? AND status IN (\'pending\',\'confirmed\',\'ongoing\')', [name, phone, c.id]);
  res.json({ ok: true });
}));

// =============================================================== calendar
router.get('/rentals/calendar', view, wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : addDays(from, 34);
  if ((new Date(to) - new Date(from)) / 86400000 > 100) throw bad('Choose a shorter period (up to 100 days)');
  const vehicles = (await q(vehSelect + ' WHERE v.business_id=? AND v.archived=0 ORDER BY v.make,v.model,v.plate', [today, req.biz.id])).map(parseJ);
  const bookings = (await q(`${bkSelect} WHERE b.business_id=? AND b.status IN ('pending','confirmed','ongoing','completed') AND b.pickup_date<=? AND b.return_date>=? ORDER BY b.pickup_date, b.pickup_time`, [req.biz.id, to, from])).map(r => decorate(r, today));
  const returns = (await q(`${bkSelect} WHERE b.business_id=? AND b.status IN ('ongoing','confirmed') AND b.return_date BETWEEN ? AND ? ORDER BY b.return_date, b.return_time`, [req.biz.id, today, addDays(today, 7)])).map(r => decorate(r, today));
  const overdue = (await q(`${bkSelect} WHERE b.business_id=? AND b.status='ongoing' AND b.return_date<? ORDER BY b.return_date`, [req.biz.id, today])).map(r => decorate(r, today));
  const rem = reminders.build(vehicles, today, Number(req.biz.settings.maintenance_reminder_days) || 14);
  res.json({ from, to, today, vehicles, bookings, upcoming_returns: returns, overdue_returns: overdue, reminders: rem });
}));

// =============================================================== maintenance
router.get('/rentals/maintenance', canAny('maintenance.manage', 'vehicles.manage', 'reports.view'), wrap(async (req, res) => {
  const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : addDays(today, -365); const to = isDate(req.query.to) ? req.query.to : today;
  const w = ['m.business_id=?', 'm.service_date BETWEEN ? AND ?']; const a = [req.biz.id, from, to]; if (int(req.query.vehicle_id)) { w.push('m.vehicle_id=?'); a.push(int(req.query.vehicle_id)); }
  const rows = await q(`SELECT m.*, v.make, v.model, v.plate, u.name AS by_name FROM vehicle_maintenance m JOIN vehicles v ON v.id=m.vehicle_id LEFT JOIN users u ON u.id=m.created_by WHERE ${w.join(' AND ')} ORDER BY m.service_date DESC, m.id DESC LIMIT 400`, a);
  const vehicles = await q('SELECT id,make,model,plate,mileage,insurance_expiry,road_tax_expiry,next_service_date,next_service_mileage,archived FROM vehicles WHERE business_id=? AND archived=0 ORDER BY make,model,plate', [req.biz.id]);
  res.json({ from, to, rows, total_cost: round2(rows.reduce((s, r) => s + Number(r.cost), 0)), reminders: reminders.build(vehicles, today, Number(req.biz.settings.maintenance_reminder_days) || 14), vehicles });
}));
router.post('/rentals/maintenance', can('maintenance.manage'), wrap(async (req, res) => {
  const kind = ['service', 'repair', 'tyres', 'other'].includes(req.body.kind) ? req.body.kind : 'service'; const today = tzu.today(req.biz);
  const date = isDate(req.body.service_date) ? req.body.service_date : today; if (date > today) throw bad('The service date cannot be in the future');
  const cost = req.body.cost === undefined || req.body.cost === '' ? 0 : money(req.body.cost, NaN); if (!(cost >= 0)) throw bad('Enter a valid cost');
  const km = req.body.mileage === undefined || req.body.mileage === '' ? null : int(req.body.mileage, -1); if (km !== null && km < 0) throw bad('Enter a valid mileage');
  const nd = req.body.next_service_date ? (isDate(req.body.next_service_date) ? req.body.next_service_date : (() => { throw bad('Enter the next service date as YYYY-MM-DD'); })()) : null; if (nd && nd < date) throw bad('The next service date is before this service');
  const nk = req.body.next_service_mileage === undefined || req.body.next_service_mileage === '' ? null : int(req.body.next_service_mileage, -1); if (nk !== null && nk < 0) throw bad('Enter a valid mileage');
  const id = await tx(async conn => {
    const [[v]] = await conn.query('SELECT * FROM vehicles WHERE id=? AND business_id=? FOR UPDATE', [int(req.body.vehicle_id), req.biz.id]); if (!v) throw bad('Choose a vehicle');
    let expenseId = null;
    if (cost > 0) { const [e] = await conn.query("INSERT INTO expenses (business_id,expense_date,category,description,amount,created_by,status) VALUES (?,?,'Vehicle maintenance',?,?,?,'approved')", [req.biz.id, date, clip(`${v.make} ${v.model} ${v.plate}: ${req.body.description || kind}`, 255), cost, req.user.id]); expenseId = e.insertId; }
    const [r] = await conn.query('INSERT INTO vehicle_maintenance (business_id,vehicle_id,kind,service_date,mileage,cost,description,next_service_date,next_service_mileage,expense_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [req.biz.id, v.id, kind, date, km, cost, clip(req.body.description, 255) || null, nd, nk, expenseId, req.user.id]);
    await conn.query('UPDATE vehicles SET mileage=GREATEST(COALESCE(mileage,0), COALESCE(?,0)), next_service_date=?, next_service_mileage=? WHERE id=?', [km, nd, nk, v.id]);
    await audit(req, { action: 'maintenance.create', entity: 'vehicle', entity_id: v.id, details: { plate: v.plate, kind, cost, date }, conn });
    return r.insertId;
  });
  if (cost > 0) rt.broadcast(req.biz.id, 'expense.new', {}); vchanged(req); res.json({ id });
}));
router.delete('/rentals/maintenance/:id', can('maintenance.manage'), wrap(async (req, res) => {
  const m = await one('SELECT * FROM vehicle_maintenance WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!m) throw notFound('Record not found');
  await tx(async conn => { if (m.expense_id) await conn.query('UPDATE expenses SET voided=1 WHERE id=? AND business_id=?', [m.expense_id, req.biz.id]); await conn.query('DELETE FROM vehicle_maintenance WHERE id=?', [m.id]); await audit(req, { action: 'maintenance.delete', entity: 'vehicle', entity_id: m.vehicle_id, details: { cost: m.cost, date: m.service_date }, conn }); });
  res.json({ ok: true });
}));
router.get('/rentals/reminders', view, wrap(async (req, res) => res.json(await reminders.forBusiness(req.biz, tzu.today(req.biz)))));

// =============================================================== dashboard
router.get('/rentals/dashboard', view, wrap(async (req, res) => {
  const B = req.biz.id; const today = tzu.today(req.biz); const mtd = startOfMonth(today); const full = has(req, 'reports.view') || has(req, 'rental.payments');
  const fleet = await one("SELECT COUNT(*) AS total, COALESCE(SUM(status='available'),0) AS available, COALESCE(SUM(status='rented'),0) AS rented, COALESCE(SUM(status='maintenance'),0) AS maintenance FROM vehicles WHERE business_id=? AND archived=0", [B]);
  const upcoming = (await q(`${bkSelect} WHERE b.business_id=? AND b.status IN ('confirmed','pending') AND b.pickup_date>=? ORDER BY b.pickup_date, b.pickup_time LIMIT 8`, [B, today])).map(r => decorate(r, today));
  const upcomingCount = (await one("SELECT COUNT(*) AS n FROM rental_bookings WHERE business_id=? AND status IN ('confirmed','pending') AND pickup_date>=?", [B, today])).n;
  const returns = (await q(`${bkSelect} WHERE b.business_id=? AND b.status='ongoing' ORDER BY b.return_date, b.return_time LIMIT 8`, [B])).map(r => decorate(r, today));
  const pickupsToday = (await q(`${bkSelect} WHERE b.business_id=? AND b.status IN ('confirmed','pending') AND b.pickup_date=? ORDER BY b.pickup_time`, [B, today])).map(r => decorate(r, today));
  const rem = await reminders.forBusiness(req.biz, today);
  const out = { today, fleet: Object.fromEntries(Object.entries(fleet).map(([k, v]) => [k, Number(v)])), upcoming, upcoming_count: Number(upcomingCount), returns, pickups_today: pickupsToday, reminders: rem.slice(0, 8), reminders_count: rem.length, full };
  if (full) {
    const rev = await one("SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bookings FROM sales WHERE business_id=? AND sale_type='rental' AND status='completed' AND sale_date BETWEEN ? AND ?", [B, mtd, today]);
    const off = tzu.offset(req.biz);
    const col = await one(`SELECT COALESCE(SUM(p.amount),0) AS collected FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE p.business_id=? AND s.sale_type='rental' AND s.status='completed' AND DATE(DATE_ADD(p.created_at, INTERVAL ${off} MINUTE)) BETWEEN ? AND ?`, [B, mtd, today]);
    const out2 = await one("SELECT COALESCE(SUM(GREATEST(0,total-amount_paid)),0) AS due, COUNT(*) AS n FROM sales WHERE business_id=? AND sale_type='rental' AND status='completed' AND total-amount_paid>0.009", [B]);
    const mx = await one("SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND category='Vehicle maintenance' AND expense_date BETWEEN ? AND ?", [B, mtd, today]);
    const d14 = addDays(today, -13); const daily = await q("SELECT sale_date AS d, SUM(total) AS revenue FROM sales WHERE business_id=? AND sale_type='rental' AND status='completed' AND sale_date BETWEEN ? AND ? GROUP BY sale_date", [B, d14, today]);
    out.kpi = { revenue_month: Number(rev.revenue), bookings_month: Number(rev.bookings), collected_month: Number(col.collected), outstanding: Number(out2.due), outstanding_count: Number(out2.n), maintenance_month: Number(mx.v) };
    out.series = Array.from({ length: 14 }, (_, i) => { const d = addDays(d14, i); return { d, revenue: Number((daily.find(x => x.d === d) || {}).revenue || 0) }; });
  }
  res.json(out);
}));

// =============================================================== reports
router.get('/rentals/reports', canAny('reports.view', 'rental.payments'), wrap(async (req, res) => {
  const B = req.biz.id; const today = tzu.today(req.biz); const from = isDate(req.query.from) ? req.query.from : startOfMonth(today); const to = isDate(req.query.to) ? req.query.to : today;
  if (from > to) throw bad('The start date is after the end date'); if ((new Date(to) - new Date(from)) / 86400000 > 800) throw bad('Choose a range of at most about two years');
  const counts = await one("SELECT COUNT(*) AS total, COALESCE(SUM(status='pending'),0) AS pending, COALESCE(SUM(status='confirmed'),0) AS confirmed, COALESCE(SUM(status='ongoing'),0) AS ongoing, COALESCE(SUM(status='completed'),0) AS completed, COALESCE(SUM(status='cancelled'),0) AS cancelled FROM rental_bookings WHERE business_id=? AND pickup_date BETWEEN ? AND ?", [B, from, to]);
  const rev = await one("SELECT COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(amount_paid),0) AS collected, COALESCE(SUM(GREATEST(0,total-amount_paid)),0) AS outstanding FROM sales WHERE business_id=? AND sale_type='rental' AND status='completed' AND sale_date BETWEEN ? AND ?", [B, from, to]);
  const months = await q("SELECT DATE_FORMAT(sale_date,'%Y-%m') AS month, COUNT(*) AS bookings, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(amount_paid),0) AS collected FROM sales WHERE business_id=? AND sale_type='rental' AND status='completed' AND sale_date >= DATE_SUB(?, INTERVAL 11 MONTH) AND sale_date <= ? GROUP BY month ORDER BY month", [B, startOfMonth(today), today]);
  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const byVehicle = await q(`SELECT v.id, v.make, v.model, v.plate,
     COUNT(b.id) AS bookings, COALESCE(SUM(b.days),0) AS days_booked, COALESCE(SUM(b.charge-b.deduction),0) AS revenue,
     COALESCE((SELECT SUM(m.cost) FROM vehicle_maintenance m WHERE m.vehicle_id=v.id AND m.service_date BETWEEN ? AND ?),0) AS maintenance
     FROM vehicles v LEFT JOIN rental_bookings b ON b.vehicle_id=v.id AND b.status IN ('confirmed','ongoing','completed') AND b.pickup_date BETWEEN ? AND ? WHERE v.business_id=? GROUP BY v.id,v.make,v.model,v.plate ORDER BY revenue DESC`, [from, to, from, to, B]);
  byVehicle.forEach(r => { r.utilisation_pct = round2(Math.min(100, Number(r.days_booked) / spanDays * 100)); r.profit = round2(Number(r.revenue) - Number(r.maintenance)); });
  let history = []; if (int(req.query.vehicle_id)) history = (await q(`${bkSelect} WHERE b.business_id=? AND b.vehicle_id=? AND b.status<>'cancelled' ORDER BY b.pickup_date DESC LIMIT 300`, [B, int(req.query.vehicle_id)])).map(r => decorate(r, today));
  const maint = await q(`SELECT m.service_date, m.kind, m.cost, m.mileage, m.description, v.make, v.model, v.plate FROM vehicle_maintenance m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.business_id=? AND m.service_date BETWEEN ? AND ? ORDER BY m.service_date DESC LIMIT 400`, [B, from, to]);
  const outstanding = (await q(`SELECT * FROM (${bkSelect} WHERE b.business_id=? AND b.status IN ('confirmed','ongoing','completed')) x WHERE (x.charge - x.deduction - x.paid) > 0.009 ORDER BY x.return_date`, [B])).map(r => decorate(r, today));
  res.json({ from, to, bookings: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])), revenue: { billed: Number(rev.revenue), collected: Number(rev.collected), outstanding: Number(rev.outstanding) }, months, by_vehicle: byVehicle, history, maintenance: { rows: maint, total: round2(maint.reduce((s, r) => s + Number(r.cost), 0)) }, outstanding, outstanding_total: round2(outstanding.reduce((s, r) => s + r.balance, 0)) });
}));

// Daily reminders (called by the scheduler).
async function remindersTick(biz, today) {
  const list = await reminders.forBusiness(biz, today);
  for (const r of list) await notify(biz, { type: 'vehicle.reminder', severity: r.overdue ? 'warn' : 'info', audience: 'super', title: `${r.vehicle} (${r.plate}): ${r.label}`, body: reminders.text(r), dedupe: `veh:${r.vehicle_id}:${r.kind}:${r.due || r.km_left}:${today}` });
}

module.exports = router;
module.exports.remindersTick = remindersTick;
