// Branches: several businesses under one head office. Each branch keeps its own stock, staff, sales and cash;
// the head office (a Super Admin of the branches, or the Developer) compares performance and moves stock between them.
const router = require('express').Router();
const { q, one, tx } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { bad, forbidden, notFound, wrap, clip, int, round2, safeJSON, isDate, addDays } = require('../lib/util');
const M = require('../lib/metrics');
const { startOfMonth } = require('../lib/util');
const { audit } = require('../lib/audit');
const rt = require('../lib/realtime');

router.use(authenticate);

async function branchesFor(req, groupId) {
  const rows = await q('SELECT * FROM businesses WHERE group_id=? ORDER BY id', [groupId]); if (!rows.length) throw notFound('Group not found');
  rows.forEach(b => { b.settings = safeJSON(b.settings, {}); b.theme = safeJSON(b.theme, {}); });
  if (req.user.is_developer) return rows;
  const ms = await q("SELECT business_id FROM memberships WHERE user_id=? AND role='super_admin' AND status='active'", [req.user.id]); const ok = new Set(ms.map(m => m.business_id));
  const mine = rows.filter(b => ok.has(b.id) && b.status === 'active'); if (!mine.length) throw forbidden('Head-office access needs Super Admin rights in a branch of this group');
  return mine;
}

router.get('/mine', wrap(async (req, res) => {
  const rows = await q(req.user.is_developer ? 'SELECT g.id,g.name FROM business_groups g ORDER BY g.name' : `SELECT DISTINCT g.id,g.name FROM business_groups g JOIN businesses b ON b.group_id=g.id JOIN memberships m ON m.business_id=b.id WHERE m.user_id=? AND m.role='super_admin' AND m.status='active' ORDER BY g.name`, req.user.is_developer ? [] : [req.user.id]);
  res.json(rows);
}));

router.get('/:id/compare', wrap(async (req, res) => {
  const bs = await branchesFor(req, int(req.params.id)); const t = M.today(bs[0]);
  const from = isDate(req.query.from) ? req.query.from : startOfMonth(t); const to = isDate(req.query.to) ? req.query.to : t;
  const out = [];
  for (const b of bs) { const [p, inv, rec] = await Promise.all([M.period(b, from, to), M.inventory(b, M.today(b)), M.receivables(b)]); out.push({ id: b.id, name: b.name, short_name: b.short_name, currency: b.currency, revenue: p.net_revenue, profit: p.gross_profit, expenses: p.expenses, net_profit: p.net_profit, margin_pct: p.margin_pct, sales: p.sales, avg_sale: p.avg_sale, refunds: p.refunds.amount, stock_value_cost: Number(inv.cost_value), low_stock: Number(inv.low) + Number(inv.out_of_stock), customer_debts: rec.total }); }
  const cur = [...new Set(out.map(o => o.currency))];
  res.json({ from, to, branches: out, totals: cur.length === 1 ? { currency: cur[0], revenue: round2(out.reduce((s, o) => s + o.revenue, 0)), net_profit: round2(out.reduce((s, o) => s + o.net_profit, 0)), sales: out.reduce((s, o) => s + o.sales, 0) } : null, note: cur.length > 1 ? 'Branches use different currencies, so no combined total is shown.' : undefined });
}));

router.get('/:id/products', wrap(async (req, res) => {
  const bs = await branchesFor(req, int(req.params.id)); const bid = int(req.query.business); const b = bs.find(x => x.id === bid); if (!b) throw forbidden('Not a branch you manage');
  res.json(await q("SELECT id,sku,name,stock_qty,price FROM products WHERE business_id=? AND status='active' AND track_stock=1 ORDER BY name LIMIT 1000", [b.id]));
}));

// Move stock between two branches (matched by SKU). Both sides get permanent stock-ledger rows.
router.post('/:id/transfer', wrap(async (req, res) => {
  const bs = await branchesFor(req, int(req.params.id)); const from = bs.find(b => b.id === int(req.body.from_business)); const to = bs.find(b => b.id === int(req.body.to_business));
  if (!from || !to) throw forbidden('Choose two branches you manage'); if (from.id === to.id) throw bad('Choose two different branches');
  const items = Array.isArray(req.body.items) ? req.body.items : []; if (!items.length) throw bad('Add at least one product'); const note = clip(req.body.note, 200);
  const out = await tx(async conn => {
    const moved = [];
    for (const it of items) {
      const qty = int(it.qty); if (qty < 1) throw bad('Quantity must be at least 1');
      const [[p]] = await conn.query('SELECT * FROM products WHERE id=? AND business_id=? AND track_stock=1 FOR UPDATE', [int(it.product_id), from.id]); if (!p) throw bad('A product was not found in the sending branch');
      if (p.stock_qty < qty) throw bad(`"${p.name}": only ${p.stock_qty} available`);
      let [[t]] = await conn.query('SELECT * FROM products WHERE business_id=? AND sku=? FOR UPDATE', [to.id, p.sku]);
      if (!t) { if (req.body.create_missing !== true) throw bad(`"${p.name}" (${p.sku}) does not exist in ${to.short_name}. Tick "create missing products" to add it.`); const [r] = await conn.query('INSERT INTO products (business_id,sku,name,brand,size,description,cost_price,price,stock_qty,low_stock_at,track_stock,created_by) VALUES (?,?,?,?,?,?,?,?,0,?,1,?)', [to.id, p.sku, p.name, p.brand, p.size, p.description, p.cost_price, p.price, p.low_stock_at, req.user.id]); [[t]] = await conn.query('SELECT * FROM products WHERE id=?', [r.insertId]); }
      const a = p.stock_qty - qty, b = t.stock_qty + qty;
      await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [a, p.id]); await conn.query('UPDATE products SET stock_qty=? WHERE id=?', [b, t.id]);
      const n = `Transfer ${from.short_name} → ${to.short_name}${note ? ': ' + note : ''}`;
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,note,user_id) VALUES (?,?,'transfer_out',?,?,?,'transfer',?,?)", [from.id, p.id, -qty, a, p.cost_price, n, req.user.id]);
      await conn.query("INSERT INTO stock_movements (business_id,product_id,type,qty_change,balance_after,unit_cost,ref_type,note,user_id) VALUES (?,?,'transfer_in',?,?,?,'transfer',?,?)", [to.id, t.id, qty, b, p.cost_price, n, req.user.id]);
      moved.push({ sku: p.sku, name: p.name, qty });
    }
    await audit(req, { business_id: from.id, action: 'stock.transfer_out', details: { to: to.short_name, moved }, conn }); await audit(req, { business_id: to.id, action: 'stock.transfer_in', details: { from: from.short_name, moved }, conn });
    return { moved };
  });
  rt.broadcast(from.id, 'product.changed', {}); rt.broadcast(to.id, 'product.changed', {});
  res.json(out);
}));
module.exports = router;
