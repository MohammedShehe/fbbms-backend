// Customer relationship management: profiles, purchase history, credit balances, loyalty, segments, birthdays (module: customers).
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, canAny, requireModule, has } = require('../middleware/auth');
const { bad, notFound, wrap, clip, int, money, round2, phoneOk, normPhone, emailOk, isDate } = require('../lib/util');
const { addDays, localDate, bizTz } = require('../lib/tz');
const { addPoints } = require('../lib/customers');
const { audit } = require('../lib/audit');

const mod = requireModule('customers');
const view = canAny('customers.view', 'customers.manage');
const DUE = 'GREATEST(0, s.total - s.refunded_total - s.amount_paid)';

/** Transparent segment rules (also shown in the app): VIP, Regular, New, Dormant, Prospect. */
function segmentOf(c, today, vipSpend) {
  if (!c.orders) return 'prospect';
  const days = Math.floor((new Date(today) - new Date(c.last_purchase)) / 86400000);
  if (c.spent >= vipSpend || c.orders >= 10) return 'vip';
  if (days > 90) return 'dormant';
  if (c.orders <= 1 && Math.floor((new Date(today) - new Date(c.created_at)) / 86400000) <= 30) return 'new';
  return 'regular';
}

async function listWithStats(biz, status = 'active') {
  const today = localDate(new Date(), bizTz(biz));
  const rows = await q(`SELECT c.*,
      (SELECT COUNT(*) FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AS orders,
      (SELECT COALESCE(SUM(s.total - s.refunded_total),0) FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AS spent,
      (SELECT MAX(s.sale_date) FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AS last_purchase,
      (SELECT COALESCE(SUM(${DUE}),0) FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AS balance
      FROM customers c WHERE c.business_id=? ${status === 'all' ? '' : 'AND c.status=?'} ORDER BY c.name LIMIT 5000`, status === 'all' ? [biz.id] : [biz.id, status]);
  const vip = Number(biz.settings.vip_spend) || 500000;
  rows.forEach(r => { r.segment = segmentOf(r, today, vip); });
  return rows;
}

router.get('/customers/segments', mod, view, wrap(async (req, res) => {
  const rows = await listWithStats(req.biz); const out = {};
  rows.forEach(r => { out[r.segment] = (out[r.segment] || 0) + 1; });
  res.json({ counts: out, total: rows.length, vip_spend: Number(req.biz.settings.vip_spend) || 500000, rules: { vip: 'Lifetime spend at or above the VIP amount, or 10+ purchases', regular: 'Bought within the last 90 days', new: 'Joined in the last 30 days with at most 1 purchase', dormant: 'Last purchase more than 90 days ago', prospect: 'Registered but never bought' } });
}));

router.get('/customers/birthdays', mod, view, wrap(async (req, res) => {
  const days = Math.min(60, Math.max(1, int(req.query.days, 14))); const today = localDate(new Date(), bizTz(req.biz));
  const rows = await q("SELECT id,name,phone,birthday,marketing_ok FROM customers WHERE business_id=? AND status='active' AND birthday IS NOT NULL", [req.biz.id]);
  const out = [];
  for (const r of rows) {
    const [, m, d] = r.birthday.split('-'); let next = `${today.slice(0, 4)}-${m}-${d}`; if (next < today) next = `${Number(today.slice(0, 4)) + 1}-${m}-${d}`;
    const left = Math.round((new Date(next) - new Date(today)) / 86400000);
    if (left <= days) out.push({ ...r, next_birthday: next, days_left: left });
  }
  res.json(out.sort((a, b) => a.days_left - b.days_left));
}));

router.get('/customers/lookup', mod, canAny('customers.view', 'customers.manage', 'sales.create'), wrap(async (req, res) => {
  const s = clip(req.query.q, 40); if (s.length < 2) return res.json([]);
  const p = `%${s}%`;
  const rows = await q(`SELECT c.id,c.name,c.phone,c.loyalty_points,(SELECT COALESCE(SUM(${DUE}),0) FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AS balance
    FROM customers c WHERE c.business_id=? AND c.status='active' AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT 8`, [req.biz.id, p, p]);
  res.json(rows);
}));

router.get('/customers', mod, view, wrap(async (req, res) => {
  let rows = await listWithStats(req.biz, req.query.status === 'archived' ? 'archived' : 'active');
  if (req.query.q) { const s = String(req.query.q).toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.phone || '').includes(s) || (r.email || '').toLowerCase().includes(s)); }
  if (req.query.segment) rows = rows.filter(r => r.segment === req.query.segment);
  if (req.query.debt === '1') rows = rows.filter(r => r.balance > 0.009);
  const sort = req.query.sort; if (sort === 'spent') rows.sort((a, b) => b.spent - a.spent); else if (sort === 'recent') rows.sort((a, b) => String(b.last_purchase || '').localeCompare(String(a.last_purchase || ''))); else if (sort === 'balance') rows.sort((a, b) => b.balance - a.balance);
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(200, Math.max(1, int(req.query.limit, 30)));
  res.json({ rows: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit });
}));

function readCustomer(b, partial) {
  const name = clip(b.name, 120); if (!partial || b.name !== undefined) { if (name.length < 2) throw bad('Enter the customer name'); }
  const phone = b.phone !== undefined ? normPhone(clip(b.phone, 30)) : undefined; if (phone && !phoneOk(phone)) throw bad('Enter a valid phone number');
  const email = clip(b.email, 150); if (email && !emailOk(email)) throw bad('Enter a valid email');
  const birthday = b.birthday ? (isDate(b.birthday) ? b.birthday : (() => { throw bad('Birthday must be a valid date'); })()) : null;
  return { name, phone: phone || null, email: email || null, birthday, address: clip(b.address, 255) || null, notes: clip(b.notes, 500) || null, marketing_ok: b.marketing_ok === false || b.marketing_ok === 0 ? 0 : 1 };
}
const dup = e => { if (e.code === 'ER_DUP_ENTRY') throw bad('A customer with that phone number already exists'); throw e; };

router.post('/customers', mod, can('customers.manage'), wrap(async (req, res) => {
  const d = readCustomer(req.body);
  try { const r = await q('INSERT INTO customers (business_id,name,phone,email,birthday,address,notes,marketing_ok,source) VALUES (?,?,?,?,?,?,?,?,?)', [req.biz.id, d.name, d.phone, d.email, d.birthday, d.address, d.notes, d.marketing_ok, 'admin']);
    await audit(req, { action: 'customer.create', entity: 'customer', entity_id: r.insertId, details: { name: d.name } }); res.json({ id: r.insertId }); } catch (e) { dup(e); }
}));
router.put('/customers/:id', mod, can('customers.manage'), wrap(async (req, res) => {
  const d = readCustomer(req.body);
  try { const r = await q('UPDATE customers SET name=?,phone=?,email=?,birthday=?,address=?,notes=?,marketing_ok=? WHERE id=? AND business_id=?', [d.name, d.phone, d.email, d.birthday, d.address, d.notes, d.marketing_ok, req.params.id, req.biz.id]);
    if (!r.affectedRows) throw notFound('Customer not found'); await audit(req, { action: 'customer.update', entity: 'customer', entity_id: int(req.params.id), details: { name: d.name } }); res.json({ ok: true }); } catch (e) { dup(e); }
}));
router.post('/customers/:id/archive', mod, can('customers.manage'), wrap(async (req, res) => {
  const r = await q('UPDATE customers SET status=? WHERE id=? AND business_id=?', [req.body.restore ? 'active' : 'archived', req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('Customer not found'); await audit(req, { action: req.body.restore ? 'customer.restore' : 'customer.archive', entity: 'customer', entity_id: int(req.params.id) }); res.json({ ok: true });
}));

router.get('/customers/:id', mod, view, wrap(async (req, res) => {
  const c = (await listWithStats(req.biz, 'all')).find(x => x.id === int(req.params.id)); if (!c) throw notFound('Customer not found');
  c.sales = await q(`SELECT s.id,s.receipt_no,s.sale_date,s.sold_at,s.total,s.refunded_total,s.amount_paid,s.paid_status,s.status,${DUE} AS due,
      (SELECT GROUP_CONCAT(CONCAT(i.qty,'× ',i.name) SEPARATOR ', ') FROM sale_items i WHERE i.sale_id=s.id) AS items FROM sales s WHERE s.customer_id=? ORDER BY s.id DESC LIMIT 60`, [c.id]);
  c.loyalty = await q('SELECT points_change,balance_after,reason,created_at FROM loyalty_log WHERE customer_id=? ORDER BY id DESC LIMIT 40', [c.id]);
  c.favourites = await q(`SELECT i.name, SUM(i.qty) AS units FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.customer_id=? AND s.status='completed' GROUP BY i.product_id,i.name ORDER BY units DESC LIMIT 5`, [c.id]);
  res.json(c);
}));

// Debt repayment: money is applied to the oldest unpaid sales first, and each allocation is recorded as a payment on that sale.
router.post('/customers/:id/payments', mod, can('customers.manage'), wrap(async (req, res) => {
  let amount = money(req.body.amount, 0); if (!(amount > 0)) throw bad('Enter the amount received');
  const method = ['cash', 'mobile_money', 'card', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  const out = await tx(async conn => {
    const [[c]] = await conn.query('SELECT id,name FROM customers WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]); if (!c) throw notFound('Customer not found');
    const [due] = await conn.query(`SELECT s.id,s.receipt_no,s.total,s.refunded_total,s.amount_paid FROM sales s WHERE s.customer_id=? AND s.status='completed' AND s.total - s.refunded_total - s.amount_paid > 0.009 ORDER BY s.id FOR UPDATE`, [c.id]);
    const owed = round2(due.reduce((t, s) => t + (s.total - s.refunded_total - s.amount_paid), 0));
    if (!due.length) throw bad('This customer owes nothing'); if (amount > owed + 0.009) throw bad(`The customer only owes ${owed}`);
    const alloc = []; const now = new Date(); let left = amount;
    for (const s of due) {
      if (left <= 0.0049) break; const need = round2(s.total - s.refunded_total - s.amount_paid); const pay = round2(Math.min(need, left)); left = round2(left - pay);
      const paidNow = round2(s.amount_paid + pay); const full = paidNow >= s.total - s.refunded_total - 0.009;
      await conn.query('UPDATE sales SET amount_paid=?, paid_status=? WHERE id=?', [paidNow, full ? 'paid' : 'partial', s.id]);
      await conn.query('INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, s.id, c.id, method, pay, clip(req.body.reference, 80) || 'Debt repayment', req.user.id, now]);
      alloc.push({ receipt_no: s.receipt_no, paid: pay, cleared: full });
    }
    await audit(req, { action: 'customer.payment', entity: 'customer', entity_id: c.id, details: { name: c.name, amount, method }, conn });
    return { allocated: alloc, remaining_balance: round2(owed - amount) };
  });
  res.json(out);
}));

router.post('/customers/:id/points', mod, can('customers.manage'), wrap(async (req, res) => {
  const pts = int(req.body.points); const reason = clip(req.body.reason, 120); if (!pts) throw bad('Enter the points to add or remove'); if (reason.length < 3) throw bad('Give a reason');
  const bal = await tx(async conn => { const [[c]] = await conn.query('SELECT id FROM customers WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); if (!c) throw notFound('Customer not found'); return addPoints(conn, req.biz.id, c.id, pts, `Manual: ${reason}`, 'manual', null, req.user.id); });
  await audit(req, { action: 'customer.points', entity: 'customer', entity_id: int(req.params.id), details: { pts, reason } });
  res.json({ balance: bal });
}));

router.get('/receivables', requireModule('customers'), canAny('customers.view', 'customers.manage', 'reports.view'), wrap(async (req, res) => {
  const today = localDate(new Date(), bizTz(req.biz));
  const rows = await q(`SELECT s.id AS sale_id,s.receipt_no,s.sale_date,s.customer_id,c.name,c.phone,${DUE} AS due FROM sales s JOIN customers c ON c.id=s.customer_id
    WHERE s.business_id=? AND s.status='completed' AND s.total - s.refunded_total - s.amount_paid > 0.009 ORDER BY s.sale_date`, [req.biz.id]);
  const aging = { current: 0, d30: 0, d60: 0, d90: 0 }; const per = new Map();
  rows.forEach(r => { const age = Math.floor((new Date(today) - new Date(r.sale_date)) / 86400000); const k = age <= 30 ? 'current' : age <= 60 ? 'd30' : age <= 90 ? 'd60' : 'd90'; aging[k] = round2(aging[k] + r.due);
    const p = per.get(r.customer_id) || { customer_id: r.customer_id, name: r.name, phone: r.phone, due: 0, oldest_days: 0, invoices: 0 }; p.due = round2(p.due + r.due); p.invoices++; p.oldest_days = Math.max(p.oldest_days, age); per.set(r.customer_id, p); });
  res.json({ customers: [...per.values()].sort((a, b) => b.due - a.due), total: round2(rows.reduce((t, r) => t + r.due, 0)), aging, buckets: { current: '0–30 days', d30: '31–60 days', d60: '61–90 days', d90: 'Over 90 days' } });
}));

module.exports = router;
