// Developer console: revenue, every payment, pricing, and per-business billing controls (grant days, cash payments, exempt, lifetime).
const router = require('express').Router();
const { q, one } = require('../config/db');
const { authenticate, requireDeveloper } = require('../middleware/auth');
const { bad, notFound, wrap, int, clip, safeJSON } = require('../lib/util');
const { audit } = require('../lib/audit');
const billing = require('../lib/billing');
const rt = require('../lib/realtime');

router.use(authenticate, requireDeveloper);

const bizOr404 = async id => { const b = await one('SELECT * FROM businesses WHERE id=?', [int(id)]); if (!b) throw notFound('Business not found'); return b; };

router.get('/billing/overview', wrap(async (req, res) => {
  const cfg = await billing.config();
  const rev = await one(`SELECT
    COALESCE(SUM(CASE WHEN status='completed' AND method<>'grant' THEN amount END),0) AS all_time,
    COALESCE(SUM(CASE WHEN status='completed' AND method<>'grant' AND paid_at >= DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01') THEN amount END),0) AS month,
    COALESCE(SUM(CASE WHEN status='completed' AND method<>'grant' AND paid_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) THEN amount END),0) AS last_24h,
    SUM(status='pending') AS pending, SUM(status='completed' AND method<>'grant') AS paid_count, SUM(status IN ('failed','expired')) AS failed_count
    FROM billing_payments`);
  const byPlan = await q("SELECT plan, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM billing_payments WHERE status='completed' AND method<>'grant' GROUP BY plan");
  const series = await q("SELECT DATE(paid_at) AS d, SUM(amount) AS total FROM billing_payments WHERE status='completed' AND method<>'grant' AND paid_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) GROUP BY DATE(paid_at) ORDER BY d");
  const bizs = await q('SELECT * FROM businesses ORDER BY id');
  const rows = bizs.map(b => { const s = billing.stateOf(b, cfg); return { id: b.id, name: b.name, short_name: b.short_name, status: b.status, ...s, autopay: !!b.autopay_enabled, autopay_plan: b.autopay_plan }; });
  const counts = rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
  res.json({ revenue: rev, by_plan: byPlan, series, businesses: rows, counts, config: cfg, payments_ready: billing.configured(), webhook_url: billing.webhookUrl(), webhook_secret_set: !!process.env.SNIPPE_WEBHOOK_SECRET });
}));

router.get('/billing/payments', wrap(async (req, res) => {
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(100, Math.max(10, int(req.query.limit, 40)));
  const w = ['1=1']; const a = [];
  if (req.query.status) { w.push('p.status=?'); a.push(String(req.query.status)); }
  if (req.query.business) { w.push('p.business_id=?'); a.push(int(req.query.business)); }
  if (req.query.method) { w.push('p.method=?'); a.push(String(req.query.method)); }
  const total = (await one(`SELECT COUNT(*) AS n FROM billing_payments p WHERE ${w.join(' AND ')}`, a)).n;
  const rows = await q(`SELECT p.*, b.short_name AS business, u.name AS payer, r.name AS recorder FROM billing_payments p JOIN businesses b ON b.id=p.business_id LEFT JOIN users u ON u.id=p.payer_user_id LEFT JOIN users r ON r.id=p.recorded_by WHERE ${w.join(' AND ')} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  res.json({ total, page, limit, rows: rows.map(r => ({ ...billing.publicPayment(r), business: r.business, business_id: r.business_id, payer: r.payer, recorder: r.recorder, phone_full: r.phone })) });
}));

router.post('/billing/payments/:id/recheck', wrap(async (req, res) => {
  const p = await one('SELECT * FROM billing_payments WHERE id=?', [int(req.params.id)]); if (!p) throw notFound('Payment not found');
  if (!p.provider_ref) throw bad('This payment has no provider reference');
  const out = await billing.reconcile(p.id); await audit(req, { business_id: p.business_id, action: 'billing.recheck', entity: 'billing', entity_id: p.id, details: { status: out.status } });
  res.json({ payment: billing.publicPayment(out) });
}));

router.get('/billing/settings', wrap(async (req, res) => res.json(await billing.config())));
router.put('/billing/settings', wrap(async (req, res) => {
  const cur = await billing.config(); const b = req.body || {};
  const next = { ...cur, plans: { ...cur.plans }, contact: { ...cur.contact } };
  if (b.trial_days !== undefined) { const v = int(b.trial_days, -1); if (v < 0 || v > 365) throw bad('Trial must be 0 to 365 days'); next.trial_days = v; }
  if (b.grace_days !== undefined) { const v = int(b.grace_days, -1); if (v < 0 || v > 30) throw bad('Grace period must be 0 to 30 days'); next.grace_days = v; }
  if (b.autopay_enabled !== undefined) next.autopay_enabled = !!b.autopay_enabled;
  if (b.block_public_when_locked !== undefined) next.block_public_when_locked = !!b.block_public_when_locked;
  if (b.plans) for (const k of billing.PLAN_ORDER) if (b.plans[k]) {
    const p = b.plans[k]; const t = { ...cur.plans[k] };
    if (p.price !== undefined) { const v = Math.round(Number(p.price)); if (!Number.isFinite(v) || v < 500 || v > 100000000) throw bad(`Enter a sensible price for ${k}`); t.price = v; }
    if (p.enabled !== undefined) t.enabled = !!p.enabled; if (p.tagline !== undefined) t.tagline = clip(p.tagline, 40);
    next.plans[k] = t;
  }
  if (!billing.PLAN_ORDER.some(k => next.plans[k].enabled)) throw bad('At least one plan must stay enabled');
  if (b.contact) { ['name', 'phone', 'email'].forEach(k => { if (b.contact[k] !== undefined) next.contact[k] = clip(b.contact[k], 80); }); }
  await billing.saveConfig(next); await audit(req, { business_id: null, action: 'billing.settings', details: { prices: Object.fromEntries(billing.PLAN_ORDER.map(k => [k, next.plans[k].price])), trial_days: next.trial_days, grace_days: next.grace_days } });
  res.json(next);
}));

router.get('/businesses/:id/billing', wrap(async (req, res) => {
  const b = await bizOr404(req.params.id); const cfg = await billing.config();
  const pays = await q('SELECT p.*, r.name AS recorder FROM billing_payments p LEFT JOIN users r ON r.id=p.recorded_by WHERE p.business_id=? ORDER BY p.id DESC LIMIT 40', [b.id]);
  res.json({ state: billing.stateOf(b, cfg), autopay: { enabled: !!b.autopay_enabled, plan: b.autopay_plan, phone: billing.maskPhone(b.autopay_phone) }, plans: cfg.plans, payments: pays.map(p => ({ ...billing.publicPayment(p), recorder: p.recorder })) });
}));

router.put('/businesses/:id/billing', wrap(async (req, res) => {
  const b = await bizOr404(req.params.id); const x = req.body || {}; const sets = []; const a = []; const detail = {};
  if (x.billing_exempt !== undefined) { sets.push('billing_exempt=?'); a.push(x.billing_exempt ? 1 : 0); detail.billing_exempt = !!x.billing_exempt; }
  if (x.lifetime !== undefined) { sets.push('lifetime=?'); a.push(x.lifetime ? 1 : 0); detail.lifetime = !!x.lifetime; if (x.lifetime) sets.push('autopay_enabled=0'); }
  if (x.trial_days !== undefined) { const d = int(x.trial_days, -1); if (d < 0 || d > 365) throw bad('Trial must be 0 to 365 days'); sets.push('trial_ends_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)'); a.push(d); detail.trial_days_from_now = d; }
  if (x.clear_paid) { sets.push('paid_until=NULL'); detail.cleared_paid = true; }
  if (!sets.length) throw bad('Nothing to change');
  await q(`UPDATE businesses SET ${sets.join(', ')} WHERE id=?`, [...a, b.id]);
  await audit(req, { business_id: b.id, action: 'billing.admin_update', entity: 'business', entity_id: b.id, details: detail });
  rt.broadcast(b.id, 'billing.changed', { status: 'updated' });
  res.json({ ok: true, state: billing.stateOf(await bizOr404(b.id), await billing.config()) });
}));

router.post('/businesses/:id/billing/grant', wrap(async (req, res) => {
  const b = await bizOr404(req.params.id); await billing.grantDays({ biz: b, days: req.body.days, note: req.body.note, userId: req.user.id });
  await audit(req, { business_id: b.id, action: 'billing.grant', entity: 'business', entity_id: b.id, details: { days: req.body.days, note: req.body.note } });
  res.json({ ok: true, state: billing.stateOf(await bizOr404(b.id), await billing.config()) });
}));

router.post('/businesses/:id/billing/payment', wrap(async (req, res) => {
  const b = await bizOr404(req.params.id);
  const pay = await billing.recordManual({ biz: b, plan: String(req.body.plan || ''), amount: req.body.amount, note: req.body.note, reference: req.body.reference, userId: req.user.id });
  await audit(req, { business_id: b.id, action: 'billing.manual_payment', entity: 'billing', entity_id: pay.id, details: { plan: pay.plan, amount: pay.amount, reference: pay.provider_ref } });
  res.json({ ok: true, payment: billing.publicPayment(pay), state: billing.stateOf(await bizOr404(b.id), await billing.config()) });
}));

module.exports = router;
