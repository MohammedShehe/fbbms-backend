// Public (no sign-in) API used by customer websites such as zanlux.online
const router = require('express').Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const { q, one, tx } = require('../config/db');
const { bad, conflict, notFound, wrap, clip, int, round2, phoneOk, normPhone, emailOk, safeJSON } = require('../lib/util');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');

const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many orders from this device. Please try again later or call us.' } });

async function biz(req, res, next) {
  try {
    const b = await one("SELECT * FROM businesses WHERE slug=? AND status='active'", [req.params.slug]);
    if (!b) throw notFound('Shop not found');
    b.settings = safeJSON(b.settings, {}); b.theme = safeJSON(b.theme, {});
    if (b.settings.website_enabled === false) throw notFound('Website is not enabled');
    req.biz = b; next();
  } catch (e) { next(e); }
}
router.use('/:slug', biz);

const PUBLIC_KEYS = ['phone', 'whatsapp', 'email', 'address', 'location', 'instagram', 'facebook', 'tiktok', 'website', 'hours', 'order_note', 'delivery_note', 'about', 'mission', 'vision', 'hero_title', 'hero_subtitle', 'announcement', 'map_url', 'founder', 'values'];

router.get('/:slug/info', wrap(async (req, res) => {
  const b = req.biz; const s = {}; PUBLIC_KEYS.forEach(k => { if (b.settings[k] !== undefined && b.settings[k] !== '') s[k] = b.settings[k]; });
  const cats = await q(`SELECT c.id,c.name,COUNT(p.id) AS count FROM categories c JOIN products p ON p.category_id=c.id AND p.is_published=1 AND p.status='active' WHERE c.business_id=? GROUP BY c.id,c.name ORDER BY c.sort_order,c.name`, [b.id]);
  const stats = await one("SELECT COUNT(*) AS products FROM products WHERE business_id=? AND is_published=1 AND status='active'", [b.id]);
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ name: b.name, short_name: b.short_name, slug: b.slug, tagline: b.tagline, currency: b.currency, theme: { primary: b.theme.primary, accent: b.theme.accent, logo_url: b.theme.logo_url || null }, settings: s, categories: cats, product_count: stats.products });
}));

const avail = p => !p.track_stock ? 'in_stock' : p.stock_qty <= 0 ? 'out' : p.stock_qty <= p.low_stock_at ? 'low' : 'in_stock';
const shape = p => ({ id: p.id, name: p.name, brand: p.brand, size: p.size, description: p.description, price: p.price, image_url: p.image_url, category_id: p.category_id, category_name: p.category_name, is_featured: !!p.is_featured, availability: avail(p), max_qty: p.track_stock ? Math.max(0, Math.min(p.stock_qty, 20)) : 20, updated_at: p.updated_at });

router.get('/:slug/products', wrap(async (req, res) => {
  const w = ["p.business_id=?", "p.is_published=1", "p.status='active'"]; const a = [req.biz.id];
  if (req.query.category) { w.push('p.category_id=?'); a.push(int(req.query.category)); }
  if (req.query.featured === '1') w.push('p.is_featured=1');
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)'); a.push(s, s, s); }
  if (req.query.available === '1') w.push('(p.track_stock=0 OR p.stock_qty>0)');
  const min = Number(req.query.min), max = Number(req.query.max);
  if (min > 0) { w.push('p.price>=?'); a.push(min); } if (max > 0) { w.push('p.price<=?'); a.push(max); }
  const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC', newest: 'p.id DESC', name: 'p.name ASC' }[req.query.sort] || 'p.is_featured DESC, p.id DESC';
  const limit = Math.min(60, Math.max(1, int(req.query.limit, 24))); const page = Math.max(1, int(req.query.page, 1));
  const where = w.join(' AND ');
  const total = (await one(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`, a)).n;
  const rows = await q(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  res.set('Cache-Control', 'public, max-age=15');
  res.json({ rows: rows.map(shape), total, page, limit });
}));

router.get('/:slug/products/:id', wrap(async (req, res) => {
  const p = await one("SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.business_id=? AND p.is_published=1 AND p.status='active'", [req.params.id, req.biz.id]);
  if (!p) throw notFound('Product not found');
  res.json(shape(p));
}));

// Customers must give name + phone. Prices come from the database, never from the browser.
router.post('/:slug/orders', orderLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.company) return res.json({ order_no: 'OK', total: 0, status: 'new' }); // honeypot field: bots only
  res.json(await require('../lib/orders').placeOrder(req.biz, b, req.ip, 'website'));
}));

router.get('/:slug/orders/track', rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
  const no = clip(req.query.order_no, 30).toUpperCase(); const phone = normPhone(req.query.phone);
  if (!no || phone.length < 7) throw bad('Enter your order number and phone number');
  const o = await one('SELECT * FROM orders WHERE business_id=? AND order_no=?', [req.biz.id, no]);
  if (!o || normPhone(o.customer_phone).slice(-9) !== phone.slice(-9)) throw notFound('We could not find that order. Check the number and phone.');
  const items = await q('SELECT name,qty,unit_price,line_total FROM order_items WHERE order_id=?', [o.id]);
  res.json({ order_no: o.order_no, status: o.status, total: o.items_total, created_at: o.created_at, delivery_method: o.delivery_method, items });
}));

module.exports = router;
