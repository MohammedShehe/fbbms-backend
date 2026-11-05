// FBBMS billing: free trial → paid plans (daily / monthly / yearly / one-time), Snippe mobile-money checkout,
// auto-renew prompts, and the read-only lock for unpaid businesses.
const crypto = require('crypto');
const { q, one, tx } = require('../config/db');
const platform = require('./platform');
const { HttpError, clip, safeJSON, round2 } = require('./util');
const rt = require('./realtime');

const DAY = 86400000, HOUR = 3600000;
const PLAN_ORDER = ['daily', 'monthly', 'yearly', 'lifetime'];
const DEFAULTS = {
  currency: 'TZS', trial_days: 30, grace_days: 2, autopay_enabled: true, block_public_when_locked: false,
  plans: {
    daily:    { label: 'Daily',    price: 2000,    days: 1,   enabled: true, tagline: 'Pay as you go' },
    monthly:  { label: 'Monthly',  price: 30000,   days: 30,  enabled: true, tagline: 'Most popular' },
    yearly:   { label: 'Yearly',   price: 300000,  days: 365, enabled: true, tagline: 'Two months free' },
    lifetime: { label: 'One-time', price: 1000000, days: 0,   enabled: true, tagline: 'Pay once, use forever' }
  },
  contact: { name: 'MO11', phone: '+255 677 532 140', email: 'developer@fourbrothers.online' }
};

/** Platform billing settings (Developer can change prices, trial length, grace days, contact). */
async function config() {
  const c = await platform.get('billing', DEFAULTS);
  const plans = {}; PLAN_ORDER.forEach(k => { plans[k] = { ...DEFAULTS.plans[k], ...((c.plans || {})[k] || {}), days: DEFAULTS.plans[k].days }; });
  return { ...DEFAULTS, ...c, plans, contact: { ...DEFAULTS.contact, ...(c.contact || {}) } };
}
const saveConfig = v => platform.set('billing', v);

const ts = v => (v ? new Date(v).getTime() : 0);

/** Pure: what can this business do right now? */
function stateOf(biz, cfg, now = Date.now()) {
  const trialEnd = ts(biz.trial_ends_at) || (ts(biz.created_at) + cfg.trial_days * DAY);
  const paidEnd = ts(biz.paid_until);
  const out = { trial_ends_at: trialEnd ? new Date(trialEnd).toISOString() : null, paid_until: paidEnd ? new Date(paidEnd).toISOString() : null, plan: biz.billing_plan || null, lifetime: !!biz.lifetime, exempt: !!biz.billing_exempt, grace_days: cfg.grace_days };
  if (biz.lifetime) return { ...out, state: 'lifetime', locked: false, access_until: null, days_left: null };
  if (biz.billing_exempt) return { ...out, state: 'exempt', locked: false, access_until: null, days_left: null };
  const until = Math.max(trialEnd, paidEnd);
  const left = until - now;
  const base = { ...out, access_until: until ? new Date(until).toISOString() : null };
  if (left > 0) return { ...base, state: paidEnd > now ? 'active' : 'trial', locked: false, days_left: Math.ceil(left / DAY), hours_left: Math.ceil(left / HOUR) };
  const graceEnd = until + cfg.grace_days * DAY;
  if (cfg.grace_days > 0 && now < graceEnd) return { ...base, state: 'grace', locked: false, days_left: 0, grace_ends_at: new Date(graceEnd).toISOString(), grace_hours_left: Math.ceil((graceEnd - now) / HOUR), was_trial: !paidEnd };
  return { ...base, state: 'expired', locked: true, days_left: 0, was_trial: !paidEnd };
}
const lockedNow = (biz, cfg) => stateOf(biz, cfg).locked;

/** Shape sent to the app (safe for every member of the business). */
async function summary(biz, user) {
  if (user && user.is_developer) { /* developers see the real state but are never blocked */ }
  const cfg = await config(); const st = stateOf(biz, cfg);
  const pending = await one("SELECT id FROM billing_payments WHERE business_id=? AND status='pending' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) ORDER BY id DESC LIMIT 1", [biz.id]);
  return { ...st, autopay: { enabled: !!biz.autopay_enabled, plan: biz.autopay_plan || null, phone: maskPhone(biz.autopay_phone) }, pending_payment_id: pending ? pending.id : null, contact: cfg.contact, currency: cfg.currency };
}

/* ---------------- phones ---------------- */
function normalizePhone(p) {
  let d = String(p || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('255')) d = d.slice(3); else if (d.startsWith('0')) d = d.slice(1);
  return /^[67]\d{8}$/.test(d) ? '255' + d : null;
}
function maskPhone(p) { const d = String(p || ''); return d.length >= 9 ? d.slice(0, 5) + '••••' + d.slice(-3) : ''; }
function networkOf(p) {
  const d = String(p || '').replace(/^255/, ''); const pre = d.slice(0, 2);
  if (['74', '75', '76'].includes(pre)) return 'M-Pesa';
  if (['71', '65', '67', '77'].includes(pre)) return 'Mixx by Yas';
  if (['68', '69', '78'].includes(pre)) return 'Airtel Money';
  if (pre === '62') return 'HaloPesa';
  if (pre === '73') return 'T-Pesa';
  return 'Mobile money';
}

/* ---------------- Snippe ---------------- */
const snippeKey = () => process.env.SNIPPE_API_KEY || '';
const snippeBase = () => (process.env.SNIPPE_BASE_URL || 'https://api.snippe.sh/v1').replace(/\/+$/, '');
const configured = () => !!snippeKey();
const webhookUrl = () => process.env.BILLING_WEBHOOK_URL || (process.env.PUBLIC_API_URL ? `${process.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/billing/webhook/snippe` : null);

async function snippe(method, path, body, idem) {
  if (!configured()) throw new HttpError(503, 'Online payments are not set up yet. Please contact the developer.');
  const headers = { Authorization: `Bearer ${snippeKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (idem) headers['Idempotency-Key'] = idem;
  let res;
  try { res = await fetch(snippeBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw new HttpError(502, 'Could not reach the payment provider. Please try again in a moment.'); }
  let json = null; try { json = await res.json(); } catch (_) { /* empty */ }
  if (!res.ok) {
    const msg = (json && (json.message || (json.error && json.error.message))) || `Payment provider error (${res.status})`;
    const e = new HttpError(res.status === 401 || res.status === 403 ? 502 : (res.status >= 500 ? 502 : 400), res.status === 401 ? 'Payment provider rejected our credentials. Please contact the developer.' : msg);
    e.providerStatus = res.status; e.providerBody = json; throw e;
  }
  return (json && (json.data || json)) || {};
}

/* ---------------- payments ---------------- */
const publicPayment = p => p && ({ id: p.id, plan: p.plan, amount: Number(p.amount), currency: p.currency, status: p.status, method: p.method, phone: maskPhone(p.phone), network: p.phone ? networkOf(p.phone) : null, autopay: !!p.autopay, created_at: p.created_at, paid_at: p.paid_at, period_start: p.period_start, period_end: p.period_end, expires_at: p.expires_at, failure_reason: p.failure_reason, note: p.note, reference: p.provider_ref });

function splitName(full, fallback) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  const first = clip(parts[0] || fallback || 'Customer', 40); const last = clip(parts.slice(1).join(' ') || fallback || 'Admin', 40);
  return [first, last];
}

/** Starts a mobile-money payment: creates the row, asks Snippe to push the USSD prompt to the phone. */
async function startMobilePayment({ biz, user, plan, phone, autopay = false }) {
  const cfg = await config(); const p = cfg.plans[plan];
  if (!p || !p.enabled) throw new HttpError(400, 'That plan is not available');
  const msisdn = normalizePhone(phone); if (!msisdn) throw new HttpError(400, 'Enter a valid Tanzanian mobile-money number, e.g. 0712 345 678');
  if (!configured()) throw new HttpError(503, 'Online payments are not set up yet. Please contact the developer.');
  const amount = Math.round(p.price);
  const [r] = await q(`INSERT INTO billing_payments (business_id,plan,amount,currency,days,method,status,provider,phone,payer_user_id,autopay) VALUES (?,?,?,?,?,'mobile','pending','snippe',?,?,?)`, [biz.id, plan, amount, cfg.currency, p.days, msisdn, user ? user.id : null, autopay ? 1 : 0]).then(x => [x]);
  const id = r.insertId; const idem = `fb${id}-${crypto.randomBytes(3).toString('hex')}`;
  await q('UPDATE billing_payments SET idem_key=? WHERE id=?', [idem, id]);
  const [fn, ln] = splitName(user && user.name, biz.short_name);
  const body = {
    payment_type: 'mobile', details: { amount, currency: cfg.currency }, phone_number: msisdn,
    customer: { firstname: fn, lastname: ln, email: (user && user.email) || `billing+${biz.slug}@fourbrothers.online` },
    description: clip(`FBBMS ${p.label} plan - ${biz.short_name}`, 120),
    metadata: { payment_id: String(id), business_id: String(biz.id), plan }
  };
  const wh = webhookUrl(); if (wh) body.webhook_url = wh;
  try {
    const d = await snippe('POST', '/payments', body, idem);
    const ref = d.reference || d.id; if (!ref) throw new HttpError(502, 'The payment provider did not return a reference. Please try again.');
    const exp = d.expires_at ? new Date(d.expires_at) : new Date(Date.now() + 4 * HOUR);
    await q('UPDATE billing_payments SET provider_ref=?, expires_at=? WHERE id=?', [String(ref), isNaN(exp) ? new Date(Date.now() + 4 * HOUR) : exp, id]);
  } catch (e) {
    await q("UPDATE billing_payments SET status='failed', failure_reason=? WHERE id=?", [clip(e.message, 250), id]);
    throw e;
  }
  return one('SELECT * FROM billing_payments WHERE id=?', [id]);
}

/** Applies a completed payment to the business exactly once (safe against webhook + poll racing). */
async function applyPayment(id, { paidAt = new Date(), fees = null } = {}) {
  const out = await tx(async conn => {
    const [[pay]] = await conn.query('SELECT * FROM billing_payments WHERE id=? FOR UPDATE', [id]);
    if (!pay || pay.applied) return null;
    const [[biz]] = await conn.query('SELECT * FROM businesses WHERE id=? FOR UPDATE', [pay.business_id]);
    if (!biz) return null;
    const now = Date.now(); let start = null, end = null;
    if (pay.plan === 'lifetime') { await conn.query("UPDATE businesses SET lifetime=1, billing_plan='lifetime', autopay_enabled=0, autopay_attempts=0 WHERE id=?", [biz.id]); }
    else {
      const base = Math.max(now, ts(biz.paid_until), ts(biz.trial_ends_at)); start = new Date(base); end = new Date(base + pay.days * DAY);
      await conn.query('UPDATE businesses SET paid_until=?, billing_plan=?, autopay_attempts=0 WHERE id=?', [end, pay.plan, biz.id]);
    }
    await conn.query("UPDATE billing_payments SET status='completed', applied=1, paid_at=?, period_start=?, period_end=?, fees=?, failure_reason=NULL WHERE id=?", [paidAt, start, end, fees, id]);
    return { pay: { ...pay, period_start: start, period_end: end }, biz };
  });
  if (!out) return null;
  const { pay, biz } = out;
  rt.broadcast(biz.id, 'billing.changed', { status: 'completed', plan: pay.plan, payment_id: pay.id });
  try {
    const fresh = await one('SELECT * FROM businesses WHERE id=?', [biz.id]);
    const st = stateOf(fresh, await config());
    const fmt = n => `${pay.currency} ${Number(n).toLocaleString('en-US')}`;
    const until = pay.plan === 'lifetime' ? 'forever' : `until ${new Date(pay.period_end).toISOString().slice(0, 10)}`;
    await note(biz, { type: 'billing.paid', severity: 'info', title: `Payment received: ${fmt(pay.amount)}`, body: `Your ${pay.plan === 'lifetime' ? 'one-time' : pay.plan} plan is active ${until}. Thank you!`, dedupe: `paid:${pay.id}` });
    emailSupers(biz, `Payment received - ${biz.short_name}`, `We received ${fmt(pay.amount)} for the ${pay.plan} plan.\nAccess is active ${until}.\nReference: ${pay.provider_ref || ('#' + pay.id)}\n\nQuestions? ${((await config()).contact || {}).name} ${((await config()).contact || {}).phone}`).catch(() => {});
    void st;
  } catch (e) { console.error('billing post-pay:', e.message); }
  return pay;
}

/** Asks Snippe for the truth about one payment and updates our record. Returns the fresh row. */
async function reconcile(id, hint = null) {
  let pay = await one('SELECT * FROM billing_payments WHERE id=?', [id]);
  if (!pay || !pay.provider_ref || pay.applied) return pay;
  let status = null, fees = null, reason = null, amountOk = true;
  try {
    const d = await snippe('GET', `/payments/${encodeURIComponent(pay.provider_ref)}`);
    status = String(d.status || '').toLowerCase(); reason = d.failure_reason || d.reason || d.message || null;
    if (d.fees) fees = Number(d.fees.value ?? d.fees) || null;
    const amt = d.amount && (d.amount.value ?? d.amount); if (amt !== undefined && Number(amt) !== Number(pay.amount)) amountOk = false;
  } catch (e) { if (hint && hint.trusted) status = hint.status; else { await q('UPDATE billing_payments SET last_checked=UTC_TIMESTAMP() WHERE id=?', [id]).catch(() => {}); return pay; } }
  await q('UPDATE billing_payments SET last_checked=UTC_TIMESTAMP() WHERE id=?', [id]).catch(() => {});
  if (status === 'completed') {
    if (!amountOk) { await q("UPDATE billing_payments SET status='failed', failure_reason='Amount mismatch - needs review' WHERE id=?", [id]); console.error('billing: amount mismatch for payment', id); return one('SELECT * FROM billing_payments WHERE id=?', [id]); }
    await applyPayment(id, { fees });
  } else if (['failed', 'expired', 'voided'].includes(status) && pay.status === 'pending') {
    await q('UPDATE billing_payments SET status=?, failure_reason=? WHERE id=? AND status=\'pending\'', [status, clip(reason || (status === 'expired' ? 'The payment prompt expired' : 'The payment was declined or cancelled'), 250), id]);
    rt.broadcast(pay.business_id, 'billing.changed', { status, payment_id: id });
    if (pay.autopay) { const biz = await one('SELECT * FROM businesses WHERE id=?', [pay.business_id]); if (biz) note(biz, { type: 'billing.failed', severity: 'warn', title: 'Auto-renew payment did not go through', body: 'We could not collect your renewal. Open Billing to pay now so your shop is not paused.', dedupe: `autopayfail:${id}` }).catch(() => {}); }
  }
  return one('SELECT * FROM billing_payments WHERE id=?', [id]);
}

/** Developer-recorded payment (cash / bank / any other way). Applies immediately. */
async function recordManual({ biz, plan, amount, note: nt, userId, reference }) {
  const cfg = await config(); const p = cfg.plans[plan]; if (!p) throw new HttpError(400, 'Choose a plan');
  const amt = amount !== undefined && amount !== null && amount !== '' ? Math.round(Number(amount)) : Math.round(p.price);
  if (!Number.isFinite(amt) || amt < 0) throw new HttpError(400, 'Enter a valid amount');
  const [r] = await q(`INSERT INTO billing_payments (business_id,plan,amount,currency,days,method,status,provider,provider_ref,recorded_by,note,paid_at) VALUES (?,?,?,?,?,'manual','pending','manual',?,?,?,UTC_TIMESTAMP())`, [biz.id, plan, amt, cfg.currency, p.days, clip(reference, 80) || null, userId, clip(nt, 250) || null]).then(x => [x]);
  await applyPayment(r.insertId); return one('SELECT * FROM billing_payments WHERE id=?', [r.insertId]);
}
/** Free days from the Developer (promo, compensation...). */
async function grantDays({ biz, days, note: nt, userId }) {
  const d = Math.round(Number(days)); if (!d || d < -365 || d > 3650) throw new HttpError(400, 'Enter a number of days between 1 and 3650');
  const base = Math.max(Date.now(), ts(biz.paid_until), ts(biz.trial_ends_at)); const end = new Date(base + d * DAY);
  await q('UPDATE businesses SET paid_until=? WHERE id=?', [end, biz.id]);
  await q(`INSERT INTO billing_payments (business_id,plan,amount,currency,days,method,status,provider,recorded_by,note,paid_at,applied,period_start,period_end) VALUES (?,?,0,'TZS',?,'grant','completed','manual',?,?,UTC_TIMESTAMP(),1,?,?)`, [biz.id, biz.billing_plan || 'monthly', d, userId, clip(nt, 250) || `Granted ${d} day(s)`, new Date(base), end]);
  rt.broadcast(biz.id, 'billing.changed', { status: 'granted' });
}

/* ---------------- notifications (always delivered, even if the alerts module is off) ---------------- */
async function note(biz, { type, severity = 'info', title, body = null, dedupe = null }) {
  try {
    const r = await q('INSERT IGNORE INTO notifications (business_id,type,severity,audience,title,body,dedupe_key) VALUES (?,?,?,?,?,?,?)', [biz.id, type, severity, 'super', String(title).slice(0, 160), body, dedupe]);
    if (r.affectedRows) rt.broadcast(biz.id, 'notification', { id: r.insertId, type, severity, audience: 'super', title, body });
    return !!r.affectedRows;
  } catch (e) { console.error('billing note failed:', e.message); return false; }
}
async function emailSupers(biz, subject, text) {
  const mailer = require('../config/mailer');
  if (process.env.DISABLE_EMAIL === 'true' || !mailer.configured()) return;
  const rows = await q("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? AND m.role='super_admin' AND m.status='active' AND u.status='active'", [biz.id]);
  for (const r of rows) await mailer.sendMail({ to: r.email, subject, text }).catch(e => console.error('billing mail failed:', e.message));
}

/* ---------------- request gate ---------------- */
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_WHEN_LOCKED = ['/notifications/read'];
/** Express middleware: an unpaid business is read-only. Developers are never blocked. */
async function gate(req, res, next) {
  try {
    if (READ.has(req.method) || (req.user && req.user.is_developer)) return next();
    if (ALLOWED_WHEN_LOCKED.includes(req.path)) return next();
    const cfg = await config(); const st = stateOf(req.biz, cfg);
    if (!st.locked) return next();
    const e = new HttpError(402, `Your ${st.was_trial ? 'free trial has ended' : 'subscription has expired'}. You can still view your data, but adding or changing anything is paused until you renew.`);
    e.apiCode = 'SUBSCRIPTION_REQUIRED'; throw e;
  } catch (e) { next(e); }
}
/** Customer-facing endpoints (website orders) stay open unless the Developer chose otherwise. */
async function assertPublicOpen(biz) {
  const cfg = await config(); if (cfg.block_public_when_locked && lockedNow(biz, cfg)) throw new HttpError(503, 'This shop is temporarily not taking online orders. Please call the shop.');
}

/* ---------------- background: reconcile, autopay, reminders ---------------- */
const lastPoll = new Map();
async function reconcilePending() {
  if (!configured()) return;
  const rows = await q("SELECT id FROM billing_payments WHERE status='pending' AND provider_ref IS NOT NULL AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR) AND (last_checked IS NULL OR last_checked < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 SECOND)) ORDER BY id LIMIT 40");
  for (const r of rows) { try { await reconcile(r.id); } catch (e) { console.error('billing reconcile:', e.message); } }
  await q("UPDATE billing_payments SET status='expired', failure_reason='The payment prompt expired' WHERE status='pending' AND method='mobile' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR)").catch(() => {});
}

async function autopayTick() {
  const cfg = await config(); if (!cfg.autopay_enabled || !configured()) return;
  const bizs = await q("SELECT * FROM businesses WHERE autopay_enabled=1 AND lifetime=0 AND billing_exempt=0 AND status='active'");
  const now = Date.now();
  for (const b of bizs) {
    try {
      const plan = b.autopay_plan; const p = cfg.plans[plan]; if (!p || !p.enabled || plan === 'lifetime' || !b.autopay_phone) continue;
      const until = Math.max(ts(b.trial_ends_at), ts(b.paid_until)); const lead = plan === 'daily' ? 3 * HOUR : 24 * HOUR;
      if (now < until - lead) continue; if (now > until + 5 * DAY) continue; // later than that, the owner pays manually
      if (b.autopay_attempts >= 3) continue;
      const gap = plan === 'daily' ? HOUR : 6 * HOUR; if (b.autopay_last_attempt && now - ts(b.autopay_last_attempt) < gap) continue;
      const open = await one("SELECT id FROM billing_payments WHERE business_id=? AND status='pending' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)", [b.id]); if (open) continue;
      await q('UPDATE businesses SET autopay_attempts=autopay_attempts+1, autopay_last_attempt=UTC_TIMESTAMP() WHERE id=?', [b.id]);
      const payer = b.autopay_by ? await one('SELECT id,name,email FROM users WHERE id=?', [b.autopay_by]) : null;
      const pay = await startMobilePayment({ biz: b, user: payer, plan, phone: b.autopay_phone, autopay: true });
      await note(b, { type: 'billing.prompt', severity: 'warn', title: 'Approve your renewal on your phone', body: `We sent a ${cfg.currency} ${p.price.toLocaleString('en-US')} payment request to ${maskPhone(b.autopay_phone)}. Enter your mobile-money PIN to keep your shop running.`, dedupe: `autoprompt:${pay.id}` });
      rt.broadcast(b.id, 'billing.prompt', { payment_id: pay.id });
      emailSupers(b, `Approve your FBBMS renewal - ${b.short_name}`, `A renewal request of ${cfg.currency} ${p.price.toLocaleString('en-US')} was sent to your phone. Enter your mobile-money PIN to approve it.`).catch(() => {});
    } catch (e) {
      console.error('autopay error for', b.slug, e.message);
      if (b.autopay_attempts + 1 >= 3) note(b, { type: 'billing.failed', severity: 'critical', title: 'Auto-renew could not collect your payment', body: 'Please open Billing and pay manually so your shop is not paused.', dedupe: `autopaystop:${b.id}:${ts(b.paid_until)}` }).catch(() => {});
    }
  }
}

async function remindersTick() {
  const cfg = await config(); const bizs = await q("SELECT * FROM businesses WHERE status='active' AND lifetime=0 AND billing_exempt=0"); const now = Date.now();
  for (const b of bizs) {
    const st = stateOf(b, cfg); if (!st.access_until) continue; const until = new Date(st.access_until).getTime(); const tag = new Date(until).toISOString().slice(0, 10);
    const what = st.was_trial !== undefined ? (st.was_trial ? 'free trial' : 'plan') : (st.state === 'trial' ? 'free trial' : 'plan');
    if (st.state === 'trial' || st.state === 'active') {
      const d = st.days_left;
      if ([7, 3, 1].includes(d)) await note(b, { type: 'billing.reminder', severity: d <= 3 ? 'warn' : 'info', title: `Your ${what} ends in ${d} day${d === 1 ? '' : 's'}`, body: `Renew from Billing & plan to keep adding sales, stock and orders. Questions? Call ${cfg.contact.name} on ${cfg.contact.phone}.`, dedupe: `rem:${tag}:${d}` }) && emailSupers(b, `Your FBBMS ${what} ends in ${d} day(s) - ${b.short_name}`, `Renew from Billing & plan inside FBBMS to keep your shop running.\nSupport: ${cfg.contact.name} ${cfg.contact.phone}`).catch(() => {});
    } else if (st.state === 'grace') {
      await note(b, { type: 'billing.reminder', severity: 'critical', title: 'Your subscription has ended', body: `You have a short grace period. Renew now or your shop becomes read-only on ${st.grace_ends_at.slice(0, 10)}.`, dedupe: `grace:${tag}` });
    } else if (st.state === 'expired') {
      const first = await note(b, { type: 'billing.locked', severity: 'critical', title: 'Your shop is now read-only', body: `You can still view your data, but new entries and exports are paused until you renew. Call ${cfg.contact.name} on ${cfg.contact.phone} if you need help.`, dedupe: `locked:${tag}` });
      if (first) { emailSupers(b, `Your FBBMS access is paused - ${b.short_name}`, `Your data is safe and viewable, but adding new data and exporting are paused until you renew.\nSupport: ${cfg.contact.name} ${cfg.contact.phone}`).catch(() => {}); rt.broadcast(b.id, 'billing.changed', { status: 'locked' }); }
    }
  }
  void now;
}

let timers = [];
function start() {
  if (process.env.DISABLE_SCHEDULER === 'true') return;
  timers.push(setInterval(() => reconcilePending().catch(e => console.error('billing reconcile tick:', e.message)), 60 * 1000).unref());
  timers.push(setInterval(() => autopayTick().catch(e => console.error('autopay tick:', e.message)), 10 * 60 * 1000).unref());
  timers.push(setInterval(() => remindersTick().catch(e => console.error('reminders tick:', e.message)), 30 * 60 * 1000).unref());
  setTimeout(() => { reconcilePending().catch(() => {}); remindersTick().catch(() => {}); autopayTick().catch(() => {}); }, 25000).unref();
}

module.exports = { PLAN_ORDER, DEFAULTS, config, saveConfig, stateOf, lockedNow, summary, normalizePhone, maskPhone, networkOf, configured, webhookUrl, snippe, publicPayment, startMobilePayment, applyPayment, reconcile, recordManual, grantDays, gate, assertPublicOpen, note, emailSupers, start, reconcilePending, autopayTick, remindersTick, lastPoll };
