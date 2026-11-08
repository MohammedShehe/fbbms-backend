// Core money + stock logic. Every sale is atomic: stock is locked, checked, deducted and recorded
// in one transaction, so what the Super Admin sees is always what physically left the shop.
const { bad, conflict, forbidden, notFound, round2, int, money, clip, normPhone, isDate, addDays } = require('./util');
const { localDate, bizTz } = require('./tz');
const customers = require('./customers');
const modules = require('./modules');

const PAYMENTS = ['cash', 'mobile_money', 'card', 'bank', 'qr', 'ewallet', 'other'];

function taxOf(biz, taxable) {
  const rate = Math.max(0, Number(biz.settings.tax_rate_pct) || 0);
  if (!rate) return { tax: 0, total: round2(taxable), rate: 0 };
  if (biz.settings.tax_inclusive === false) { const tax = round2(taxable * rate / 100); return { tax, total: round2(taxable + tax), rate }; }
  return { tax: round2(taxable * rate / (100 + rate)), total: round2(taxable), rate };
}

async function createSale(conn, o) {
  const { biz, userId, perms, isSuper, items, source = 'pos', order_id = null, fixedPrices = null } = o;
  if (!Array.isArray(items) || !items.length) throw bad('Add at least one item');

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

  // ---- customer + loyalty ----
  const L = customers.loyalty(biz);
  let cust = null;
  if ((o.customer_id || o.customer_phone) && modules.enabled(biz, 'customers')) cust = await customers.resolve(conn, biz, { id: o.customer_id, name: o.customer_name, phone: o.customer_phone, source: source === 'website' ? 'website' : 'pos', lock: true });
  if (o.customer_id && !cust) throw bad('That customer was not found');
  let redeem = 0, redeemValue = 0;
  if (int(o.redeem_points) > 0) {
    if (!L.on) throw bad('Loyalty points are not switched on for this shop');
    if (!cust) throw bad('Choose a customer to redeem points');
    redeem = Math.min(int(o.redeem_points), cust.loyalty_points);
    redeemValue = round2(redeem * L.value);
    if (discount + redeemValue > subtotal) { redeem = Math.floor((subtotal - discount) / (L.value || 1)); redeemValue = round2(redeem * L.value); }
    if (redeem <= 0) redeemValue = 0;
  }
  const totalDiscount = round2(discount + redeemValue);
  const taxable = round2(subtotal - totalDiscount);
  const T = taxOf(biz, taxable);
  const total = T.total;
  const profit = round2(total - T.tax - costTotal);

  // ---- payments (one or several methods; less than the total = credit) ----
  // o.credit_available: value carried over from returned goods in an exchange; it pays first, as a non-cash "credit_note".
  const creditUsed = o.credit_available > 0 ? Math.min(round2(o.credit_available), total) : 0;
  const remainder = round2(total - creditUsed);
  let pays = Array.isArray(o.payments) && o.payments.length ? o.payments : null;
  if (!pays) pays = [{ method: PAYMENTS.includes(o.payment_method) ? o.payment_method : 'cash', amount: o.amount_paid !== undefined && o.amount_paid !== null && o.amount_paid !== '' ? o.amount_paid : remainder }];
  pays = pays.map(p => ({ method: PAYMENTS.includes(p.method) ? p.method : null, amount: money(p.amount, NaN), reference: clip(p.reference, 80) || null }));
  if (pays.some(p => !p.method || !(p.amount >= 0))) throw bad('Invalid payment method or amount');
  pays = pays.filter(p => p.amount > 0);
  const paidCash = round2(pays.reduce((s, p) => s + p.amount, 0));
  if (paidCash > remainder + 0.009) throw bad(`Payments (${paidCash}) are more than the amount due (${remainder})`);
  if (creditUsed > 0) pays.unshift({ method: 'credit_note', amount: creditUsed, reference: 'Exchange credit' });
  const paid = round2(paidCash + creditUsed);
  const paidStatus = total === 0 || paid >= total - 0.009 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  if (paidStatus !== 'paid') {
    if (!(isSuper || perms.has('sales.credit'))) throw forbidden('You are not allowed to sell on credit');
    if (biz.settings.allow_credit === false) throw bad('Credit sales are switched off for this shop');
    if (!cust) throw bad('Choose or add the customer (name and phone) to record a credit sale');
  }
  const primary = pays.filter(p => p.method !== 'credit_note').sort((a, b) => b.amount - a.amount)[0];
  const payment = primary && PAYMENTS.includes(primary.method) ? primary.method : 'cash';

  await conn.query('UPDATE businesses SET next_receipt = LAST_INSERT_ID(next_receipt + 1) WHERE id=?', [biz.id]);
  const [[{ seq }]] = await conn.query('SELECT LAST_INSERT_ID() AS seq');
  const receipt_no = `${biz.code}-${String(seq).padStart(6, '0')}`;
  const now = new Date();
  const tz = bizTz(biz);
  const today = localDate(now, tz);
  let saleDate = today;
  let soldAt = now;
  if (o.sale_date) {
    if (!isDate(o.sale_date)) throw bad('Invalid sale date (use YYYY-MM-DD)');
    if (o.sale_date > today) throw bad('Sale date cannot be in the future');
    const maxBackDays = 730; // 2 years
    const earliest = addDays(today, -maxBackDays);
    if (o.sale_date < earliest) throw bad(`Sale date cannot be more than ${maxBackDays} days in the past`);
    if (o.sale_date !== today) {
      if (!(isSuper || perms.has('sales.backdate'))) throw forbidden('You are not allowed to record past sales. Ask a Super Admin to grant the “Record past sales” permission.');
    }
    saleDate = o.sale_date;
    // Keep the current wall-clock time-of-day but place it on the chosen calendar day in the business timezone.
    // Approximate: build ISO from saleDate + current UTC time components (reports key off sale_date).
    const timePart = now.toISOString().slice(11, 19);
    soldAt = new Date(`${saleDate}T${timePart}Z`);
    if (Number.isNaN(soldAt.getTime())) soldAt = now;
  }
  const pointsEarned = L.on && cust ? Math.floor(total / L.per) : 0;
  let notes = clip(o.notes, 255) || null;
  if (saleDate !== today && notes) {
    // already has notes
  } else if (saleDate !== today) {
    notes = `Backdated sale (recorded ${today})`;
  }

  const [ins] = await conn.query(
    `INSERT INTO sales (business_id,receipt_no,source,order_id,customer_id,customer_name,customer_phone,payment_method,subtotal,discount,total,tax_amount,cost_total,profit,amount_paid,paid_status,points_earned,points_redeemed,notes,sold_by,sold_at,sale_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [biz.id, receipt_no, source, order_id, cust ? cust.id : null, clip(o.customer_name, 120) || (cust ? cust.name : null), o.customer_phone ? normPhone(o.customer_phone).slice(0, 30) : (cust ? cust.phone : null), payment, subtotal, totalDiscount, total, T.tax, costTotal, profit, paid, paidStatus, pointsEarned, redeem, notes, userId, soldAt, saleDate]
  );
  const saleId = ins.insertId;
  for (const p of pays) await conn.query('INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [biz.id, saleId, cust ? cust.id : null, p.method, p.amount, p.reference, userId, now]);
  if (cust && redeem) await customers.addPoints(conn, biz.id, cust.id, -redeem, `Redeemed on ${receipt_no}`, 'sale', saleId, userId);
  if (cust && pointsEarned) await customers.addPoints(conn, biz.id, cust.id, pointsEarned, `Earned on ${receipt_no}`, 'sale', saleId, userId);

  const lowStock = [];
  for (const l of lines) {
    await conn.query('INSERT INTO sale_items (sale_id,product_id,name,sku,category,qty,list_price,unit_price,unit_cost,line_total) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [saleId, l.p.id, l.p.name, l.p.sku, catName.get(l.p.category_id) || null, l.qty, l.p.price, l.unit, l.p.cost_price, l.line]);
    if (l.p.track_stock) {
      const bal = l.p.stock_qty - l.qty;
      await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [bal, l.p.id]);
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,ref_id,user_id) VALUES (?,?,'sale',?,?,?,'sale',?,?)",
        [biz.id, l.p.id, -l.qty, bal, l.p.cost_price, saleId, userId]);
      if (bal <= l.p.low_stock_at) lowStock.push({ id: l.p.id, name: l.p.name, stock_qty: bal, low_stock_at: l.p.low_stock_at });
    }
  }
  const priceOverrides = lines.filter(l => l.unit !== l.p.price && !(fixedPrices && fixedPrices[l.p.id] !== undefined)).map(l => ({ name: l.p.name, list: l.p.price, sold: l.unit }));
  return { id: saleId, receipt_no, subtotal, discount: totalDiscount, total, tax: T.tax, profit, cost_total: costTotal, amount_paid: paid, paid_status: paidStatus, balance_due: round2(total - paid), credit_used: creditUsed, customer_id: cust ? cust.id : null, points_earned: pointsEarned, points_redeemed: redeem, lowStock, priceOverrides };
}

async function voidSale(conn, { biz, saleId, userId, reason }) {
  const [[sale]] = await conn.query('SELECT * FROM sales WHERE id=? AND business_id=? FOR UPDATE', [saleId, biz.id]);
  if (!sale) throw notFound('Sale not found');
  if (sale.status === 'voided') throw conflict('This sale was already voided');
  if (Number(sale.refunded_total) > 0) throw conflict('This sale already has refunds. Refund the remaining items instead of voiding it.');
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
  if (sale.customer_id) {
    if (sale.points_earned) await customers.addPoints(conn, biz.id, sale.customer_id, -sale.points_earned, `Reversed: ${sale.receipt_no} voided`, 'sale', saleId, userId);
    if (sale.points_redeemed) await customers.addPoints(conn, biz.id, sale.customer_id, sale.points_redeemed, `Restored: ${sale.receipt_no} voided`, 'sale', saleId, userId);
  }
  await conn.query("UPDATE sales SET status='voided', void_reason=?, voided_by=?, voided_at=UTC_TIMESTAMP() WHERE id=?", [clip(reason, 255), userId, saleId]);
  if (sale.order_id) await conn.query("UPDATE orders SET status='confirmed', sale_id=NULL, admin_notes=CONCAT(COALESCE(admin_notes,''),' [Sale voided: ', ?, ']') WHERE id=?", [sale.receipt_no, sale.order_id]);
  return sale;
}

module.exports = { createSale, voidSale, taxOf, PAYMENTS };
