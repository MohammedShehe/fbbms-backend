// Billing for the signed-in business: plan status, pricing, mobile-money checkout (Snippe), auto-renew.
// Mounted BEFORE the read-only gate, so an unpaid business can always open this page and pay.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { q, one } = require('../config/db');
const { requireSuper } = require('../middleware/auth');
const { bad, notFound, wrap, int } = require('../lib/util');
const { audit } = require('../lib/audit');
const billing = require('../lib/billing');

const payLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `u${req.user && req.user.id}`, message: { message: 'Too many payment attempts. Please wait a few minutes.' } });

router.get('/status', wrap(async (req, res) => res.json(await billing.summary(req.biz, req.user))));

router.get('/plans', wrap(async (req, res) => {
  const cfg = await billing.config(); const st = billing.stateOf(req.biz, cfg);
  const monthly = cfg.plans.monthly.price;
  const plans = billing.PLAN_ORDER.map(k => {
    const p = cfg.plans[k]; const perMonth = p.days ? Math.round(p.price / p.days * 30) : null;
    const yearSave = k === 'yearly' && monthly ? Math.max(0, monthly * 12 - p.price) : 0;
    return { key: k, label: p.label, price: p.price, days: p.days, enabled: p.enabled, tagline: p.tagline, per_month: perMonth, saving_amount: yearSave, saving_pct: yearSave ? Math.round(yearSave / (monthly * 12) * 100) : 0, popular: k === 'monthly', one_time: k === 'lifetime' };
  }).filter(p => p.enabled);
  res.json({ plans, currency: cfg.currency, autopay_available: cfg.autopay_enabled, state: st.state, payments_ready: billing.configured(), contact: cfg.contact });
}));

router.get('/payments', requireSuper, wrap(async (req, res) => {
  const rows = await q('SELECT p.*, u.name AS payer_name FROM billing_payments p LEFT JOIN users u ON u.id=p.payer_user_id WHERE p.business_id=? ORDER BY p.id DESC LIMIT 60', [req.biz.id]);
  res.json(rows.map(r => ({ ...billing.publicPayment(r), payer: r.payer_name || null })));
}));

router.post('/checkout', requireSuper, payLimiter, wrap(async (req, res) => {
  const plan = String(req.body.plan || ''); const phone = req.body.phone;
  if (req.biz.lifetime) throw bad('This business already has lifetime access');
  // one live prompt at a time: reuse it instead of spamming the customer's phone
  const open = await one("SELECT * FROM billing_payments WHERE business_id=? AND status='pending' AND method='mobile' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MINUTE) ORDER BY id DESC LIMIT 1", [req.biz.id]);
  if (open && open.plan === plan && open.phone === billing.normalizePhone(phone)) return res.json({ payment: billing.publicPayment(open), reused: true });
  const pay = await billing.startMobilePayment({ biz: req.biz, user: req.user, plan, phone });
  await audit(req, { action: 'billing.checkout', entity: 'billing', entity_id: pay.id, details: { plan, amount: pay.amount, phone: billing.maskPhone(pay.phone) } });
  res.json({ payment: billing.publicPayment(pay) });
}));

router.get('/payments/:id', requireSuper, wrap(async (req, res) => {
  let p = await one('SELECT * FROM billing_payments WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!p) throw notFound('Payment not found');
  if (p.status === 'pending') { const last = billing.lastPoll.get(p.id) || 0; if (Date.now() - last > 3500) { billing.lastPoll.set(p.id, Date.now()); p = await billing.reconcile(p.id); } }
  const out = { payment: billing.publicPayment(p) };
  if (p.status === 'completed') out.summary = await billing.summary(await one('SELECT * FROM businesses WHERE id=?', [req.biz.id]), req.user);
  res.json(out);
}));

router.post('/payments/:id/resend', requireSuper, payLimiter, wrap(async (req, res) => {
  const p = await one('SELECT * FROM billing_payments WHERE id=? AND business_id=?', [int(req.params.id), req.biz.id]); if (!p) throw notFound('Payment not found');
  if (p.status !== 'pending' || !p.provider_ref) throw bad('This payment is no longer waiting for approval. Start a new one.');
  const phone = req.body.phone ? billing.normalizePhone(req.body.phone) : p.phone; if (!phone) throw bad('Enter a valid Tanzanian mobile-money number');
  await billing.snippe('POST', `/payments/${encodeURIComponent(p.provider_ref)}/push`, phone !== p.phone ? { phone_number: phone } : {});
  if (phone !== p.phone) await q('UPDATE billing_payments SET phone=? WHERE id=?', [phone, p.id]);
  res.json({ ok: true });
}));

router.put('/autopay', requireSuper, wrap(async (req, res) => {
  const cfg = await billing.config(); if (!cfg.autopay_enabled) throw bad('Auto-renew is not available right now');
  const on = !!req.body.enabled;
  if (!on) { await q('UPDATE businesses SET autopay_enabled=0, autopay_attempts=0 WHERE id=?', [req.biz.id]); await audit(req, { action: 'billing.autopay_off' }); return res.json({ ok: true, enabled: false }); }
  const plan = String(req.body.plan || ''); const p = cfg.plans[plan]; if (!p || !p.enabled || plan === 'lifetime') throw bad('Choose daily, monthly or yearly for auto-renew');
  const phone = billing.normalizePhone(req.body.phone); if (!phone) throw bad('Enter a valid Tanzanian mobile-money number');
  await q('UPDATE businesses SET autopay_enabled=1, autopay_plan=?, autopay_phone=?, autopay_by=?, autopay_attempts=0, autopay_last_attempt=NULL WHERE id=?', [plan, phone, req.user.id, req.biz.id]);
  await audit(req, { action: 'billing.autopay_on', details: { plan, phone: billing.maskPhone(phone) } });
  res.json({ ok: true, enabled: true, plan, phone: billing.maskPhone(phone) });
}));

module.exports = router;
