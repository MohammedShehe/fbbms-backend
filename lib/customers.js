// Customer (CRM) helpers shared by POS, website orders and the public API.
const { clip, normPhone, phoneOk, emailOk, int } = require('./util');

/** Finds the customer by id or phone; creates one (when allowed) so every buyer builds a purchase history. */
async function resolve(conn, biz, { id, name, phone, email, source = 'pos', create = true, lock = false }) {
  const lockSql = lock ? ' FOR UPDATE' : '';
  if (id) { const [[c]] = await conn.query('SELECT * FROM customers WHERE id=? AND business_id=?' + lockSql, [int(id), biz.id]); return c || null; }
  const ph = phone ? normPhone(phone) : '';
  if (!ph || !phoneOk(ph)) return null;
  const [[ex]] = await conn.query('SELECT * FROM customers WHERE business_id=? AND phone=?' + lockSql, [biz.id, ph.slice(0, 30)]);
  if (ex) {
    if (ex.status === 'archived') await conn.query("UPDATE customers SET status='active' WHERE id=?", [ex.id]);
    if (!ex.email && email && emailOk(email)) await conn.query('UPDATE customers SET email=? WHERE id=?', [clip(email, 150), ex.id]);
    return ex;
  }
  if (!create || biz.settings.auto_register_customers === false) return null;
  const nm = clip(name, 120) || `Customer ${ph.slice(-4)}`;
  const [r] = await conn.query('INSERT INTO customers (business_id,name,phone,email,source) VALUES (?,?,?,?,?)', [biz.id, nm.length < 2 ? `Customer ${ph.slice(-4)}` : nm, ph.slice(0, 30), email && emailOk(email) ? clip(email, 150) : null, source]);
  const [[c]] = await conn.query('SELECT * FROM customers WHERE id=?', [r.insertId]); return c;
}

/** Adds (or removes) loyalty points and records why. Never lets the balance go negative. */
async function addPoints(conn, bizId, customerId, delta, reason, refType = null, refId = null, userId = null) {
  if (!delta) return null;
  const [[c]] = await conn.query('SELECT loyalty_points FROM customers WHERE id=? FOR UPDATE', [customerId]); if (!c) return null;
  const bal = Math.max(0, c.loyalty_points + delta); const applied = bal - c.loyalty_points;
  if (!applied) return bal;
  await conn.query('UPDATE customers SET loyalty_points=? WHERE id=?', [bal, customerId]);
  await conn.query('INSERT INTO loyalty_log (business_id,customer_id,points_change,balance_after,reason,ref_type,ref_id,user_id) VALUES (?,?,?,?,?,?,?,?)', [bizId, customerId, applied, bal, clip(reason, 120), refType, refId, userId]);
  return bal;
}

const loyalty = biz => ({ on: !!biz.settings.loyalty_enabled, per: Math.max(1, Number(biz.settings.loyalty_spend_per_point) || 1000), value: Math.max(0, Number(biz.settings.loyalty_point_value) || 10) });

module.exports = { resolve, addPoints, loyalty };
