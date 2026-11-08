// Developer console: platform-wide control of businesses, super admins, theme.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { q, one, tx } = require('../config/db');
const { authenticate, requireDeveloper } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, emailOk, slugify, genPassword, safeJSON, eatDate, startOfMonth, addDays, isDate } = require('../lib/util');
const { TEMPLATES } = require('../lib/templates');
const { audit } = require('../lib/audit');
const logo = require('../lib/logo');
const currencies = require('../lib/currencies');
const modulesLib = require('../lib/modules');
const bizDelete = require('../lib/business-delete');

router.use(authenticate, requireDeveloper);

const tplPublic = ([key, t]) => ({ key, label: t.label, description: t.description, categories: t.categories, theme: t.theme, currency: t.currency || t.settings.currency || 'TZS', timezone: t.settings.timezone || null, modules: t.settings.modules || null, starter_services: (t.starter_services || []).length, starter_products: (t.starter_products || []).length });
router.get('/templates', (req, res) => res.json(Object.entries(TEMPLATES).map(tplPublic)));
router.get('/currencies', (req, res) => res.json(currencies.CURRENCIES));

/** Starter data for a template. Only adds what is missing, never touches existing rows. */
async function applyTemplateData(conn, bizId, t, { skuPrefix } = {}) {
  const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM categories WHERE business_id=?', [bizId]); let i = mx.n;
  for (const c of t.categories || []) { const [r] = await conn.query('INSERT IGNORE INTO categories (business_id,name,sort_order) VALUES (?,?,?)', [bizId, c, i]); if (r.affectedRows) i++; }
  let services = 0, products = 0;
  if ((t.starter_services || []).length) {
    const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM barber_services WHERE business_id=?', [bizId]);
    if (!c.n) for (const [k, sv] of t.starter_services.entries()) { await conn.query('INSERT IGNORE INTO barber_services (business_id,name,price,duration_min,sort_order) VALUES (?,?,0,?,?)', [bizId, sv.name, sv.duration_min, k]); services++; }
  }
  if ((t.starter_products || []).length) {
    const [[cat]] = await conn.query('SELECT id FROM categories WHERE business_id=? AND name=?', [bizId, (t.categories || [])[0]]);
    const [[c]] = await conn.query("SELECT COUNT(*) AS n FROM products WHERE business_id=? AND category_id<=>?", [bizId, cat ? cat.id : null]);
    if (!c.n) for (const [k, name] of t.starter_products.entries()) { await conn.query('INSERT IGNORE INTO products (business_id,category_id,sku,name,cost_price,price,stock_qty,low_stock_at,track_stock,is_published) VALUES (?,?,?,?,0,0,0,5,1,0)', [bizId, cat ? cat.id : null, `${skuPrefix || 'ST'}-${String(k + 1).padStart(3, '0')}`, name]); products++; }
  }
  return { services, products };
}

router.get('/overview', wrap(async (req, res) => {
  const today = eatDate(); const mtd = startOfMonth(today); const d14 = addDays(today, -13);
  const totals = await one(`SELECT (SELECT COUNT(*) FROM businesses) AS businesses, (SELECT COUNT(*) FROM businesses WHERE status='active') AS active_businesses,
     (SELECT COUNT(*) FROM users WHERE is_developer=0) AS users, (SELECT COUNT(*) FROM memberships WHERE role='super_admin') AS super_admins, (SELECT COUNT(*) FROM memberships WHERE role='sub_admin') AS sub_admins,
     (SELECT COUNT(*) FROM products WHERE status='active') AS products, (SELECT COUNT(*) FROM orders WHERE status='new') AS new_orders`);
  // Monetary totals are intentionally grouped by each business currency. Never add unlike currencies.
  const revenueByCurrency = await q(`SELECT b.currency,
     COALESCE(SUM(CASE WHEN s.status='completed' AND s.sale_date=? THEN s.total ELSE 0 END),0) AS revenue_today,
     COALESCE(SUM(CASE WHEN s.status='completed' AND s.sale_date>=? THEN s.total ELSE 0 END),0) AS revenue_month
     FROM businesses b LEFT JOIN sales s ON s.business_id=b.id
     GROUP BY b.currency ORDER BY b.currency`, [today, mtd]);
  const perBiz = await q(`SELECT b.id,b.slug,b.name,b.short_name,b.status,b.template,b.theme,b.currency,
     (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.business_id=b.id AND s.status='completed' AND s.sale_date=?) AS revenue_today,
     (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.business_id=b.id AND s.status='completed' AND s.sale_date>=?) AS revenue_month
     FROM businesses b ORDER BY b.id`, [today, mtd]);
  perBiz.forEach(r => { r.logo_url = safeJSON(r.theme, {}).logo_url || null; delete r.theme; });
  const series = await q(`SELECT s.sale_date AS d, b.short_name AS name, b.currency, SUM(s.total) AS revenue FROM sales s JOIN businesses b ON b.id=s.business_id WHERE s.status='completed' AND s.sale_date>=? GROUP BY s.sale_date, b.short_name, b.currency ORDER BY s.sale_date, b.currency, b.short_name`, [d14]);
  const recent = await q('SELECT a.*, u.name AS user_name, b.short_name AS business FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN businesses b ON b.id=a.business_id ORDER BY a.id DESC LIMIT 12');
  recent.forEach(r => { r.details = safeJSON(r.details, null); });
  res.json({ totals, revenue_by_currency: revenueByCurrency, per_business: perBiz, series, recent, today, days: Array.from({ length: 14 }, (_, i) => addDays(d14, i)) });
}));

// ---------- businesses ----------
router.get('/businesses', wrap(async (req, res) => {
  const rows = await q(`SELECT b.*, (SELECT COUNT(*) FROM memberships m WHERE m.business_id=b.id AND m.role='super_admin') AS super_admins, (SELECT COUNT(*) FROM memberships m WHERE m.business_id=b.id AND m.role='sub_admin') AS sub_admins,
    (SELECT COUNT(*) FROM products p WHERE p.business_id=b.id AND p.status='active') AS products, (SELECT COUNT(*) FROM sales s WHERE s.business_id=b.id) AS sales_count FROM businesses b ORDER BY b.id`);
  const bcfg = await require('../lib/billing').config(); const bl = require('../lib/billing');
  rows.forEach(r => { r.settings = safeJSON(r.settings, {}); r.theme = safeJSON(r.theme, {}); r.billing = bl.stateOf(r, bcfg); r.billing.autopay = !!r.autopay_enabled; delete r.autopay_phone; });
  res.json(rows);
}));

router.post('/businesses', wrap(async (req, res) => {
  const name = clip(req.body.name, 150); if (name.length < 2) throw bad('Enter the business name');
  const short = clip(req.body.short_name, 60) || name;
  const slug = slugify(req.body.slug || short); const code = clip(req.body.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '') || slug.slice(0, 3).toUpperCase();
  if (!slug || code.length < 2) throw bad('Enter a valid short code and web slug');
  const t = TEMPLATES[req.body.template] || TEMPLATES.general; const tkey = TEMPLATES[req.body.template] ? req.body.template : 'general';
  const settings = { ...t.settings, ...(req.body.settings || {}) }; const theme = { ...t.theme, ...logo.stripLogo(req.body.theme) };
  if (settings.language !== undefined && !['en', 'sw'].includes(settings.language)) delete settings.language;
  const cur = req.body.currency ? currencies.normalize(req.body.currency) : (t.currency || t.settings.currency || 'TZS'); if (!cur) throw bad('Choose a currency from the list');
  const id = await tx(async conn => {
    let r;
    try { [r] = await conn.query('INSERT INTO businesses (slug,code,name,short_name,template,tagline,currency,settings,theme,trial_ends_at) VALUES (?,?,?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))', [slug, code, name, short, tkey, clip(req.body.tagline, 200) || null, cur, JSON.stringify(settings), JSON.stringify(theme), (await require('../lib/billing').config()).trial_days]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('A business with that code or slug already exists'); throw e; }
    await applyTemplateData(conn, r.insertId, t, { skuPrefix: settings.sku_prefix });
    await audit(req, { business_id: r.insertId, action: 'business.create', entity: 'business', entity_id: r.insertId, details: { name, template: tkey }, conn });
    return r.insertId;
  });
  res.json({ id });
}));

// What would change if this business were switched to another type. Nothing is written.
router.get('/businesses/:id/type-preview', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const t = TEMPLATES[req.query.template]; if (!t) throw bad('Unknown business type');
  const s = safeJSON(b.settings, {}); const cur = modulesLib.state({ settings: s }); const want = t.settings.modules || {};
  const turnOn = Object.keys(want).filter(k => want[k] && !cur[k]);
  const have = await q('SELECT name FROM categories WHERE business_id=?', [b.id]); const names = new Set(have.map(x => x.name));
  const cnt = async tb => (await one(`SELECT COUNT(*) AS n FROM ${tb} WHERE business_id=?`, [b.id])).n;
  res.json({ from: b.template, to: req.query.template, modules_on: turnOn.map(k => (modulesLib.MODULES.find(m => m.key === k) || { label: k }).label), new_categories: (t.categories || []).filter(c => !names.has(c)), starter_services: (t.starter_services || []).length, starter_products: (t.starter_products || []).length,
    keeps: { sales: await cnt('sales'), products: await cnt('products'), customers: await cnt('customers'), admins: await cnt('memberships') } });
}));

router.put('/businesses/:id', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const s = { ...safeJSON(b.settings, {}), ...(req.body.settings || {}) }; let th = { ...safeJSON(b.theme, {}), ...logo.stripLogo(req.body.theme) };
  if (req.body.settings && req.body.settings.language !== undefined && !['en', 'sw'].includes(req.body.settings.language)) throw bad('Choose English or Swahili');
  const status = req.body.status === 'suspended' ? 'suspended' : req.body.status === 'active' ? 'active' : b.status;
  let slug = b.slug; if (req.body.slug) slug = slugify(req.body.slug);
  let cur = b.currency; if (req.body.currency && String(req.body.currency).trim().toUpperCase() !== b.currency) { cur = currencies.normalize(req.body.currency); if (!cur) throw bad('Choose a currency from the list'); }
  // Business type change: existing data, admins and settings are kept; the new type only ADDS its module, categories and starter data.
  let tkey = b.template; let typeChange = null;
  if (req.body.template && req.body.template !== b.template) {
    const t = TEMPLATES[req.body.template]; if (!t) throw bad('Unknown business type');
    tkey = req.body.template; const modsNow = modulesLib.state({ settings: s }); const want = t.settings.modules || {}; const next = { ...modsNow };
    Object.keys(want).forEach(k => { if (want[k]) next[k] = true; });
    if (req.body.disable_old_modules) ['barber', 'rentals'].forEach(k => { if (!want[k] && next[k]) next[k] = false; }); // hides the old tools; their data stays in the database
    s.modules = next;
    if (t.settings.home) s.home = t.settings.home; // opens that type's dashboard; existing data and pages stay reachable
    if (req.body.apply_type_theme) th = { ...th, primary: t.theme.primary, accent: t.theme.accent };
    if (req.body.apply_type_region && t.settings.timezone) s.timezone = t.settings.timezone;
    if (t.settings.maintenance_reminder_days && s.maintenance_reminder_days === undefined) s.maintenance_reminder_days = t.settings.maintenance_reminder_days;
    if (t.settings.default_commission_pct !== undefined && s.default_commission_pct === undefined) s.default_commission_pct = t.settings.default_commission_pct;
    if (t.settings.booking_channel && !s.booking_channel) s.booking_channel = t.settings.booking_channel;
    typeChange = { from: b.template, to: tkey, t };
  }
  const added = await tx(async conn => {
    try { await conn.query('UPDATE businesses SET name=?, short_name=?, tagline=?, currency=?, status=?, slug=?, template=?, settings=?, theme=? WHERE id=?',
      [clip(req.body.name, 150) || b.name, clip(req.body.short_name, 60) || b.short_name, req.body.tagline !== undefined ? clip(req.body.tagline, 200) : b.tagline, cur, status, slug, tkey, JSON.stringify(s), JSON.stringify(th), b.id]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That slug is already used'); throw e; }
    return typeChange ? applyTemplateData(conn, b.id, typeChange.t, { skuPrefix: s.sku_prefix || typeChange.t.settings.sku_prefix }) : null;
  });
  await audit(req, { business_id: b.id, action: 'business.update', entity: 'business', entity_id: b.id, details: { status, ...(cur !== b.currency ? { currency: { from: b.currency, to: cur } } : {}), ...(typeChange ? { type: { from: typeChange.from, to: typeChange.to }, added } : {}) } });
  require('../lib/realtime').broadcast(b.id, 'settings.changed', {});
  res.json({ ok: true, ...(typeChange ? { type_changed: true, added } : {}) });
}));

// ---------- safe deletion ----------
router.get('/businesses/:id/delete-preview', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  res.json({ id: b.id, name: b.name, slug: b.slug, ...(await bizDelete.preview(b)) });
}));
router.get('/businesses/:id/export', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const data = await bizDelete.exportData(b);
  await audit(req, { business_id: b.id, action: 'business.export', entity: 'business', entity_id: b.id, details: { tables: Object.keys(data.tables).length } });
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${b.slug}-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  res.send(JSON.stringify(data));
}));
router.delete('/businesses/:id', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  if (String(req.body && req.body.confirm_slug || '').trim().toLowerCase() !== b.slug.toLowerCase()) throw bad(`Type the business web slug (${b.slug}) exactly to confirm`);
  if (!req.body.understand) throw bad('Tick the box to confirm you understand this cannot be undone');
  const me = await one('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.password || ''), me.password_hash))) throw bad('Your password is not correct');
  const pv = await bizDelete.preview(b); if (pv.pending_payments) throw conflict('A subscription payment for this business is still being processed. Wait for it to finish, then try again.');
  const r = await bizDelete.remove(b, { deleteOrphanUsers: req.body.delete_users !== false });
  await audit(req, { business_id: null, action: 'business.delete', entity: 'business', entity_id: b.id, details: { name: b.name, slug: b.slug, template: b.template, rows_deleted: r.total_rows, sales: r.sales.count, users_deleted: r.users_deleted, images_removed: r.images_removed } });
  res.json({ ok: true, deleted: { name: b.name, rows: r.total_rows, users: r.users_deleted, images: r.images_removed } });
}));

router.post('/businesses/:id/logo', wrap(async (req, res) => {
  const b = await one('SELECT id,slug FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const r = await logo.setLogo(b, req.body && req.body.data);
  await audit(req, { business_id: b.id, action: 'logo.update', entity: 'business', entity_id: b.id, details: { public_id: r.public_id } });
  require('../lib/realtime').broadcast(b.id, 'settings.changed', {});
  res.json({ ok: true, logo_url: r.logo_url });
}));
router.delete('/businesses/:id/logo', wrap(async (req, res) => {
  const b = await one('SELECT id,slug FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const r = await logo.clearLogo(b);
  if (r.had) { await audit(req, { business_id: b.id, action: 'logo.remove', entity: 'business', entity_id: b.id }); require('../lib/realtime').broadcast(b.id, 'settings.changed', {}); }
  res.json({ ok: true, logo_url: null });
}));

router.get('/businesses/:id/admins', wrap(async (req, res) => {
  res.json(await q(`SELECT m.id,m.user_id,m.role,m.status,u.name,u.email,u.phone,u.last_login FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? ORDER BY (m.role='super_admin') DESC,u.name`, [req.params.id]));
}));

router.post('/businesses/:id/admins', wrap(async (req, res) => {
  const b = await one('SELECT id FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const name = clip(req.body.name, 120), email = clip(req.body.email, 150).toLowerCase(), phone = clip(req.body.phone, 30);
  if (!emailOk(email)) throw bad('Enter a valid email'); if (name.length < 2) throw bad('Enter the name');
  const out = await tx(async conn => {
    let [[u]] = await conn.query('SELECT * FROM users WHERE email=?', [email]); let temp = null;
    if (!u) { temp = clip(req.body.password, 100) || genPassword(12); if (temp.length < 8) throw bad('Password must be at least 8 characters'); const [r] = await conn.query('INSERT INTO users (name,email,phone,password_hash,must_change_password) VALUES (?,?,?,?,1)', [name, email, phone || null, await bcrypt.hash(temp, 11)]); u = { id: r.insertId }; }
    else if (u.is_developer) throw bad('That email is a Developer account');
    try { await conn.query("INSERT INTO memberships (user_id,business_id,role,created_by) VALUES (?,?,'super_admin',?)", [u.id, b.id, req.user.id]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') { await conn.query("UPDATE memberships SET role='super_admin', status='active' WHERE user_id=? AND business_id=?", [u.id, b.id]); } else throw e; }
    await audit(req, { business_id: b.id, action: 'superadmin.add', entity: 'user', entity_id: u.id, details: { name, email }, conn });
    return { user_id: u.id, temp_password: temp, existing_user: !temp };
  });
  res.json(out);
}));

router.put('/memberships/:id', wrap(async (req, res) => {
  const m = await one('SELECT * FROM memberships WHERE id=?', [req.params.id]); if (!m) throw notFound('Not found');
  const status = req.body.status === 'disabled' ? 'disabled' : 'active'; const role = ['super_admin', 'sub_admin'].includes(req.body.role) ? req.body.role : m.role;
  await q('UPDATE memberships SET status=?, role=? WHERE id=?', [status, role, m.id]);
  await audit(req, { business_id: m.business_id, action: 'membership.update', entity: 'user', entity_id: m.user_id, details: { status, role } });
  res.json({ ok: true });
}));

// ---------- users ----------
router.get('/users', wrap(async (req, res) => {
  const rows = await q('SELECT id,name,email,phone,is_developer,status,last_login,created_at FROM users ORDER BY is_developer DESC, name');
  const ms = await q('SELECT m.id AS membership_id,m.user_id,m.role,m.status,b.short_name,b.id AS business_id FROM memberships m JOIN businesses b ON b.id=m.business_id');
  rows.forEach(u => { u.memberships = ms.filter(m => m.user_id === u.id); });
  res.json(rows);
}));
router.put('/users/:id', wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id=?', [req.params.id]); if (!u) throw notFound('User not found');
  if (u.id === req.user.id && req.body.status === 'disabled') throw bad('You cannot disable your own account');
  const email = req.body.email ? clip(req.body.email, 150).toLowerCase() : u.email; if (!emailOk(email)) throw bad('Enter a valid email');
  try { await q('UPDATE users SET name=?, email=?, phone=?, status=? WHERE id=?', [clip(req.body.name, 120) || u.name, email, req.body.phone !== undefined ? clip(req.body.phone, 30) || null : u.phone, req.body.status === 'disabled' ? 'disabled' : req.body.status === 'active' ? 'active' : u.status, u.id]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That email is already used'); throw e; }
  await audit(req, { business_id: null, action: 'user.update', entity: 'user', entity_id: u.id, details: { email } });
  res.json({ ok: true });
}));
router.post('/users/:id/reset-password', wrap(async (req, res) => {
  const u = await one('SELECT id,name FROM users WHERE id=?', [req.params.id]); if (!u) throw notFound('User not found');
  const temp = clip(req.body.password, 100) || genPassword(12); if (temp.length < 8) throw bad('Password must be at least 8 characters');
  await q('UPDATE users SET password_hash=?, must_change_password=? WHERE id=?', [await bcrypt.hash(temp, 11), u.id === req.user.id ? 0 : 1, u.id]);
  await audit(req, { business_id: null, action: 'user.reset_password', entity: 'user', entity_id: u.id, details: { name: u.name } });
  res.json({ temp_password: temp });
}));

// ---------- platform theme ----------
router.put('/theme', wrap(async (req, res) => {
  const t = req.body || {}; const out = { name: clip(t.name, 60) || 'FBBMS', primary: /^#[0-9a-fA-F]{6}$/.test(t.primary) ? t.primary : '#d4af55', accent: /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : '#f1d98a', mode: ['dark', 'light'].includes(t.mode) ? t.mode : 'dark' };
  await q("INSERT INTO platform_settings (k,v) VALUES ('theme',?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [JSON.stringify(out)]);
  await audit(req, { business_id: null, action: 'platform.theme', details: out });
  res.json(out);
}));

router.get('/audit', wrap(async (req, res) => {
  const w = ['1=1']; const a = [];
  if (req.query.business) { w.push('a.business_id=?'); a.push(int(req.query.business)); }
  if (req.query.q) { w.push('(a.details LIKE ? OR a.action LIKE ?)'); a.push(`%${clip(req.query.q, 50)}%`, `%${clip(req.query.q, 50)}%`); }
  const limit = Math.min(300, int(req.query.limit, 100)); const page = Math.max(1, int(req.query.page, 1));
  const total = (await one(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${w.join(' AND ')}`, a)).n;
  const rows = await q(`SELECT a.*, u.name AS user_name, b.short_name AS business FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN businesses b ON b.id=a.business_id WHERE ${w.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  rows.forEach(r => { r.details = safeJSON(r.details, null); });
  res.json({ rows, total, page, limit });
}));

module.exports = router;
