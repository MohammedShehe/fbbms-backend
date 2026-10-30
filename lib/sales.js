// Core money + stock logic. Every sale is atomic: stock is locked, checked, deducted and recorded
// in one transaction, so what the Super Admin sees is always what physically left the shop.
const { bad, conflict, forbidden, notFound, round2, eatDate, int, money, clip, normPhone } = require('./util');

const PAYMENTS = ['cash', 'mobile_money', 'card', 'bank', 'other'];

async function createSale(conn, o) {
  const { biz, userId, perms, isSuper, items, source = 'pos', order_id = null, fixedPrices = null } = o;
  if (!Array.isArray(items) || !items.length) throw bad('Add at least one item');
  const payment = PAYMENTS.includes(o.payment_method) ? o.payment_method : 'cash';

  const merged = new Map();
  for (const it of items) {
    const pid = int(it.product_id), qty = int(it.qty);
    if (!pid || qty < 1 || qty > 10000) throw bad('Invalid item or quantity');
    const e = merged.get(pid) || { product_id: pid, qty: 0, unit_price: undefined };
    e.qty += qty;
    if (it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== '') e.unit_price = money(it.unit_price, NaN);
    merged.set(pid, e);
  }
  const ids = [...merged.keys()].sort((a, b) => a - b);
  const [prods] = await conn.query('SELECT * FROM products WHERE business_id=? AND id IN (?) ORDER BY id FOR UPDATE', [biz.id, ids]);
  const byId = new Map(prods.map(p => [p.id, p]));
  const [cats] = await conn.query('SELECT id,name FROM categories WHERE business_id=?', [biz.id]);
  const catName = new Map(cats.map(c => [c.id, c.name]));

  let subtotal = 0, costTotal = 0;
  const lines = [];
  for (const m of merged.values()) {
    const p = byId.get(m.product_id);
    if (!p || p.status !== 'active') throw bad('A selected product is no longer available');
    if (p.track_stock && p.stock_qty < m.qty) throw conflict(`Only ${p.stock_qty} left of "${p.name}"`, { product_id: p.id, available: p.stock_qty });
    let unit = p.price;
    if (fixedPrices && fixedPrices[p.id] !== undefined) unit = fixedPrices[p.id];
    else if (m.unit_price !== undefined && m.unit_price !== p.price) {
      if (!(isSuper || perms.has('sales.price_override'))) throw forbidden('You are not allowed to change prices');
      if (!(m.unit_price >= 0)) throw bad('Invalid price');
      unit = m.unit_price;
    }
    const line = round2(unit * m.qty);
    subtotal += line; costTotal += round2(p.cost_price * m.qty);
    lines.push({ p, qty: m.qty, unit, line });
  }
  subtotal = round2(subtotal); costTotal = round2(costTotal);

  let discount = money(o.discount, 0);
  if (discount < 0) throw bad('Invalid discount');
  if (discount > 0) {
    if (!(isSuper || perms.has('sales.discount') || perms.has('orders.manage') && source === 'website')) throw forbidden('You are not allowed to give discounts');
    if (discount > subtotal) throw bad('Discount cannot exceed the sale total');
    const cap = Number(biz.settings.max_discount_pct ?? 15);
    if (!isSuper && discount > round2(subtotal * cap / 100)) throw forbidden(`Discount is limited to ${cap}% of the sale`);
  }
  const total = round2(subtotal - discount);
  const profit = round2(total - costTotal);

  await conn.query('UPDATE businesses SET next_receipt = LAST_INSERT_ID(next_receipt + 1) WHERE id=?', [biz.id]);
  const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
  const receipt_no = `${biz.code}-${String(seq).padStart(6, '0')}`;
  const now = new Date();

  const [ins] = await conn.query(
    `INSERT INTO sales (business_id,receipt_no,source,order_id,customer_name,customer_phone,payment_method,subtotal,discount,total,cost_total,profit,notes,sold_by,sold_at,sale_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [biz.id, receipt_no, source, order_id, clip(o.customer_name, 120) || null, o.customer_phone ? normPhone(o.customer_phone).slice(0, 30) : null, payment, subtotal, discount, total, costTotal, profit, clip(o.notes, 255) || null, userId, now, eatDate(now)]
  );
  const saleId = ins.insertId;
  const lowStock = [];
  for (const l of lines) {
    await conn.query('INSERT INTO sale_items (sale_id,product_id,name,sku,category,qty,list_price,unit_price,unit_cost,line_total) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [saleId, l.p.id, l.p.name, l.p.sku, catName.get(l.p.category_id) || null, l.qty, l.p.price, l.unit, l.p.cost_price, l.line]);
    if (l.p.track_stock) {
      const bal = l.p.stock_qty - l.qty;
      await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [bal, l.p.id]);
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,user_id) VALUES (?,?,'sale',?,?,?,'sale',?,?)",
        [biz.id, l.p.id, -l.qty, bal, l.p.cost_price, saleId, userId]);
      if (bal <= l.p.low_stock_at) lowStock.push({ id: l.p.id, name: l.p.name, stock_qty: bal });
    }
  }
  const priceOverrides = lines.filter(l => l.unit !== l.p.price && !(fixedPrices && fixedPrices[l.p.id] !== undefined)).map(l => ({ name: l.p.name, list: l.p.price, sold: l.unit }));
  return { id: saleId, receipt_no, subtotal, discount, total, profit, cost_total: costTotal, lowStock, priceOverrides };
}

async function voidSale(conn, { biz, saleId, userId, reason }) {
  const [[sale]] = await conn.query('SELECT * FROM sales WHERE id=? AND business_id=? FOR UPDATE', [saleId, biz.id]);
  if (!sale) throw notFound('Sale not found');
  if (sale.status === 'voided') throw conflict('This sale was already voided');
  const [items] = await conn.query('SELECT * FROM sale_items WHERE sale_id=?', [saleId]);
  for (const it of items.sort((a, b) => (a.product_id || 0) - (b.product_id || 0))) {
    if (!it.product_id) continue;
    const [[p]] = await conn.query('SELECT id,track_stock,stock_qty FROM products WHERE id=? FOR UPDATE', [it.product_id]);
    if (p && p.track_stock) {
      const bal = p.stock_qty + it.qty;
      await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [bal, p.id]);
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,note,user_id) VALUES (?,?,'void_return',?,?,?,'sale',?,?,?)",
        [biz.id, p.id, it.qty, bal, it.unit_cost, saleId, `Void of ${sale.receipt_no}`, userId]);
    }
  }
  await conn.query("UPDATE sales SET status='voided', void_reason=?, voided_by=?, voided_at=UTC_TIMESTAMP() WHERE id=?", [clip(reason, 255), userId, saleId]);
  if (sale.order_id) await conn.query("UPDATE orders SET status='confirmed', sale_id=NULL, admin_notes=CONCAT(COALESCE(admin_notes,''),' [Sale voided: ', ?, ']') WHERE id=?", [sale.receipt_no, sale.order_id]);
  return sale;
}

module.exports = { createSale, voidSale, PAYMENTS };
