const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { q, one } = require('../config/db');
const mailer = require('../config/mailer');
const { signToken, authenticate } = require('../middleware/auth');
const { bad, wrap, HttpError, clip, emailOk, safeJSON } = require('../lib/util');
const { audit } = require('../lib/audit');
const { ALL_KEYS } = require('../lib/permissions');

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many attempts. Try again in a few minutes.' } });

async function profileOf(user) {
  const memberships = user.is_developer
    ? (await q('SELECT id,slug,code,name,short_name,template,tagline,currency,status,theme FROM businesses ORDER BY id')).map(b => ({ business: b, role: 'super_admin', permissions: ALL_KEYS, developer: true }))
    : (await q(`SELECT m.id AS membership_id,m.role,m.permissions,b.id,b.slug,b.code,b.name,b.short_name,b.template,b.tagline,b.currency,b.status,b.theme
                FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=? AND m.status='active' AND b.status='active' ORDER BY b.id`, [user.id]))
        .map(r => ({ business: { id: r.id, slug: r.slug, code: r.code, name: r.name, short_name: r.short_name, template: r.template, tagline: r.tagline, currency: r.currency, status: r.status, theme: r.theme }, role: r.role, permissions: r.role === 'super_admin' ? ALL_KEYS : safeJSON(r.permissions, []) }));
  memberships.forEach(m => { m.business.theme = safeJSON(m.business.theme, {}); });
  return { id: user.id, name: user.name, email: user.email, phone: user.phone, is_developer: !!user.is_developer, must_change_password: !!user.must_change_password, memberships };
}

const needsOtp = async user => {
  if (String(process.env.OTP_ENABLED).toLowerCase() === 'false') return false;
  if (!mailer.configured()) return false; // not configured -> password only (log a warning at boot)
  if (user.is_developer) return true;
  const r = await one("SELECT 1 AS x FROM memberships WHERE user_id=? AND role='super_admin' AND status='active' LIMIT 1", [user.id]);
  return !!r;
};

async function issueOtp(user) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await bcrypt.hash(code, 8);
  await q('UPDATE otp_codes SET used=1 WHERE user_id=? AND used=0', [user.id]);
  await q('INSERT INTO otp_codes (user_id,code_hash,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))', [user.id, hash]);
  await mailer.sendOTP(user.email, user.name, code);
  return jwt.sign({ uid: user.id, t: 'otp' }, secret(), { expiresIn: '12m' });
}

const maskEmail = e => e.replace(/^(.{2}).*(@.*)$/, '$1•••$2');

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = clip(req.body.email, 150).toLowerCase();
  const password = String(req.body.password || '');
  if (!emailOk(email) || !password) throw bad('Enter your email and password');
  const user = await one('SELECT * FROM users WHERE email=?', [email]);
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) { await audit(req, { business_id: null, action: 'login.failed', details: { email } }); throw new HttpError(401, 'Incorrect email or password'); }
  if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled. Contact your Super Admin.');

  if (await needsOtp(user)) {
    try { const challenge = await issueOtp(user); return res.json({ otp_required: true, challenge, email: maskEmail(user.email) }); }
    catch (e) { console.error('OTP mail error:', e.message); throw new HttpError(502, 'Could not send the verification code. Check the email settings on the server.'); }
  }
  await q('UPDATE users SET last_login=UTC_TIMESTAMP() WHERE id=?', [user.id]);
  req.user = user; await audit(req, { business_id: null, action: 'login.ok' });
  res.json({ token: signToken(user), profile: await profileOf(user) });
}));

router.post('/verify-otp', loginLimiter, wrap(async (req, res) => {
  let p; try { p = jwt.verify(String(req.body.challenge || ''), secret()); } catch { throw new HttpError(401, 'Code expired. Sign in again.'); }
  if (p.t !== 'otp') throw new HttpError(401, 'Invalid request');
  const code = String(req.body.otp || '').trim();
  const rec = await one('SELECT * FROM otp_codes WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1', [p.uid]);
  if (!rec || new Date(rec.expires_at) < new Date()) throw new HttpError(401, 'Code expired. Request a new one.');
  if (rec.attempts >= 5) { await q('UPDATE otp_codes SET used=1 WHERE id=?', [rec.id]); throw new HttpError(429, 'Too many wrong attempts. Sign in again.'); }
  if (!(await bcrypt.compare(code, rec.code_hash))) { await q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?', [rec.id]); throw new HttpError(401, 'Wrong code'); }
  await q('UPDATE otp_codes SET used=1 WHERE id=?', [rec.id]);
  const user = await one('SELECT * FROM users WHERE id=? AND status="active"', [p.uid]);
  if (!user) throw new HttpError(401, 'Account unavailable');
  await q('UPDATE users SET last_login=UTC_TIMESTAMP() WHERE id=?', [user.id]);
  req.user = user; await audit(req, { business_id: null, action: 'login.ok', details: { otp: true } });
  res.json({ token: signToken(user), profile: await profileOf(user) });
}));

router.post('/resend-otp', loginLimiter, wrap(async (req, res) => {
  let p; try { p = jwt.verify(String(req.body.challenge || ''), secret()); } catch { throw new HttpError(401, 'Session expired. Sign in again.'); }
  const user = await one('SELECT * FROM users WHERE id=? AND status="active"', [p.uid]);
  if (!user) throw new HttpError(401, 'Account unavailable');
  res.json({ challenge: await issueOtp(user) });
}));

router.get('/me', authenticate, wrap(async (req, res) => res.json(await profileOf(req.user))));

router.put('/profile', authenticate, wrap(async (req, res) => {
  const name = clip(req.body.name, 120); const phone = clip(req.body.phone, 30);
  if (name.length < 2) throw bad('Enter your name');
  await q('UPDATE users SET name=?, phone=? WHERE id=?', [name, phone || null, req.user.id]);
  res.json({ ok: true });
}));

router.post('/change-password', authenticate, loginLimiter, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  const u = await one('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!(await bcrypt.compare(String(current_password || ''), u.password_hash))) throw new HttpError(401, 'Current password is wrong');
  if (String(new_password || '').length < 8) throw bad('New password must be at least 8 characters');
  await q('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', [await bcrypt.hash(new_password, 11), u.id]);
  await audit(req, { business_id: null, action: 'password.changed' });
  res.json({ ok: true });
}));

// Public: platform theme (colours/name) so the login page matches the developer's choice.
router.get('/theme', wrap(async (req, res) => {
  const r = await one("SELECT v FROM platform_settings WHERE k='theme'");
  res.json(safeJSON(r && r.v, { name: 'FBBMS', primary: '#d4af55', accent: '#f1d98a', mode: 'dark' }));
}));

module.exports = router;
module.exports.profileOf = profileOf;
