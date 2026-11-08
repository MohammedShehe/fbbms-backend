// Super-Admin tools inside one business: team, permissions, settings, audit trail.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { q, one, tx } = require('../config/db');
const { requireSuper } = require('../middleware/auth');
const { bad, conflict, forbidden, notFound, wrap, clip, int, emailOk, genPassword, safeJSON, isDate, eatDate, addDays } = require('../lib/util');
const { PERMISSIONS, ALL_KEYS, DEFAULT_SUB } = require('../lib/permissions');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');
const tzu = require('../lib/tz');
const modules = require('../lib/modules');
const logo = require('../lib/logo');

// Barber / car-rental permissions are only offered when that module is switched on for the business.
const PERM_MODULE = { 'Barber shop': 'barber', 'Car rental': 'rentals' };
router.get('/permissions', (req, res) => res.json({ permissions: PERMISSIONS.filter(p => !PERM_MODULE[p.group] || modules.enabled(req.biz, PERM_MODULE[p.group])), defaults: DEFAULT_SUB }));

router.get('/business', wrap(async (req, res) => {
  const b = req.biz; const billingInfo = await require('../lib/billing').summary(b, req.user); res.json({ billing: billingInfo, id: b.id, slug: b.slug, code: b.code, name: b.name, short_name: b.short_name, template: b.template, tagline: b.tagline, currency: b.currency, settings: b.settings, theme: b.theme, modules: modules.state(b), timezone: tzu.bizTz(b), group_id: b.group_id || null, role: req.member.role, permissions: [...req.member.permissions] });
}));

const cleanPerms = arr => [...new Set((Array.isArray(arr) ? arr : []).filter(k => ALL_KEYS.includes(k)))];

// ---------- team ----------
router.get('/team', requireSuper, wrap(async (req, res) => {
  const d30 = addDays(tzu.today(req.biz), -29);
  const rows = await q(`SELECT m.id, m.user_id, m.role, m.status, m.permissions, m.created_at, u.name, u.email, u.phone, u.last_login, u.status AS user_status,
      (SELECT COUNT(*) FROM sales s WHERE s.business_id=m.business_id AND s.sold_by=u.id AND s.status='completed' AND s.sale_date>=?) AS sales_30d,
      (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.business_id=m.business_id AND s.sold_by=u.id AND s.status='completed' AND s.sale_date>=?) AS revenue_30d,
      (SELECT COUNT(*) FROM sales s WHERE s.business_id=m.business_id AND s.sold_by=u.id AND s.status='voided' AND s.sale_date>=?) AS voids_30d
      FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? ORDER BY (m.role='super_admin') DESC, u.name`, [d30, d30, d30, req.biz.id]);
  rows.forEach(r => { r.permissions = r.role === 'super_admin' ? ALL_KEYS : safeJSON(r.permissions, []); });
  res.json(rows);
}));

router.post('/team', requireSuper, wrap(async (req, res) => {
  const name = clip(req.body.name, 120), email = clip(req.body.email, 150).toLowerCase(), phone = clip(req.body.phone, 30);
  if (name.length < 2) throw bad('Enter the full name'); if (!emailOk(email)) throw bad('Enter a valid email');
  const perms = cleanPerms(req.body.permissions && req.body.permissions.length ? req.body.permissions : DEFAULT_SUB);
  const out = await tx(async conn => {
    let [[u]] = await conn.query('SELECT * FROM users WHERE email=?', [email]);
    let temp = null;
    if (!u) {
      temp = clip(req.body.password, 100) || genPassword(12);
      if (temp.length < 8) throw bad('Password must be at least 8 characters');
      const [r] = await conn.query('INSERT INTO users (name,email,phone,password_hash,must_change_password) VALUES (?,?,?,?,1)', [name, email, phone || null, await bcrypt.hash(temp, 11)]);
      u = { id: r.insertId };
    } else if (u.is_developer) throw forbidden('That email belongs to a platform account');
    try { await conn.query("INSERT INTO memberships (user_id,business_id,role,permissions,created_by) VALUES (?,?,'sub_admin',?,?)", [u.id, req.biz.id, JSON.stringify(perms), req.user.id]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That person is already on this team'); throw e; }
    await audit(req, { action: 'team.add', entity: 'user', entity_id: u.id, details: { name, email, perms }, conn });
    return { user_id: u.id, temp_password: temp, existing_user: !temp };
  });
  res.json(out);
}));

async function getSub(req) {
  const m = await one('SELECT m.*, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.business_id=?', [req.params.mid, req.biz.id]);
  if (!m) throw notFound('Team member not found');
  if (m.role === 'super_admin' && !req.user.is_developer) throw forbidden('Only the Developer can change a Super Admin');
  return m;
}

router.put('/team/:mid', requireSuper, wrap(async (req, res) => {
  const m = await getSub(req);
  if (m.user_id === req.user.id && req.body.status === 'disabled') throw bad('You cannot disable yourself');
  const status = req.body.status === 'disabled' ? 'disabled' : req.body.status === 'active' ? 'active' : m.status;
  const perms = req.body.permissions !== undefined && m.role === 'sub_admin' ? cleanPerms(req.body.permissions) : null;
  await q('UPDATE memberships SET status=?, permissions=COALESCE(?,permissions) WHERE id=?', [status, perms ? JSON.stringify(perms) : null, m.id]);
  if (req.body.name !== undefined || req.body.phone !== undefined) await q('UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone) WHERE id=?', [req.body.name ? clip(req.body.name, 120) : null, req.body.phone !== undefined ? clip(req.body.phone, 30) : null, m.user_id]);
  await audit(req, { action: 'team.update', entity: 'user', entity_id: m.user_id, details: { name: m.name, status, perms } });
  res.json({ ok: true });
}));

router.post('/team/:mid/revoke-sessions', requireSuper, wrap(async (req, res) => {
  const m = await getSub(req); const r = await q('UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0', [m.user_id]);
  await audit(req, { action: 'team.revoke_sessions', entity: 'user', entity_id: m.user_id, details: { name: m.name, count: r.affectedRows } }); res.json({ revoked: r.affectedRows });
}));
router.get('/team/:mid/logins', requireSuper, wrap(async (req, res) => { const m = await getSub(req); res.json({ history: await q('SELECT success,ip,user_agent,note,created_at FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 30', [m.user_id]), sessions: await q('SELECT id,ip,device,created_at,last_seen FROM sessions WHERE user_id=? AND revoked=0 ORDER BY last_seen DESC LIMIT 10', [m.user_id]) }); }));
router.post('/team/:mid/reset-password', requireSuper, wrap(async (req, res) => {
  const m = await getSub(req);
  if (m.role === 'super_admin') throw forbidden('Ask the Developer to reset a Super Admin password');
  const temp = genPassword(12);
  await q('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [await bcrypt.hash(temp, 11), m.user_id]);
  await audit(req, { action: 'team.reset_password', entity: 'user', entity_id: m.user_id, details: { name: m.name } });
  res.json({ temp_password: temp });
}));

// ---------- settings ----------
const TEXT_KEYS = ['phone', 'whatsapp', 'email', 'address', 'location', 'instagram', 'facebook', 'tiktok', 'website', 'hours', 'order_note', 'delivery_note', 'about', 'mission', 'vision', 'hero_title', 'hero_subtitle', 'announcement', 'map_url', 'tin'];
router.get('/settings', requireSuper, wrap(async (req, res) => res.json({ name: req.biz.name, short_name: req.biz.short_name, tagline: req.biz.tagline, currency: req.biz.currency, settings: req.biz.settings, theme: req.biz.theme })));
router.put('/settings', requireSuper, wrap(async (req, res) => {
  const b = req.body || {}; const s = { ...req.biz.settings }; const inS = b.settings || {};
  TEXT_KEYS.forEach(k => { if (inS[k] !== undefined) s[k] = clip(inS[k], k === 'about' || k === 'mission' || k === 'vision' ? 2000 : 400); });
  if (inS.max_discount_pct !== undefined) { const n = Number(inS.max_discount_pct); if (!(n >= 0 && n <= 100)) throw bad('Discount limit must be 0-100%'); s.max_discount_pct = n; }
  if (inS.founder && typeof inS.founder === 'object') { const f = inS.founder; s.founder = { name: clip(f.name, 120), title: clip(f.title, 120), bio: clip(f.bio, 1500), since: clip(f.since, 40), phone: clip(f.phone, 30), portfolio: clip(f.portfolio, 200), origin: clip(f.origin, 80) }; }
  if (Array.isArray(inS.values)) s.values = inS.values.slice(0, 6).map(v => ({ title: clip(v.title, 60), text: clip(v.text, 240) }));
  if (typeof inS.website_enabled === 'boolean') s.website_enabled = inS.website_enabled;
  if (inS.language !== undefined) { if (!['en', 'sw'].includes(inS.language)) throw bad('Choose English or Swahili'); s.language = inS.language; }
  // regional + business rules
  if (inS.timezone !== undefined) { if (!tzu.valid(inS.timezone)) throw bad('Unknown time zone (example: Africa/Nairobi)'); s.timezone = inS.timezone; }
  if (inS.date_format !== undefined) s.date_format = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].includes(inS.date_format) ? inS.date_format : 'DD/MM/YYYY';
  const pctIn = (k, max = 100) => { if (inS[k] !== undefined) { const n = Number(inS[k]); if (!(n >= 0 && n <= max)) throw bad(`${k} must be between 0 and ${max}`); s[k] = n; } };
  pctIn('tax_rate_pct', 100); pctIn('expense_approval_limit', 1e12); pctIn('refund_limit_shopkeeper', 1e12); pctIn('alert_refund_amount', 1e12); pctIn('alert_discount_pct', 100); pctIn('loyalty_spend_per_point', 1e9); pctIn('loyalty_point_value', 1e9); pctIn('vip_spend', 1e12); pctIn('summary_hour', 23);
  ['tax_inclusive', 'allow_credit', 'auto_register_customers', 'loyalty_enabled', 'notify_email', 'require_otp_all'].forEach(k => { if (typeof inS[k] === 'boolean') s[k] = inS[k]; });
  if (inS.tax_name !== undefined) s.tax_name = clip(inS.tax_name, 20) || 'VAT';
  const theme = { ...req.biz.theme }; const t = b.theme || {};
  ['primary', 'accent'].forEach(k => { if (t[k] !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(t[k])) throw bad('Colours must look like #d4af55'); theme[k] = t[k]; } });
  await q('UPDATE businesses SET tagline=COALESCE(?,tagline), settings=?, theme=? WHERE id=?', [b.tagline !== undefined ? clip(b.tagline, 200) : null, JSON.stringify(s), JSON.stringify(theme), req.biz.id]);
  await audit(req, { action: 'settings.update', entity: 'business', entity_id: req.biz.id });
  rt.broadcast(req.biz.id, 'settings.changed', {});
  res.json({ ok: true });
}));

// ---------- business logo (Super Admin; the Developer can do it for any business) ----------
router.post('/logo', requireSuper, wrap(async (req, res) => {
  const r = await logo.setLogo(req.biz, req.body && req.body.data);
  await audit(req, { action: 'logo.update', entity: 'business', entity_id: req.biz.id, details: { public_id: r.public_id } });
  rt.broadcast(req.biz.id, 'settings.changed', {});
  res.json({ ok: true, logo_url: r.logo_url });
}));
router.delete('/logo', requireSuper, wrap(async (req, res) => {
  const r = await logo.clearLogo(req.biz);
  if (r.had) { await audit(req, { action: 'logo.remove', entity: 'business', entity_id: req.biz.id }); rt.broadcast(req.biz.id, 'settings.changed', {}); }
  res.json({ ok: true, logo_url: null });
}));

// ---------- audit trail ----------
router.get('/audit', requireSuper, wrap(async (req, res) => {
  const w = ['a.business_id=?']; const a = [req.biz.id];
  if (req.query.user) { w.push('a.user_id=?'); a.push(int(req.query.user)); }
  if (req.query.action) { w.push('a.action LIKE ?'); a.push(clip(req.query.action, 40) + '%'); }
  if (isDate(req.query.from)) { w.push('DATE(DATE_ADD(a.created_at, INTERVAL ? MINUTE))>=?'); a.push(tzu.offset(req.biz), req.query.from); }
  if (isDate(req.query.to)) { w.push('DATE(DATE_ADD(a.created_at, INTERVAL ? MINUTE))<=?'); a.push(tzu.offset(req.biz), req.query.to); }
  if (req.query.q) { w.push('(a.details LIKE ? OR a.action LIKE ?)'); a.push(`%${clip(req.query.q, 50)}%`, `%${clip(req.query.q, 50)}%`); }
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(200, int(req.query.limit, 50));
  const where = w.join(' AND ');
  const total = (await one(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${where}`, a)).n;
  const rows = await q(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  rows.forEach(r => { r.details = safeJSON(r.details, null); });
  res.json({ rows, total, page, limit });
}));

module.exports = router;
