// PUBLIC API v1 - used by customers' websites and apps with an API key. Mounted at /api/v1 (before the global CORS rule).
const router = require('express').Router();
const cors = require('cors');
const { q, one } = require('../config/db');
const { sha256 } = require('../lib/secrets');
const { clip, int, safeJSON, normPhone, phoneOk, emailOk, HttpError, isDate } = require('../lib/util');
const modules = require('../lib/modules');
const platform = require('../lib/platform');
const { placeOrder } = require('../lib/orders');
const customers = require('../lib/customers');
const { tx } = require('../config/db');

const SCOPES = {
  'store:read': 'Read the store profile, contact details and categories',
  'products:read': 'Read published products and availability',
  'orders:create': 'Place customer orders',
  'orders:track': 'Look up an order status with order number + phone',
  'customers:create': 'Register a customer (newsletter / loyalty sign-up)'
};

router.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'Idempotency-Key'], exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-Id'], maxAge: 600 }));
router.use(require('express').json({ limit: '200kb' }));

const err = (status, code, message) => { const e = new HttpError(status, message); e.code = code; return e; };
const buckets = new Map(); // keyId -> { n, reset }
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k); }, 60000).unref();

router.get('/ping', (req, res) => res.json({ data: { ok: true, version: 'v1', time: new Date().toISOString() } }));

router.use(async (req, res, next) => {
  const t0 = Date.now(); let key = null;
  try {
    const pol = await platform.api(); const plat = await platform.platform();
    if (plat.maintenance) throw err(503, 'maintenance', plat.maintenance_message);
    if (!pol.enabled) throw err(503, 'api_disabled', 'The public API is switched off.');
    const h = req.headers['authorization'] || ''; const raw = String(req.headers['x-api-key'] || (h.startsWith('Bearer ') ? h.slice(7) : '')).trim();
    if (!raw) throw err(401, 'missing_api_key', 'Send your API key in the X-API-Key header.');
    key = await one('SELECT * FROM api_keys WHERE key_hash=?', [sha256(raw)]);
    if (!key || key.status !== 'active') throw err(401, 'invalid_api_key', 'That API key is not valid.');
    if (key.expires_at && new Date(key.expires_at) < new Date()) throw err(401, 'expired_api_key', 'That API key has expired.');
    const biz = await one("SELECT * FROM businesses WHERE id=? AND status='active'", [key.business_id]); if (!biz) throw err(403, 'business_inactive', 'This business is not active.');
    biz.settings = safeJSON(biz.settings, {}); biz.theme = safeJSON(biz.theme, {});
    if (!modules.enabled(biz, 'public_api')) throw err(403, 'module_disabled', 'API access is not enabled for this business.');
    const origins = safeJSON(key.allowed_origins, []); const origin = req.headers.origin;
    if (origins.length && origin && !origins.includes(origin)) throw err(403, 'origin_not_allowed', 'This key is not allowed from that website.');
    const now = Date.now(); let b = buckets.get(key.id); if (!b || b.reset < now) { b = { n: 0, reset: now + 60000 }; buckets.set(key.id, b); }
    b.n++; res.set({ 'X-RateLimit-Limit': String(key.rate_limit), 'X-RateLimit-Remaining': String(Math.max(0, key.rate_limit - b.n)), 'X-RateLimit-Reset': String(Math.ceil(b.reset / 1000)) });
    if (b.n > key.rate_limit) { res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000))); throw err(429, 'rate_limited', 'Too many requests. Slow down.'); }
    req.biz = biz; req.key = key; req.scopes = new Set(safeJSON(key.scopes, []));
    res.on('finish', () => { q('INSERT INTO api_request_log (key_id,business_id,method,path,status,ms,ip) VALUES (?,?,?,?,?,?,?)', [key.id, key.business_id, req.method, req.path.slice(0, 120), res.statusCode, Date.now() - t0, String(req.ip || '').slice(0, 60)]).catch(() => {}); q('UPDATE api_keys SET last_used_at=UTC_TIMESTAMP(), request_count=request_count+1 WHERE id=?', [key.id]).catch(() => {}); });
    next();
  } catch (e) { next(e); }
});

const need = scope => (req, res, next) => req.scopes.has(scope) ? next() : next(err(403, 'insufficient_scope', `This key does not have the "${scope}" permission.`));
const ok = (res, data, meta) => res.json(meta ? { data, meta } : { data });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PUBLIC_KEYS = ['phone', 'whatsapp', 'email', 'address', 'location', 'instagram', 'facebook', 'tiktok', 'website', 'hours', 'order_note', 'delivery_note', 'about', 'mission', 'vision', 'hero_title', 'hero_subtitle', 'announcement', 'map_url', 'founder', 'values'];
router.get('/store', need('store:read'), wrap(async (req, res) => {
  const b = req.biz; const s = {}; PUBLIC_KEYS.forEach(k => { if (b.settings[k] !== undefined && b.settings[k] !== '') s[k] = b.settings[k]; });
  ok(res, { name: b.name, short_name: b.short_name, slug: b.slug, tagline: b.tagline, currency: b.currency, timezone: b.settings.timezone || 'Africa/Dar_es_Salaam', theme: { primary: b.theme.primary, accent: b.theme.accent, logo_url: b.theme.logo_url || null }, settings: s });
}));
router.get('/categories', need('store:read'), wrap(async (req, res) => {
  ok(res, await q(`SELECT c.id,c.name,COUNT(p.id) AS product_count FROM categories c JOIN products p ON p.category_id=c.id AND p.is_published=1 AND p.status='active' WHERE c.business_id=? GROUP BY c.id,c.name ORDER BY c.sort_order,c.name`, [req.biz.id]));
}));

const avail = p => !p.track_stock ? 'in_stock' : p.stock_qty <= 0 ? 'out_of_stock' : p.stock_qty <= p.low_stock_at ? 'low_stock' : 'in_stock';
const shape = p => ({ id: p.id, sku: p.sku, name: p.name, brand: p.brand, size: p.size, description: p.description, price: p.price, currency: null, image_url: p.image_url, category: p.category_id ? { id: p.category_id, name: p.category_name } : null, featured: !!p.is_featured, availability: avail(p), max_order_qty: p.track_stock ? Math.max(0, Math.min(p.stock_qty, 20)) : 20, updated_at: p.updated_at });

router.get('/products', need('products:read'), wrap(async (req, res) => {
  const w = ['p.business_id=?', 'p.is_published=1', "p.status='active'"]; const a = [req.biz.id];
  if (req.query.category) { w.push('p.category_id=?'); a.push(int(req.query.category)); }
  if (req.query.featured === 'true' || req.query.featured === '1') w.push('p.is_featured=1');
  if (req.query.q) { const s = `%${clip(req.query.q, 60)}%`; w.push('(p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)'); a.push(s, s, s); }
  if (req.query.in_stock === 'true' || req.query.in_stock === '1') w.push('(p.track_stock=0 OR p.stock_qty>0)');
  if (isDate((req.query.updated_since || '').slice(0, 10))) { w.push('p.updated_at>=?'); a.push(new Date(req.query.updated_since)); }
  const min = Number(req.query.min_price), max = Number(req.query.max_price); if (min > 0) { w.push('p.price>=?'); a.push(min); } if (max > 0) { w.push('p.price<=?'); a.push(max); }
  const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC', newest: 'p.id DESC', name: 'p.name ASC' }[req.query.sort] || 'p.is_featured DESC, p.id DESC';
  const limit = Math.min(100, Math.max(1, int(req.query.limit, 24))); const page = Math.max(1, int(req.query.page, 1)); const where = w.join(' AND ');
  const total = (await one(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`, a)).n;
  const rows = await q(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  ok(res, rows.map(p => ({ ...shape(p), currency: req.biz.currency })), { total, page, limit, pages: Math.ceil(total / limit) });
}));
router.get('/products/:id', need('products:read'), wrap(async (req, res) => {
  const p = await one("SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.business_id=? AND p.is_published=1 AND p.status='active'", [int(req.params.id), req.biz.id]);
  if (!p) throw err(404, 'not_found', 'Product not found'); ok(res, { ...shape(p), currency: req.biz.currency });
}));

router.post('/orders', need('orders:create'), wrap(async (req, res) => {
  const idem = clip(req.headers['idempotency-key'], 80);
  if (idem) { const prev = await one('SELECT response FROM idempotency_keys WHERE business_id=? AND idem_key=?', [req.biz.id, idem]); if (prev) { res.set('Idempotent-Replayed', 'true'); return res.status(201).json(safeJSON(prev.response, {})); } }
  if (req.body && req.body.company) return res.status(201).json({ data: { order_no: 'OK', status: 'new' } });
  const out = await placeOrder(req.biz, req.body || {}, req.ip, 'api');
  const body = { data: { ...out, currency: req.biz.currency } };
  if (idem) await q('INSERT IGNORE INTO idempotency_keys (business_id,idem_key,response) VALUES (?,?,?)', [req.biz.id, idem, JSON.stringify(body)]).catch(() => {});
  res.status(201).json(body);
}));
router.get('/orders/:order_no', need('orders:track'), wrap(async (req, res) => {
  const phone = normPhone(req.query.phone); if (phone.length < 7) throw err(400, 'phone_required', 'Add ?phone= with the customer phone number.');
  const o = await one('SELECT * FROM orders WHERE business_id=? AND order_no=?', [req.biz.id, clip(req.params.order_no, 30).toUpperCase()]);
  if (!o || normPhone(o.customer_phone).slice(-9) !== phone.slice(-9)) throw err(404, 'not_found', 'Order not found for that number and phone.');
  const items = await q('SELECT name,qty,unit_price,line_total FROM order_items WHERE order_id=?', [o.id]);
  ok(res, { order_no: o.order_no, status: o.status, total: o.items_total, currency: req.biz.currency, created_at: o.created_at, delivery_method: o.delivery_method, items });
}));

router.post('/customers', need('customers:create'), wrap(async (req, res) => {
  if (!modules.enabled(req.biz, 'customers')) throw err(403, 'module_disabled', 'Customer registration is not enabled for this business.');
  const b = req.body || {}; const name = clip(b.name, 120); const phone = normPhone(clip(b.phone, 30)); const email = clip(b.email, 150);
  if (name.length < 2) throw err(400, 'invalid_name', 'name is required'); if (!phoneOk(phone)) throw err(400, 'invalid_phone', 'A valid phone number is required'); if (email && !emailOk(email)) throw err(400, 'invalid_email', 'email looks wrong');
  const created = await tx(async conn => { const [[ex]] = await conn.query('SELECT id FROM customers WHERE business_id=? AND phone=?', [req.biz.id, phone]); const c = await customers.resolve(conn, req.biz, { name, phone, email, source: 'api' });
    if (c && !ex) { await conn.query('UPDATE customers SET birthday=?, marketing_ok=? WHERE id=?', [isDate(b.birthday) ? b.birthday : null, b.marketing_ok === false ? 0 : 1, c.id]); } return !ex; });
  res.status(created ? 201 : 200).json({ data: { status: created ? 'created' : 'already_registered' } });
}));

router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));
router.use((e, req, res, next) => { // eslint-disable-line
  const status = e.status || 500; if (status >= 500 && status !== 503) console.error('v1 error:', e);
  res.status(status).json({ error: { code: e.code || (status >= 500 ? 'server_error' : 'bad_request'), message: status >= 500 && status !== 503 ? 'Something went wrong on the server' : e.message, ...(e.extra ? { detail: e.extra } : {}) } });
});

module.exports = router;
module.exports.SCOPES = SCOPES;
