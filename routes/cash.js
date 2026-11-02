// Cash management: open/close the till, cash in/out, and a daily reconciliation that shows exactly where any difference comes from (module: cash).
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { can, requireModule } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, money, round2 } = require('../lib/util');
const { localDate, bizTz } = require('../lib/tz');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');

const gate = [requireModule('cash'), can('cash.manage')];

/** Everything that should be in the till between two moments. */
async function breakdown(biz, from, to, opening) {
  const B = biz.id;
  const sp = await one(`SELECT COALESCE(SUM(IF(p.amount>0,p.amount,0)),0) AS received, COALESCE(SUM(IF(p.amount<0,-p.amount,0)),0) AS refunded
    FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE p.business_id=? AND p.method='cash' AND s.status='completed' AND p.created_at>=? AND p.created_at<=?`, [B, from, to]);
  const sup = await one("SELECT COALESCE(SUM(amount),0) AS v FROM supplier_payments WHERE business_id=? AND method='cash' AND created_at>=? AND created_at<=?", [B, from, to]);
  const ex = await one("SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE business_id=? AND from_till=1 AND voided=0 AND status='approved' AND created_at>=? AND created_at<=?", [B, from, to]);
  const mv = await one("SELECT COALESCE(SUM(IF(type='in',amount,0)),0) AS cin, COALESCE(SUM(IF(type='out',amount,0)),0) AS cout FROM cash_movements WHERE business_id=? AND created_at>=? AND created_at<=?", [B, from, to]);
  const b = { opening_float: round2(opening), cash_sales: round2(sp.received), cash_refunds: round2(sp.refunded), supplier_payments: round2(sup.v), expenses_from_till: round2(ex.v), cash_in: round2(mv.cin), cash_out: round2(mv.cout) };
  b.expected = round2(b.opening_float + b.cash_sales - b.cash_refunds - b.supplier_payments - b.expenses_from_till + b.cash_in - b.cash_out);
  return b;
}

router.get('/cash/session', gate, wrap(async (req, res) => {
  const s = await one("SELECT cs.*, u.name AS opened_by_name FROM cash_sessions cs JOIN users u ON u.id=cs.opened_by WHERE cs.business_id=? AND cs.status='open' ORDER BY cs.id DESC LIMIT 1", [req.biz.id]);
  if (s) { s.live = await breakdown(req.biz, s.opened_at, new Date(), s.opening_float); s.movements = await q('SELECT m.*, u.name AS user_name FROM cash_movements m JOIN users u ON u.id=m.created_by WHERE m.business_id=? AND m.created_at>=? ORDER BY m.id DESC', [req.biz.id, s.opened_at]); }
  const last = await one("SELECT cs.id,cs.counted_cash,cs.expected_cash,cs.variance,cs.closed_at FROM cash_sessions cs WHERE cs.business_id=? AND cs.status='closed' ORDER BY cs.id DESC LIMIT 1", [req.biz.id]);
  res.json({ session: s, last_closed: last });
}));

router.post('/cash/open', gate, wrap(async (req, res) => {
  const f = money(req.body.opening_float, NaN); if (!(f >= 0)) throw bad('Enter the cash you are starting the till with (0 if none)');
  const out = await tx(async conn => {
    const [[open]] = await conn.query("SELECT id FROM cash_sessions WHERE business_id=? AND status='open' FOR UPDATE", [req.biz.id]); if (open) throw conflict('The till is already open. Close it first.');
    const now = new Date(); const [r] = await conn.query('INSERT INTO cash_sessions (business_id,opening_float,opened_by,opened_at,session_date) VALUES (?,?,?,?,?)', [req.biz.id, f, req.user.id, now, localDate(now, bizTz(req.biz))]);
    await audit(req, { action: 'cash.open', entity: 'cash_session', entity_id: r.insertId, details: { opening_float: f }, conn }); return { id: r.insertId };
  });
  res.json(out);
}));

router.post('/cash/movements', gate, wrap(async (req, res) => {
  const type = req.body.type === 'out' ? 'out' : 'in'; const amount = money(req.body.amount, 0); const reason = clip(req.body.reason, 255);
  if (!(amount > 0)) throw bad('Enter the amount'); if (reason.length < 3) throw bad('Say what the money is for');
  const r = await q('INSERT INTO cash_movements (business_id,type,amount,reason,created_by,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())', [req.biz.id, type, amount, reason, req.user.id]);
  await audit(req, { action: 'cash.' + type, entity: 'cash_movement', entity_id: r.insertId, details: { amount, reason } });
  res.json({ id: r.insertId });
}));

router.post('/cash/close', gate, wrap(async (req, res) => {
  const counted = money(req.body.counted_cash, NaN); if (!(counted >= 0)) throw bad('Enter the cash you counted in the till');
  const out = await tx(async conn => {
    const [[s]] = await conn.query("SELECT * FROM cash_sessions WHERE business_id=? AND status='open' FOR UPDATE", [req.biz.id]); if (!s) throw notFound('There is no open till to close');
    const now = new Date(); const b = await breakdown(req.biz, s.opened_at, now, s.opening_float); const variance = round2(counted - b.expected);
    await conn.query("UPDATE cash_sessions SET status='closed', expected_cash=?, counted_cash=?, variance=?, breakdown=?, notes=?, closed_by=?, closed_at=? WHERE id=?", [b.expected, counted, variance, JSON.stringify(b), clip(req.body.notes, 500) || null, req.user.id, now, s.id]);
    await audit(req, { action: 'cash.close', entity: 'cash_session', entity_id: s.id, details: { expected: b.expected, counted, variance }, conn });
    return { id: s.id, expected: b.expected, counted, variance, breakdown: b };
  });
  if (out.variance !== 0) {
    const pct = out.expected ? Math.abs(out.variance) / out.expected * 100 : 100;
    await notify(req.biz, { type: 'cash.variance', severity: pct > 2 ? 'critical' : 'warn', audience: 'super', title: `Till ${out.variance < 0 ? 'short' : 'over'} by ${Math.abs(out.variance)}`, body: `Expected ${out.expected}, counted ${out.counted}. Closed by ${req.user.name}.`, dedupe: `cash:${out.id}` });
  }
  res.json(out);
}));

router.get('/cash/sessions', gate, wrap(async (req, res) => {
  const rows = await q(`SELECT cs.*, o.name AS opened_by_name, c.name AS closed_by_name FROM cash_sessions cs JOIN users o ON o.id=cs.opened_by LEFT JOIN users c ON c.id=cs.closed_by WHERE cs.business_id=? ORDER BY cs.id DESC LIMIT 60`, [req.biz.id]);
  rows.forEach(r => { try { r.breakdown = r.breakdown ? JSON.parse(r.breakdown) : null; } catch { r.breakdown = null; } });
  res.json(rows);
}));

module.exports = router;
module.exports.breakdown = breakdown;
