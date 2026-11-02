// Placing a website order (used by the legacy /api/public route and the keyed /api/v1 route).
const { one, tx } = require('../config/db');
const { bad, conflict, clip, int, round2, phoneOk, normPhone, emailOk } = require('./util');
const customers = require('./customers');
const modules = require('./modules');
const { audit } = require('./audit');
const { notify } = require('./notify');
const hooks = require('./webhooks');
const rt = require('./realtime');

async function placeOrder(biz, b, ip, source = 'website') {
  const name = clip(b.customer_name, 120); const phone = clip(b.customer_phone, 30);
  if (name.length < 2) throw bad('Please enter your full name');
  if (!phoneOk(phone)) throw bad('Please enter a valid phone number (e.g. 0774 040 506)');
  const email = clip(b.customer_email, 150); if (email && !emailOk(email)) throw bad('That email address looks wrong');
  const delivery = b.delivery_method === 'delivery' ? 'delivery' : 'pickup';
  const address = clip(b.address, 255); if (delivery === 'delivery' && address.length < 4) throw bad('Please tell us where to deliver');
  const items = Array.isArray(b.items) ? b.items.slice(0, 30) : []; if (!items.length) throw bad('Your cart is empty');
  const merged = new Map();
  for (const it of items) { const pid = int(it.product_id), qty = int(it.qty); if (!pid || qty < 1 || qty > 20) throw bad('Invalid quantity in your cart'); merged.set(pid, (merged.get(pid) || 0) + qty); }

  const out = await tx(async conn => {
    const ids = [...merged.keys()];
    const [prods] = await conn.query("SELECT * FROM products WHERE business_id=? AND id IN (?) AND is_published=1 AND status='active'", [biz.id, ids]);
    const byId = new Map(prods.map(p => [p.id, p]));
    let total = 0; const lines = [];
    for (const [pid, qty] of merged) {
      const p = byId.get(pid); if (!p) throw bad('An item in your cart is no longer available. Please refresh.');
      if (p.track_stock && p.stock_qty < qty) throw conflict(p.stock_qty > 0 ? `Only ${p.stock_qty} of "${p.name}" left in stock` : `"${p.name}" is out of stock`);
      const line = round2(p.price * qty); total += line; lines.push({ p, qty, line });
    }
    total = round2(total);
    await conn.query('UPDATE businesses SET next_order = LAST_INSERT_ID(next_order + 1) WHERE id=?', [biz.id]);
    const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
    const order_no = `${biz.code}-W${String(seq).padStart(5, '0')}`;
    const [r] = await conn.query('INSERT INTO orders (business_id,order_no,customer_name,customer_phone,customer_email,address,city,delivery_method,notes,items_total,ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [biz.id, order_no, name, normPhone(phone), email || null, address || null, clip(b.city, 80) || null, delivery, clip(b.notes, 500) || null, total, String(ip || '').slice(0, 60)]);
    for (const l of lines) await conn.query('INSERT INTO order_items (order_id,product_id,name,qty,unit_price,line_total) VALUES (?,?,?,?,?,?)', [r.insertId, l.p.id, l.p.name, l.qty, l.p.price, l.line]);
    if (modules.enabled(biz, 'customers')) { const c = await customers.resolve(conn, biz, { name, phone, email, source }); if (c && b.birthday && /^\d{4}-\d{2}-\d{2}$/.test(b.birthday) && !c.birthday) await conn.query('UPDATE customers SET birthday=? WHERE id=?', [b.birthday, c.id]); }
    return { id: r.insertId, order_no, total, count: lines.reduce((s, l) => s + l.qty, 0), items: lines.map(l => ({ product_id: l.p.id, name: l.p.name, qty: l.qty, unit_price: l.p.price })) };
  });
  await audit({ ip }, { business_id: biz.id, action: 'order.placed', entity: 'order', entity_id: out.id, details: { order_no: out.order_no, total: out.total, source } });
  rt.broadcast(biz.id, 'order.new', { id: out.id, order_no: out.order_no, customer: name, total: out.total, count: out.count });
  await notify(biz, { type: 'order.new', severity: 'info', audience: 'all', title: `New order ${out.order_no}`, body: `${name} · ${out.total} · ${out.count} item(s)`, dedupe: `order:${out.id}` });
  hooks.emit(biz.id, 'order.created', { order_no: out.order_no, total: out.total, currency: biz.currency, customer: { name, phone: normPhone(phone), email: email || null }, delivery_method: delivery, items: out.items });
  return { order_no: out.order_no, total: out.total, status: 'new', message: biz.settings.order_note || 'We will contact you shortly.' };
}
module.exports = { placeOrder };
