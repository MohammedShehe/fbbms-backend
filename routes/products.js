const router = require('express').Router();
const { uploadImage } = require('../lib/cloudinary');
const { q, one, tx } = require('../config/db');
const { can, canAny, has } = require('../middleware/auth');
const { bad, conflict, notFound, wrap, clip, int, money, round2 } = require('../lib/util');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');
const { notify } = require('../lib/notify');
const hooks = require('../lib/webhooks');

const hideCost = (req, p) => { if (!has(req, 'products.see_cost')) { delete p.cost_price; } return p; };

// ---------- categories ----------
router.get('/categories', canAny('products.view', 'sales.create', 'products.manage'), wrap(async (req, res) => {
  res.json(await q(`SELECT c.id,c.name,c.sort_order,(SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.status='active') AS product_count
                    FROM categories c WHERE c.business_id=? ORDER BY c.sort_order,c.name`, [req.biz.id]));
}));
router.post('/categories', can('products.manage'), wrap(async (req, res) => {
  const name = clip(req.body.name, 100); if (name.length < 2) throw bad('Enter a category name');
  try { const r = await q('INSERT INTO categories (business_id,name,sort_order) VALUES (?,?,?)', [req.biz.id, name, int(req.body.sort_order, 50)]); res.json({ id: r.insertId, name }); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That category already exists'); throw e; }
}));
router.put('/categories/:id', can('products.manage'), wrap(async (req, res) => {
  const name = clip(req.body.name, 100); if (name.length < 2) throw bad('Enter a category name');
  try { await q('UPDATE categories SET name=?, sort_order=COALESCE(?,sort_order) WHERE id=? AND business_id=?', [name, req.body.sort_order === undefined ? null : int(req.body.sort_order), req.params.id, req.biz.id]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That category already exists'); throw e; }
  res.json({ ok: true });
}));
router.delete('/categories/:id', can('products.manage'), wrap(async (req, res) => {
  const n = await one('SELECT COUNT(*) AS n FROM products WHERE category_id=? AND business_id=?', [req.params.id, req.biz.id]);
  if (n.n) throw conflict('Move or archive the products in this category first');
  await q('DELETE FROM categories WHERE id=? AND business_id=?', [req.params.id, req.biz.id]);
  res.json({ ok: true });
}));

// ---------- products ----------
router.get('/products', canAny('products.view', 'sales.create', 'products.manage'), wrap(async (req, res) => {
  const { q: search, category, status = 'active', stock, published, sort = 'name' } = req.query;
  const page = Math.max(1, int(req.query.page, 1)); const limit = Math.min(500, Math.max(1, int(req.query.limit, 50)));
  const w = ['p.business_id=?']; const a = [req.biz.id];
  if (status !== 'all') { w.push('p.status=?'); a.push(status === 'archived' ? 'archived' : 'active'); }
  if (search) { w.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.barcode=?)'); const s = `%${clip(search, 60)}%`; a.push(s, s, s, clip(search, 64)); }
  if (category) { w.push('p.category_id=?'); a.push(int(category)); }
  if (stock === 'low') w.push('p.track_stock=1 AND p.stock_qty>0 AND p.stock_qty<=p.low_stock_at');
  if (stock === 'out') w.push('p.track_stock=1 AND p.stock_qty<=0');
  if (stock === 'in') w.push('(p.track_stock=0 OR p.stock_qty>0)');
  if (published === '1') w.push('p.is_published=1'); if (published === '0') w.push('p.is_published=0');
  const order = { name: 'p.name ASC', newest: 'p.id DESC', price_asc: 'p.price ASC', price_desc: 'p.price DESC', stock_asc: 'p.stock_qty ASC', stock_desc: 'p.stock_qty DESC' }[sort] || 'p.name ASC';
  const where = w.join(' AND ');
  const total = (await one(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`, a)).n;
  const rows = await q(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...a, limit, (page - 1) * limit]);
  const sum = await one(`SELECT COUNT(*) AS items,
      SUM(track_stock=1 AND stock_qty>0 AND stock_qty<=low_stock_at) AS low, SUM(track_stock=1 AND stock_qty<=0) AS out_of_stock,
      COALESCE(SUM(IF(track_stock=1,stock_qty*cost_price,0)),0) AS cost_value, COALESCE(SUM(IF(track_stock=1,stock_qty*price,0)),0) AS retail_value,
      COALESCE(SUM(IF(track_stock=1,stock_qty,0)),0) AS units
      FROM products WHERE business_id=? AND status='active'`, [req.biz.id]);
  if (!has(req, 'products.see_cost')) { delete sum.cost_value; }
  res.json({ rows: rows.map(p => hideCost(req, p)), total, page, limit, summary: sum });
}));

// exact scan lookup by barcode or SKU (used by scanners at the till)
router.get('/products/by-code/:code', canAny('products.view', 'sales.create', 'products.manage'), wrap(async (req, res) => {
  const c = clip(req.params.code, 64);
  const p = await one("SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.business_id=? AND p.status='active' AND (p.barcode=? OR p.sku=?) LIMIT 1", [req.biz.id, c, c]);
  if (!p) throw notFound('No product with that barcode or SKU');
  res.json(hideCost(req, p));
}));

router.get('/products/:id', canAny('products.view', 'sales.create', 'products.manage'), wrap(async (req, res) => {
  const p = await one('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.business_id=?', [req.params.id, req.biz.id]);
  if (!p) throw notFound('Product not found');
  res.json(hideCost(req, p));
}));

async function nextSku(conn, biz) {
  const prefix = (biz.settings.sku_prefix || biz.code || 'PR').toUpperCase();
  const [[r]] = await conn.query("SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(sku,'-',-1) AS UNSIGNED)),0) AS m FROM products WHERE business_id=? AND sku LIKE ?", [biz.id, prefix + '-%']);
  return `${prefix}-${String(r.m + 1).padStart(4, '0')}`;
}

function readProduct(body, partial = false) {
  const d = {};
  const set = (k, v) => { if (!partial || body[k] !== undefined) d[k] = v; };
  set('name', clip(body.name, 160)); if (!partial || body.name !== undefined) { if (d.name.length < 2) throw bad('Enter the product name'); }
  set('brand', clip(body.brand, 100) || null); set('size', clip(body.size, 50) || null);
  set('description', clip(body.description, 4000) || null);
  set('category_id', body.category_id ? int(body.category_id) : null);
  set('price', money(body.price, 0)); set('cost_price', money(body.cost_price, 0));
  if (d.price !== undefined && d.price < 0 || d.cost_price !== undefined && d.cost_price < 0) throw bad('Prices cannot be negative');
  set('low_stock_at', Math.max(0, int(body.low_stock_at, 5)));
  set('track_stock', body.track_stock === false || body.track_stock === 0 || body.track_stock === '0' ? 0 : 1);
  set('is_published', body.is_published ? 1 : 0); set('is_featured', body.is_featured ? 1 : 0);
  set('image_url', clip(body.image_url, 255) || null);
  set('barcode', clip(body.barcode, 64) || null);
  if (!partial || body.expiry_date !== undefined) d.expiry_date = /^\d{4}-\d{2}-\d{2}$/.test(body.expiry_date || '') ? body.expiry_date : null;
  return d;
}

router.post('/products', can('products.manage'), wrap(async (req, res) => {
  const d = readProduct(req.body);
  if (d.price <= 0) throw bad('Selling price must be greater than 0');
  const opening = d.track_stock ? Math.max(0, int(req.body.stock_qty, 0)) : 0;
  const out = await tx(async conn => {
    if (d.category_id) { const [[c]] = await conn.query('SELECT id FROM categories WHERE id=? AND business_id=?', [d.category_id, req.biz.id]); if (!c) throw bad('Unknown category'); }
    const sku = clip(req.body.sku, 40).toUpperCase() || await nextSku(conn, req.biz);
    let r;
    try {
      [r] = await conn.query(`INSERT INTO products (business_id,category_id,sku,name,brand,size,description,image_url,cost_price,price,stock_qty,low_stock_at,track_stock,is_published,is_featured,created_by,barcode,expiry_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.biz.id, d.category_id, sku, d.name, d.brand, d.size, d.description, d.image_url, d.cost_price, d.price, opening, d.low_stock_at, d.track_stock, d.is_published, d.is_featured, req.user.id, d.barcode, d.expiry_date]);
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That SKU already exists'); throw e; }
    if (opening > 0) await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,note,user_id) VALUES (?,?,'opening',?,?,?,'Opening stock',?)", [req.biz.id, r.insertId, opening, opening, d.cost_price, req.user.id]);
    await audit(req, { action: 'product.create', entity: 'product', entity_id: r.insertId, details: { name: d.name, price: d.price, stock: opening }, conn });
    return { id: r.insertId, sku };
  });
  rt.broadcast(req.biz.id, 'product.changed', { id: out.id });
  res.json(out);
}));

router.put('/products/:id', can('products.manage'), wrap(async (req, res) => {
  const old = await one('SELECT * FROM products WHERE id=? AND business_id=?', [req.params.id, req.biz.id]);
  if (!old) throw notFound('Product not found');
  const d = readProduct(req.body, true);
  if (d.category_id) { const c = await one('SELECT id FROM categories WHERE id=? AND business_id=?', [d.category_id, req.biz.id]); if (!c) throw bad('Unknown category'); }
  if (req.body.sku !== undefined) d.sku = clip(req.body.sku, 40).toUpperCase() || old.sku;
  if (d.cost_price !== undefined && !has(req, 'products.see_cost')) delete d.cost_price;
  const keys = Object.keys(d); if (!keys.length) return res.json({ ok: true });
  try { await q(`UPDATE products SET ${keys.map(k => k + '=?').join(',')} WHERE id=? AND business_id=?`, [...keys.map(k => d[k]), old.id, req.biz.id]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That SKU already exists'); throw e; }
  const changes = {}; keys.forEach(k => { if (String(old[k]) !== String(d[k])) changes[k] = [old[k], d[k]]; });
  if (Object.keys(changes).length) await audit(req, { action: 'product.update', entity: 'product', entity_id: old.id, details: changes });
  rt.broadcast(req.biz.id, 'product.changed', { id: old.id });
  res.json({ ok: true });
}));

router.post('/products/:id/archive', can('products.manage'), wrap(async (req, res) => {
  const restore = !!req.body.restore;
  const r = await q('UPDATE products SET status=?, is_published=IF(?,is_published,0) WHERE id=? AND business_id=?', [restore ? 'active' : 'archived', restore ? 1 : 0, req.params.id, req.biz.id]);
  if (!r.affectedRows) throw notFound('Product not found');
  await audit(req, { action: restore ? 'product.restore' : 'product.archive', entity: 'product', entity_id: int(req.params.id) });
  rt.broadcast(req.biz.id, 'product.changed', { id: int(req.params.id) });
  res.json({ ok: true });
}));

// Receive stock / adjust / write off. Every change is a permanent movement row.
router.post('/products/:id/stock', can('stock.adjust'), wrap(async (req, res) => {
  const type = ['purchase', 'adjustment', 'damage'].includes(req.body.type) ? req.body.type : null;
  if (!type) throw bad('Choose a movement type');
  let qty = int(req.body.qty, 0); if (!qty) throw bad('Enter a quantity');
  const note = clip(req.body.note, 255);
  if (type !== 'purchase' && note.length < 3) throw bad('A reason is required for adjustments and write-offs');
  if (type === 'purchase' && qty < 0) throw bad('Received quantity must be positive');
  if (type === 'damage') qty = -Math.abs(qty);
  const out = await tx(async conn => {
    const [[p]] = await conn.query('SELECT * FROM products WHERE id=? AND business_id=? FOR UPDATE', [req.params.id, req.biz.id]);
    if (!p) throw notFound('Product not found');
    if (!p.track_stock) throw bad('This item does not track stock');
    const bal = p.stock_qty + qty; if (bal < 0) throw bad(`Stock cannot go below zero (currently ${p.stock_qty})`);
    let cost = p.cost_price;
    const uc = req.body.unit_cost !== undefined && req.body.unit_cost !== '' ? money(req.body.unit_cost, NaN) : null;
    if (type === 'purchase' && uc !== null && uc >= 0 && has(req, 'products.see_cost')) cost = round2(((Math.max(p.stock_qty, 0) * p.cost_price) + qty * uc) / (Math.max(p.stock_qty, 0) + qty));
    await conn.query('UPDATE products SET stock_qty=?, cost_price=? WHERE id=?', [bal, cost, p.id]);
    await conn.query('INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,note,user_id) VALUES (?,?,?,?,?,?,?,?)', [req.biz.id, p.id, type, qty, bal, uc ?? p.cost_price, note || null, req.user.id]);
    await audit(req, { action: 'stock.' + type, entity: 'product', entity_id: p.id, details: { name: p.name, qty, balance: bal, note }, conn });
    return { balance: bal, name: p.name, low: bal <= p.low_stock_at };
  });
  rt.broadcast(req.biz.id, 'product.changed', { id: int(req.params.id) });
  if (out.low) { const p = { id: int(req.params.id), name: out.name, stock_qty: out.balance }; rt.broadcast(req.biz.id, 'stock.low', p); hooks.emit(req.biz.id, 'stock.low', p); }
  if (type !== 'purchase' && Math.abs(qty) >= (Number(req.biz.settings.alert_stock_adjust_qty) || 20)) await notify(req.biz, { type: 'stock.adjust', severity: 'warn', audience: 'super', title: `Large stock ${type}: ${out.name} (${qty})`, body: `${req.user.name}: ${note}`, dedupe: `adj:${int(req.params.id)}:${Date.now()}` });
  res.json(out);
}));

router.get('/products/:id/movements', canAny('products.view', 'products.manage'), wrap(async (req, res) => {
  res.json(await q(`SELECT m.*, u.name AS user_name FROM stock_movements m LEFT JOIN users u ON u.id=m.user_id
                    WHERE m.product_id=? AND m.business_id=? ORDER BY m.id DESC LIMIT 100`, [req.params.id, req.biz.id]));
}));

// Whole-shop stock ledger (Super Admin / stock.adjust): filters by type, product, date
router.get('/stock-ledger', can('stock.adjust'), wrap(async (req, res) => {
  const w = ['m.business_id=?']; const a = [req.biz.id];
  if (req.query.type) { w.push('m.type=?'); a.push(req.query.type); }
  if (req.query.product_id) { w.push('m.product_id=?'); a.push(int(req.query.product_id)); }
  if (req.query.q) { w.push('(p.name LIKE ? OR p.sku LIKE ?)'); a.push(`%${clip(req.query.q, 50)}%`, `%${clip(req.query.q, 50)}%`); }
  const limit = Math.min(300, int(req.query.limit, 100));
  res.json(await q(`SELECT m.*, p.name AS product_name, p.sku, u.name AS user_name FROM stock_movements m
    JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id WHERE ${w.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, [...a, limit]));
}));

// ---------- image upload -> Cloudinary (client sends a resized JPEG/PNG/WebP data URL) ----------
router.post('/upload', can('products.manage'), wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!m) throw bad('Upload a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw bad('Image is too large (max 4 MB)');
  const sig = buf.slice(0, 12).toString('hex');
  const okSig = (m[1] === 'image/jpeg' && sig.startsWith('ffd8ff')) || (m[1] === 'image/png' && sig.startsWith('89504e47')) || (m[1] === 'image/webp' && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
  if (!okSig) throw bad('That file is not a valid image');
  const r = await uploadImage(req.body.data, `fbbms/${req.biz.slug}/products`);
  await audit(req, { action: 'image.upload', entity: 'product', details: { public_id: r.public_id } });
  res.json({ url: r.url });
}));

module.exports = router;
