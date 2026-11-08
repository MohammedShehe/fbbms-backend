// Safe business deletion for the Developer: preview what will go, download a full backup first, then remove everything
// belonging to the business in ONE transaction (all-or-nothing). The audit trail is kept on purpose.
const { q, one, pool } = require('../config/db');
const { safeJSON, round2 } = require('./util');
const { destroyImage, publicIdFromUrl } = require('./cloudinary');
const rt = require('./realtime');

// Child tables that have no business_id of their own: reached through their parent.
const CHILDREN = [
  { table: 'order_items', parent: 'orders', fk: 'order_id' },
  { table: 'sale_items', parent: 'sales', fk: 'sale_id' },
  { table: 'purchase_order_items', parent: 'purchase_orders', fk: 'po_id' },
  { table: 'refund_items', parent: 'refunds', fk: 'refund_id' }
];
const KEEP = ['audit_log', 'businesses'];                       // never deleted with the business
const NO_EXPORT = ['api_keys', 'webhooks', 'idempotency_keys', 'api_request_log', 'ai_usage', 'login_history', 'notifications']; // secrets / noise
const q2 = s => '`' + String(s).replace(/`/g, '') + '`';

/** Every table that has a business_id column in the current database (discovered, so new modules are covered automatically). */
async function tablesWithBusiness(run = q) {
  const rows = await run("SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='business_id'");
  return rows.map(r => r.t || r.T || r.TABLE_NAME).filter(t => t && !KEEP.includes(t)).sort();
}
async function existing(run, names) {
  const rows = await run('SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  const have = new Set(rows.map(r => r.t || r.T || r.TABLE_NAME)); return names.filter(n => have.has(n));
}

async function preview(biz) {
  const tables = await tablesWithBusiness();
  const counts = {};
  for (const t of tables) counts[t] = (await one(`SELECT COUNT(*) AS n FROM ${q2(t)} WHERE business_id=?`, [biz.id])).n;
  for (const c of await existing(q, CHILDREN.map(x => x.table))) { const ch = CHILDREN.find(x => x.table === c); counts[c] = (await one(`SELECT COUNT(*) AS n FROM ${q2(c)} x JOIN ${q2(ch.parent)} p ON p.id=x.${ch.fk} WHERE p.business_id=?`, [biz.id])).n; }
  const orphans = await q(`SELECT u.id,u.name,u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.business_id=? AND u.is_developer=0 AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id=u.id AND m2.business_id<>?)`, [biz.id, biz.id]);
  const shared = await q(`SELECT u.id,u.name,u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.business_id=? AND u.is_developer=0 AND EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id=u.id AND m2.business_id<>?)`, [biz.id, biz.id]);
  const money = await one("SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS n, MIN(sale_date) AS first_sale, MAX(sale_date) AS last_sale FROM sales WHERE business_id=? AND status='completed'", [biz.id]);
  const due = await one("SELECT COALESCE(SUM(GREATEST(0,total-amount_paid)),0) AS v, COUNT(*) AS n FROM sales WHERE business_id=? AND status='completed' AND total-amount_paid>0.009", [biz.id]);
  const pending = await one("SELECT COUNT(*) AS n FROM billing_payments WHERE business_id=? AND status='pending' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())", [biz.id]).catch(() => ({ n: 0 }));
  const images = await countImages(biz);
  const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  return { counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), total_rows: total, users_to_delete: orphans, users_kept: shared, sales: { count: Number(money.n), revenue: Number(money.revenue), first: money.first_sale, last: money.last_sale }, unpaid: { count: Number(due.n), amount: round2(Number(due.v)) }, pending_payments: Number(pending.n), images, status: biz.status };
}

async function imageIds(biz) {
  const ids = new Set(); const prefix = `fbbms/${biz.slug}/`;
  const add = pid => { if (pid && pid.startsWith(prefix)) ids.add(pid); };
  const th = safeJSON(biz.theme, {}); add(th.logo_public_id);
  for (const t of ['products', 'vehicles']) { const ok = await existing(q, [t]); if (!ok.length) continue; for (const r of await q(`SELECT image_url FROM ${q2(t)} WHERE business_id=? AND image_url IS NOT NULL`, [biz.id])) add(publicIdFromUrl(r.image_url)); }
  return [...ids];
}
const countImages = async biz => (await imageIds(biz)).length;

/** Whole-business JSON backup (no password hashes, API secrets or webhook secrets). */
async function exportData(biz) {
  const out = { format: 'fbbms-business-backup', version: 1, exported_at: new Date().toISOString(), business: { ...biz, settings: safeJSON(biz.settings, {}), theme: safeJSON(biz.theme, {}) }, tables: {} };
  for (const t of (await tablesWithBusiness()).filter(x => !NO_EXPORT.includes(x))) out.tables[t] = await q(`SELECT * FROM ${q2(t)} WHERE business_id=? LIMIT 500000`, [biz.id]);
  for (const c of await existing(q, CHILDREN.map(x => x.table))) { const ch = CHILDREN.find(x => x.table === c); out.tables[c] = await q(`SELECT x.* FROM ${q2(c)} x JOIN ${q2(ch.parent)} p ON p.id=x.${ch.fk} WHERE p.business_id=? LIMIT 1000000`, [biz.id]); }
  out.tables.users = await q('SELECT u.id,u.name,u.email,u.phone,u.status,u.created_at FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.business_id=?', [biz.id]);
  return out;
}

/** Deletes the business and everything in it. Returns a summary. Throws if anything fails (nothing is removed then). */
async function remove(biz, { deleteOrphanUsers = true } = {}) {
  const summary = await preview(biz); const images = await imageIds(biz);
  const conn = await pool.getConnection(); const removedUsers = [];
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    for (const c of await existing(async (s, p) => (await conn.query(s, p))[0], CHILDREN.map(x => x.table))) { const ch = CHILDREN.find(x => x.table === c); await conn.query(`DELETE x FROM ${q2(c)} x JOIN ${q2(ch.parent)} p ON p.id=x.${ch.fk} WHERE p.business_id=?`, [biz.id]); }
    const tables = await tablesWithBusiness(async (s, p) => (await conn.query(s, p))[0]);
    // memberships are read before they are deleted (to find users that would be left without any business)
    let orphanIds = [];
    if (deleteOrphanUsers) { const [o] = await conn.query(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.business_id=? AND u.is_developer=0 AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id=u.id AND m2.business_id<>?)`, [biz.id, biz.id]); orphanIds = o.map(r => r.id); }
    for (const t of tables) await conn.query(`DELETE FROM ${q2(t)} WHERE business_id=?`, [biz.id]);
    if (orphanIds.length) {
      for (const t of ['sessions', 'otp_codes', 'login_history']) { const [has] = await conn.query('SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=\'user_id\'', [t]); if (has.length) await conn.query(`DELETE FROM ${q2(t)} WHERE user_id IN (?)`, [orphanIds]); }
      await conn.query('DELETE FROM users WHERE id IN (?) AND is_developer=0', [orphanIds]); removedUsers.push(...orphanIds);
    }
    await conn.query('UPDATE audit_log SET business_id=NULL WHERE business_id=?', [biz.id]); // keep the trail, detach it from the vanished business
    const [r] = await conn.query('DELETE FROM businesses WHERE id=?', [biz.id]); if (!r.affectedRows) throw new Error('Business was not found');
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
    await conn.commit();
  } catch (e) { try { await conn.rollback(); } catch (_) {} try { await conn.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) {} throw e; }
  finally { try { await conn.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) {} conn.release(); }
  for (const id of images) destroyImage(id).catch(() => {}); // best effort, after the data is gone
  if (rt.drop) rt.drop(biz.id);
  return { ...summary, users_deleted: removedUsers.length, images_removed: images.length };
}

module.exports = { preview, exportData, remove, tablesWithBusiness };
