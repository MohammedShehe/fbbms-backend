// Background jobs (no extra services needed): daily/weekly summaries, recurring expenses, backups, housekeeping.
const { q, one } = require('../config/db');
const { round2, addDays, safeJSON } = require('./util');
const { bizTz, localDate, localHour, localDow } = require('./tz');
const modules = require('./modules');
const M = require('./metrics');
const { notify } = require('./notify');
const platform = require('./platform');
const billing = require('./billing');
const backup = require('./backup');

const state = { last_run: null, last_error: null, runs: 0 };
const fmt = (biz, n) => `${biz.currency} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function dailySummary(biz, date) {
  const p = await M.period(biz, date, date); if (!p.sales && !p.expenses && !p.refunds.count) return;
  const sel = await M.bySeller(biz, date, date); const top = (await M.topProducts(biz, date, date, { limit: 3 })).map(t => `${t.name} (${t.units})`).join(', ');
  const body = [`Sales: ${p.sales} · Revenue ${fmt(biz, p.net_revenue)} · Profit ${fmt(biz, p.gross_profit)} · Expenses ${fmt(biz, p.expenses)} · Net ${fmt(biz, p.net_profit)}`, p.refunds.count ? `Refunds: ${p.refunds.count} (${fmt(biz, p.refunds.amount)})` : '', p.voids.count ? `Voided sales: ${p.voids.count} (${fmt(biz, p.voids.value)})` : '', top ? `Best sellers: ${top}` : '', sel[0] ? `Top seller: ${sel[0].name} (${fmt(biz, sel[0].revenue)})` : ''].filter(Boolean).join('\n');
  await notify(biz, { type: 'daily.summary', severity: 'info', audience: 'super', title: `Daily summary ${date}: ${fmt(biz, p.net_revenue)}`, body, dedupe: `daily:${date}` });
}
async function weeklySummary(biz, today) {
  const to = addDays(today, -1), from = addDays(today, -7); const [c, p] = await Promise.all([M.period(biz, from, to), M.period(biz, addDays(from, -7), addDays(from, -1))]);
  if (!c.sales && !p.sales) return; const g = p.net_revenue ? round2((c.net_revenue - p.net_revenue) / p.net_revenue * 100) : null;
  let extra = ''; try { if (modules.enabled(biz, 'health')) { const h = await require('./health').computeHealth(biz); extra = `\nHealth score: ${h.score}/100 (${h.grade})${h.recommendations[0] ? '\nTop action: ' + h.recommendations[0].text : ''}`; } } catch (_) { /* ignore */ }
  await notify(biz, { type: 'weekly.summary', severity: 'info', audience: 'super', title: `Weekly summary ${from} → ${to}: ${fmt(biz, c.net_revenue)}`, body: `Revenue ${fmt(biz, c.net_revenue)}${g !== null ? ` (${g >= 0 ? '+' : ''}${g}% vs previous week)` : ''}\nNet profit ${fmt(biz, c.net_profit)} · ${c.sales} sales${extra}`, dedupe: `weekly:${from}` });
}
async function lowStockDigest(biz, today) {
  const inv = await M.inventory(biz, today);
  if (inv.low_list.length) await notify(biz, { type: 'stock.low', severity: inv.out_of_stock ? 'warn' : 'info', audience: 'all', title: `${inv.low_list.length} product(s) low or out of stock`, body: inv.low_list.slice(0, 8).map(p => `${p.name}: ${p.stock_qty}`).join('\n'), dedupe: `lowdigest:${today}` });
  if (inv.expiring.length) await notify(biz, { type: 'stock.expiry', severity: 'warn', audience: 'all', title: `${inv.expiring.length} product(s) expiring soon`, body: inv.expiring.slice(0, 8).map(p => `${p.name}: ${p.expiry_date}${p.expired ? ' (EXPIRED)' : ''}`).join('\n'), dedupe: `expiry:${today}` });
}
async function recurring(biz, today) {
  const rows = await q('SELECT * FROM recurring_expenses WHERE business_id=? AND active=1 AND next_date<=?', [biz.id, today]);
  for (const r of rows) {
    let d = r.next_date; let guard = 0;
    while (d <= today && guard++ < 24) { await q("INSERT INTO expenses (business_id,expense_date,category,description,amount,created_by,status,recurring_id) VALUES (?,?,?,?,?,?,'approved',?)", [biz.id, d, r.category, `${r.description || r.category} (recurring)`, r.amount, r.created_by, r.id]); const dt = new Date(d + 'T00:00:00Z'); if (r.frequency === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7); else dt.setUTCMonth(dt.getUTCMonth() + 1); d = dt.toISOString().slice(0, 10); }
    await q('UPDATE recurring_expenses SET next_date=? WHERE id=?', [d, r.id]);
  }
}

async function tick() {
  state.runs++; state.last_run = new Date().toISOString();
  try {
    const bizs = await q("SELECT * FROM businesses WHERE status='active'"); const bcfg = await billing.config();
    for (const b of bizs) {
      if (billing.lockedNow(b, bcfg)) continue; // unpaid business: no automatic entries, no summaries
      b.settings = safeJSON(b.settings, {}); const tz = bizTz(b); const now = new Date(); const today = localDate(now, tz); const hour = localHour(now, tz);
      try {
        await recurring(b, today);
        if (modules.enabled(b, 'rentals') && hour >= 7) await require('../routes/rentals').remindersTick(b, today);
        if (modules.enabled(b, 'alerts')) {
          if (hour >= (Number(b.settings.summary_hour) || 20)) await dailySummary(b, today);
          if (localDow(now, tz) === 1 && hour >= 8) await weeklySummary(b, today);
          if (hour >= 8) await lowStockDigest(b, today);
        }
      } catch (e) { console.error('scheduler business error:', b.slug, e.message); }
    }
    const bk = await platform.backup(); if (bk.enabled && new Date().getUTCHours() === Number(bk.hour) && !backup.list().some(f => Date.now() - new Date(f.created_at) < 3600000 * 3)) { await backup.run(); backup.prune(bk.keep); }
    await q("DELETE FROM sessions WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)"); await q('DELETE FROM api_request_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)'); await q('DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)'); await q('DELETE FROM login_history WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 180 DAY)');
    state.last_error = null;
  } catch (e) { state.last_error = e.message; console.error('scheduler error:', e.message); }
}
function start() { if (process.env.DISABLE_SCHEDULER === 'true') return; setTimeout(tick, 20000).unref(); setInterval(tick, 30 * 60 * 1000).unref(); }
module.exports = { start, tick, status: () => ({ ...state, enabled: process.env.DISABLE_SCHEDULER !== 'true' }), dailySummary, weeklySummary, recurring };
