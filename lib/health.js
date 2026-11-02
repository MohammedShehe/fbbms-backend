// Business Health Monitor. Every score below comes from a visible formula (see `formula` on each indicator) - no AI guessing.
const { q, one } = require('../config/db');
const { round2, addDays, startOfMonth, safeJSON } = require('./util');
const M = require('./metrics');
const modules = require('./modules');

const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const pctChange = (cur, prev) => prev > 0 ? (cur - prev) / prev * 100 : (cur > 0 ? 100 : 0);
const statusOf = score => score >= 75 ? 'good' : score >= 50 ? 'watch' : 'risk';
const WEIGHTS = { sales: 25, profit: 25, inventory: 15, expenses: 10, customers: 5, staff: 10, receivables: 10 };

async function computeHealth(biz) {
  const today = M.today(biz); const cur7 = addDays(today, -6), prev7s = addDays(today, -13), prev7e = addDays(today, -7);
  const cur30 = addDays(today, -29), prev30s = addDays(today, -59), prev30e = addDays(today, -30);
  const [c7, p7, c30, p30, inv, rec, pay] = await Promise.all([M.period(biz, cur7, today), M.period(biz, prev7s, prev7e), M.period(biz, cur30, today), M.period(biz, prev30s, prev30e), M.inventory(biz, today), M.receivables(biz), M.payables(biz)]);
  const ind = []; const recs = []; const flags = [];
  const add = (key, label, score, headline, detail, formula, extra = {}) => ind.push({ key, label, score: score === null ? null : Math.round(score), status: score === null ? 'nodata' : statusOf(score), headline, detail, formula, weight: WEIGHTS[key] || 0, ...extra });

  // 1 Sales
  const g = pctChange(c7.net_revenue, p7.net_revenue);
  if (!c7.net_revenue && !p7.net_revenue) add('sales', 'Sales performance', null, 'No sales in the last 14 days', 'Record sales to unlock this indicator.', 'score = 60 + 1.5 × (revenue growth % vs the previous 7 days), limited to 0-100');
  else {
    add('sales', 'Sales performance', clamp(60 + 1.5 * g), g >= 5 ? 'Improving' : g >= -10 ? 'Stable' : 'Declining', `Last 7 days ${round2(c7.net_revenue)} vs ${round2(p7.net_revenue)} before (${g >= 0 ? '+' : ''}${round2(g)}%)`, 'score = 60 + 1.5 × (revenue growth % vs the previous 7 days), limited to 0-100', { value: round2(g), unit: '%' });
    if (g < -10) recs.push({ priority: 'high', page: 'reports', text: `Sales are down ${Math.abs(round2(g))}% this week. Review the best sellers that slowed down and check stock-outs.` });
  }

  // 2 Profitability (rolling 30 days)
  if (!c30.net_revenue) add('profit', 'Profitability', null, 'No sales in the last 30 days', 'Profit needs sales and recorded expenses.', 'score = 6 × net margin % (30 days), limited to 0-100');
  else {
    const m = c30.margin_pct, netM = round2(c30.net_profit / c30.net_revenue * 100);
    add('profit', 'Profitability', clamp(netM * 6), netM >= 12 ? 'Healthy margin' : netM >= 3 ? 'Needs attention' : c30.net_profit < 0 ? 'Losing money' : 'Very thin margin', `Net profit ${round2(c30.net_profit)} on ${round2(c30.net_revenue)} revenue (${netM}% net, ${m}% gross)`, 'score = 6 × net margin % (30 days), limited to 0-100', { value: netM, unit: '%' });
    if (netM < 3) recs.push({ priority: 'high', page: 'reports', text: c30.net_profit < 0 ? 'You spent more than you earned in the last 30 days. Review expenses and the lowest-margin products.' : 'Net margin is below 3%. Review low-margin products and discounts.' });
  }
  const lowMargin = await q(`SELECT i.name, SUM(i.line_total) AS revenue, ROUND(SUM(i.line_total - i.unit_cost*i.qty)/NULLIF(SUM(i.line_total),0)*100,1) AS margin FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=? AND s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY i.product_id,i.name HAVING revenue>0 AND margin<10 ORDER BY revenue DESC LIMIT 5`, [biz.id, cur30, today]);
  if (lowMargin.length) recs.push({ priority: 'medium', page: 'products', text: `Products selling below 10% margin: ${lowMargin.map(p => `${p.name} (${p.margin}%)`).join(', ')}. Consider raising prices or renegotiating cost.` });

  // 3 Inventory
  const badN = Number(inv.low) + Number(inv.out_of_stock); const ratio = badN / Math.max(1, inv.products);
  const deadValue = inv.dead_stock.reduce((t, d) => t + Number(d.tied_up), 0);
  add('inventory', 'Inventory health', inv.products ? clamp(100 - ratio * 150 - (inv.dead_stock.length ? Math.min(15, inv.dead_stock.length * 3) : 0) - (inv.expiring.length ? Math.min(15, inv.expiring.length * 5) : 0)) : null,
    badN ? `${badN} product${badN > 1 ? 's' : ''} low or out of stock` : 'Stock levels look healthy', `${inv.out_of_stock} out of stock · ${inv.low} low · ${inv.dead_stock.length} not sold in 60 days (${round2(deadValue)} tied up) · ${inv.expiring.length} expiring within 30 days`,
    'score = 100 − 150 × (low + out-of-stock products ÷ all products) − 3 per slow product (max 15) − 5 per expiring product (max 15)', { value: badN });
  if (badN) recs.push({ priority: inv.out_of_stock ? 'high' : 'medium', page: modules.enabled(biz, 'suppliers') ? 'suppliers' : 'products', text: `Restock ${badN} product${badN > 1 ? 's' : ''} approaching or at zero: ${inv.low_list.slice(0, 5).map(p => `${p.name} (${p.stock_qty})`).join(', ')}${badN > 5 ? '…' : ''}.` });
  if (inv.dead_stock.length) recs.push({ priority: 'low', page: 'products', text: `${inv.dead_stock.length} products have not sold in 60 days and tie up ${round2(deadValue)}. Consider a promotion or bundle: ${inv.dead_stock.slice(0, 3).map(p => p.name).join(', ')}.` });
  if (inv.expiring.length) recs.push({ priority: 'high', page: 'products', text: `${inv.expiring.length} product(s) expire within 30 days or already expired: ${inv.expiring.slice(0, 3).map(p => p.name).join(', ')}. Discount or remove them.` });

  // 4 Expenses
  const eg = pctChange(c30.expenses, p30.expenses);
  if (!c30.expenses && c30.net_revenue > 0) add('expenses', 'Expense control', 60, 'No expenses recorded', 'Profit may be overstated until expenses are recorded.', 'score = 100 − 2 × (expense growth % vs the previous 30 days) when growth is positive; 60 when nothing is recorded');
  else if (!c30.expenses && !p30.expenses) add('expenses', 'Expense control', null, 'No expenses recorded', '', '');
  else {
    add('expenses', 'Expense control', clamp(eg > 0 ? 100 - 2 * eg : 100), eg > 25 ? 'Growing fast' : eg > 10 ? 'Rising' : 'Under control', `Last 30 days ${round2(c30.expenses)} vs ${round2(p30.expenses)} before (${eg >= 0 ? '+' : ''}${round2(eg)}%)${c30.net_revenue ? ` · ${round2(c30.expenses / c30.net_revenue * 100)}% of revenue` : ''}`, 'score = 100 − 2 × (expense growth % vs the previous 30 days) when growth is positive, otherwise 100', { value: round2(eg), unit: '%' });
    if (eg > 15) { const top = await q("SELECT category, SUM(amount) AS t FROM expenses WHERE business_id=? AND voided=0 AND status='approved' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY t DESC LIMIT 2", [biz.id, cur30, today]); recs.push({ priority: eg > 25 ? 'high' : 'medium', page: 'expenses', text: `Operating expenses are ${round2(eg)}% higher than the previous 30 days${top.length ? ` (largest: ${top.map(t => `${t.category} ${round2(t.t)}`).join(', ')})` : ''}. Investigate the increase.` }); }
  }

  // 5 Customers
  if (modules.enabled(biz, 'customers')) {
    const [nc, pc] = await Promise.all([M.newCustomers(biz, cur30, today), M.newCustomers(biz, prev30s, prev30e)]); const cg = pctChange(nc, pc);
    add('customers', 'Customer growth', (nc || pc) ? clamp(60 + 0.5 * cg) : null, (nc || pc) ? (cg >= 0 ? 'Improving' : 'Slowing') : 'No customers registered yet', `${nc} new customers in 30 days vs ${pc} before`, 'score = 60 + 0.5 × (growth % in new customers vs the previous 30 days), limited to 0-100', { value: nc });
    const dormant = await one("SELECT COUNT(*) AS n FROM customers c WHERE c.business_id=? AND c.status='active' AND EXISTS (SELECT 1 FROM sales s WHERE s.customer_id=c.id AND s.status='completed') AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id=c.id AND s.status='completed' AND s.sale_date>?)", [biz.id, addDays(today, -90)]);
    if (dormant.n >= 5) recs.push({ priority: 'low', page: 'customers', text: `${dormant.n} customers have not bought in 90 days. A WhatsApp message with an offer could win them back.` });
  }

  // 6 Staff + controls
  const sellers = await M.bySeller(biz, cur30, today); const shopDisc = sellers.reduce((t, s) => t + Number(s.discounts), 0) / Math.max(1, sellers.reduce((t, s) => t + Number(s.gross), 0));
  let staffScore = 100; const best = sellers[0];
  for (const s of sellers) {
    const vr = s.sales ? s.voids / (Number(s.sales) + Number(s.voids)) : 0; const dr = Number(s.gross) ? Number(s.discounts) / Number(s.gross) : 0;
    if (Number(s.sales) + Number(s.voids) >= 10 && vr > 0.05) { flags.push({ severity: vr > 0.1 ? 'high' : 'medium', who: s.name, title: 'High void rate', detail: `${s.voids} of ${Number(s.sales) + Number(s.voids)} sales voided (${round2(vr * 100)}%) in 30 days.` }); staffScore -= vr > 0.1 ? 25 : 12; }
    if (Number(s.sales) >= 10 && dr > Math.max(0.03, shopDisc * 2)) { flags.push({ severity: 'medium', who: s.name, title: 'Discounts well above average', detail: `Gave ${round2(dr * 100)}% off on average vs ${round2(shopDisc * 100)}% for the whole shop.` }); staffScore -= 10; }
    if (s.odd_hours >= 3) { flags.push({ severity: 'medium', who: s.name, title: 'Sales between midnight and 5am', detail: `${s.odd_hours} sales recorded in the small hours in 30 days.` }); staffScore -= 8; }
  }
  const ovr = await q("SELECT u.name, COUNT(*) AS n FROM audit_log a JOIN users u ON u.id=a.user_id WHERE a.business_id=? AND a.action='sale.price_override' AND a.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) GROUP BY a.user_id,u.name HAVING n>=5", [biz.id]);
  ovr.forEach(o => { flags.push({ severity: 'medium', who: o.name, title: 'Frequent price overrides', detail: `${o.n} sales sold at a price different from the list price in 30 days.` }); staffScore -= 8; });
  const adj = await q("SELECT u.name, COUNT(*) AS n FROM audit_log a JOIN users u ON u.id=a.user_id WHERE a.business_id=? AND a.action IN ('stock.adjustment','stock.damage') AND a.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) GROUP BY a.user_id,u.name HAVING n>=5", [biz.id]);
  adj.forEach(o => { flags.push({ severity: 'medium', who: o.name, title: 'Many stock adjustments / write-offs', detail: `${o.n} manual stock changes in 30 days. Verify them against physical counts.` }); staffScore -= 8; });
  if (modules.enabled(biz, 'refunds') && c30.sales) { const rr = c30.refunds.amount / Math.max(1, c30.revenue) * 100; if (rr > 8) { flags.push({ severity: rr > 15 ? 'high' : 'medium', who: null, title: 'High refund rate', detail: `Refunds are ${round2(rr)}% of sales in 30 days.` }); staffScore -= rr > 15 ? 20 : 10; } }
  if (modules.enabled(biz, 'cash')) { const cv = await q("SELECT variance,expected_cash,closed_at FROM cash_sessions WHERE business_id=? AND status='closed' AND closed_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) AND variance<>0", [biz.id]); const bigs = cv.filter(c => Math.abs(c.variance) > Math.max(1000, Number(c.expected_cash || 0) * 0.02)); if (bigs.length) { flags.push({ severity: 'high', who: null, title: 'Till differences', detail: `${bigs.length} cash-up(s) in 30 days were off by more than 2%: ${bigs.slice(0, 3).map(b => b.variance).join(', ')}.` }); staffScore -= Math.min(30, bigs.length * 10); } }
  const rc = await one("SELECT COALESCE(SUM(CASE WHEN type IN ('opening','purchase') THEN qty_change ELSE 0 END),0)+COALESCE(SUM(CASE WHEN type NOT IN ('opening','purchase') THEN qty_change ELSE 0 END),0) AS ledger FROM stock_movements WHERE business_id=?", [biz.id]);
  const onHand = (await one('SELECT COALESCE(SUM(stock_qty),0) AS u FROM products WHERE business_id=? AND track_stock=1', [biz.id])).u;
  if (Number(rc.ledger) !== Number(onHand)) { flags.push({ severity: 'high', who: null, title: 'Stock ledger does not match the shelf', detail: `Ledger says ${rc.ledger} units, system shows ${onHand}.` }); staffScore -= 20; }
  add('staff', 'Staff & controls', sellers.length || flags.length ? clamp(staffScore) : null, flags.length ? `${flags.length} item${flags.length > 1 ? 's' : ''} to review` : 'Nothing unusual', best ? `Top seller: ${best.name} (${round2(best.revenue)} in 30 days)` : 'No sales yet', 'score = 100 − 25/12 per high/medium void rate − 10 per heavy-discount seller − 8 per odd-hours, override or adjustment pattern − refund/till/stock-ledger penalties', { top_seller: best ? { name: best.name, revenue: Number(best.revenue) } : null });
  if (flags.length) recs.push({ priority: 'medium', page: 'audit', text: `Review the ${flags.length} risk flag${flags.length > 1 ? 's' : ''} below in the audit trail.` });

  // 7 Receivables
  if (modules.enabled(biz, 'customers') || rec.total > 0) {
    const share = c30.net_revenue ? rec.total / c30.net_revenue * 100 : (rec.total > 0 ? 100 : 0);
    add('receivables', 'Outstanding payments', rec.total ? clamp(100 - 2 * share) : 100, rec.total ? `${rec.invoices} unpaid sale${rec.invoices > 1 ? 's' : ''} from ${rec.customers} customer${rec.customers > 1 ? 's' : ''}` : 'No customer debts', `Customers owe ${round2(rec.total)}${pay.total ? ` · you owe suppliers ${round2(pay.total)}` : ''}`, 'score = 100 − 2 × (customer debts as % of the last 30 days revenue), limited to 0-100', { value: round2(rec.total) });
    if (rec.total) recs.push({ priority: share > 20 ? 'high' : 'medium', page: 'customers', text: `Collect ${round2(rec.total)} owed by ${rec.customers} customer(s). Start with the oldest debts.` });
  }
  if (pay.total) recs.push({ priority: 'low', page: 'suppliers', text: `You owe suppliers ${round2(pay.total)}. Schedule payments to keep good terms.` });

  const used = ind.filter(i => i.score !== null && i.weight);
  const wsum = used.reduce((t, i) => t + i.weight, 0);
  const overall = wsum ? Math.round(used.reduce((t, i) => t + i.score * i.weight, 0) / wsum) : null;
  const order = { high: 0, medium: 1, low: 2 }; recs.sort((a, b) => order[a.priority] - order[b.priority]);
  return { as_of: today, score: overall, grade: overall === null ? 'No data yet' : overall >= 75 ? 'Healthy' : overall >= 50 ? 'Needs attention' : 'At risk', indicators: ind, flags: flags.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1)), recommendations: recs,
    method: 'Overall score = weighted average of the indicators that have data. Weights: ' + Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', ') + '. Each indicator formula is listed with it.', snapshot: { last7: c7, prev7: p7, last30: c30, prev30: p30 } };
}

/** Transparent forecast: same-weekday average of the last 4 weeks x recent trend. */
async function forecast(biz) {
  const today = M.today(biz); const from = addDays(today, -55); const hist = await M.daily(biz, from, today);
  const days = hist.slice(-28); const nonZero = hist.filter(d => d.revenue > 0).length;
  const avg = arr => arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : 0;
  const last14 = avg(hist.slice(-14).map(d => d.revenue)), prev14 = avg(hist.slice(-28, -14).map(d => d.revenue));
  const trend = prev14 > 0 ? clamp(last14 / prev14, 0.7, 1.3) : 1;
  const overall = avg(days.map(d => d.revenue));
  const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
  const out = []; const w = [4, 3, 2, 1];
  for (let i = 1; i <= 14; i++) {
    const d = addDays(today, i); const same = []; for (let k = 1; k <= 4; k++) { const hd = addDays(d, -7 * k); const row = hist.find(x => x.date === hd); if (row) same.push({ v: row.revenue, w: w[k - 1] }); }
    const base = same.length ? same.reduce((t, s) => t + s.v * s.w, 0) / same.reduce((t, s) => t + s.w, 0) : overall;
    out.push({ date: d, revenue: Math.max(0, round2(base * trend)) });
  }
  const mStart = startOfMonth(today); const lastDay = (() => { const d = new Date(mStart + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
  const mtd = hist.filter(d => d.date >= mStart).reduce((t, d) => t + d.revenue, 0);
  let rest = 0; for (let d = addDays(today, 1); d <= lastDay; d = addDays(d, 1)) { const k = out.find(o => o.date === d); if (k) rest += k.revenue; else { const same = hist.filter(h => dow(h.date) === dow(d)).slice(-4); rest += avg(same.map(s => s.revenue)) * trend; } }
  return { as_of: today, history: days, next_days: out, month_to_date: round2(mtd), projected_month_end: round2(mtd + rest), trend_factor: round2(trend), confidence: nonZero >= 28 ? 'good' : nonZero >= 14 ? 'fair' : 'low', method: 'Each future day = weighted average of the same weekday over the last 4 weeks (recent weeks count more) × recent trend (last 14 days ÷ the 14 days before, limited to 0.7-1.3). It is an estimate, not a promise.' };
}

module.exports = { computeHealth, forecast };
