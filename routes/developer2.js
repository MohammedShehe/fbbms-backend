// More Developer-console powers: AI settings & monitoring, feature modules, API policy/keys, branch groups, system health, backups, maintenance.
const router = require('express').Router();
const fs = require('fs');
const { q, one } = require('../config/db');
const { authenticate, requireDeveloper } = require('../middleware/auth');
const { bad, notFound, wrap, clip, int, safeJSON } = require('../lib/util');
const platform = require('../lib/platform');
const secrets = require('../lib/secrets');
const modules = require('../lib/modules');
const ai = require('../lib/ai');
const backup = require('../lib/backup');
const errors = require('../lib/errors');
const { audit } = require('../lib/audit');
const { SCOPES } = require('./v1');

router.use(authenticate, requireDeveloper);

// ---------- AI ----------
const aiView = async () => { const c = await platform.ai(); const key = c.api_key_enc ? secrets.decrypt(c.api_key_enc) : ''; const { api_key_enc, ...rest } = c; return { ...rest, key_set: !!key || !!process.env.GROQ_API_KEY, key_mask: key ? secrets.mask(key) : process.env.GROQ_API_KEY ? 'from server environment (GROQ_API_KEY)' : '', key_unreadable: !!c.api_key_enc && !key }; };
router.get('/ai', wrap(async (req, res) => res.json(await aiView())));
router.put('/ai', wrap(async (req, res) => {
  const cur = await platform.ai(); const b = req.body || {}; const n = { ...cur };
  if (b.enabled !== undefined) n.enabled = !!b.enabled;
  if (b.model !== undefined) { n.model = clip(b.model, 80); if (!n.model) throw bad('Enter the model name'); }
  if (b.base_url !== undefined) { n.base_url = clip(b.base_url, 200).replace(/\/$/, ''); if (!(/^https:\/\//.test(n.base_url) || (process.env.ALLOW_PRIVATE_WEBHOOKS === 'true' && /^http:\/\//.test(n.base_url)))) throw bad('The API address must start with https://'); }
  if (b.temperature !== undefined) n.temperature = Math.min(1.5, Math.max(0, Number(b.temperature) || 0));
  if (b.max_tokens !== undefined) n.max_tokens = Math.min(8000, Math.max(200, int(b.max_tokens, 1800)));
  if (b.max_rounds !== undefined) n.max_rounds = Math.min(10, Math.max(1, int(b.max_rounds, 6)));
  if (b.reasoning_effort !== undefined) n.reasoning_effort = ['', 'low', 'medium', 'high'].includes(b.reasoning_effort) ? b.reasoning_effort : 'low';
  if (b.daily_limit_per_business !== undefined) n.daily_limit_per_business = Math.min(100000, Math.max(1, int(b.daily_limit_per_business, 200)));
  if (b.per_user_per_minute !== undefined) n.per_user_per_minute = Math.min(60, Math.max(1, int(b.per_user_per_minute, 6)));
  if (b.extra_instructions !== undefined) n.extra_instructions = clip(b.extra_instructions, 1000);
  if (b.api_key) { const k = String(b.api_key).trim(); if (k.length < 20 || /\s/.test(k)) throw bad('That does not look like a valid API key'); n.api_key_enc = secrets.encrypt(k); }
  if (b.clear_key === true) n.api_key_enc = '';
  await platform.set('ai', n);
  await audit(req, { business_id: null, action: 'platform.ai', details: { enabled: n.enabled, model: n.model, key_changed: !!b.api_key, key_cleared: b.clear_key === true } });
  res.json(await aiView());
}));
router.post('/ai/test', wrap(async (req, res) => {
  const c = await ai.config(); if (!c.key) throw bad('Save an API key first');
  const t = Date.now();
  try {
    const r = await fetch(c.base_url + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key }, body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_completion_tokens: 200, ...(/gpt-oss/i.test(c.model) ? { reasoning_effort: 'low' } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ ok: false, status: r.status, ms: Date.now() - t, message: (d.error && d.error.message) || 'The provider rejected the request' });
    res.json({ ok: true, ms: Date.now() - t, model: d.model || c.model, reply: String(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').slice(0, 80), tokens: d.usage && d.usage.total_tokens });
  } catch (e) { res.json({ ok: false, ms: Date.now() - t, message: 'Could not reach the AI provider: ' + e.message }); }
}));
router.get('/ai/usage', wrap(async (req, res) => {
  const tot = async h => one("SELECT COUNT(*) AS calls, COALESCE(SUM(status='error'),0) AS errors, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens, COALESCE(ROUND(AVG(latency_ms)),0) AS avg_ms FROM ai_usage WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)", [h]);
  res.json({ last_24h: await tot(24), last_7d: await tot(168), last_30d: await tot(720),
    per_business: await q("SELECT b.short_name AS business, COUNT(*) AS calls, SUM(u.status='error') AS errors, SUM(u.prompt_tokens+u.completion_tokens) AS tokens FROM ai_usage u LEFT JOIN businesses b ON b.id=u.business_id WHERE u.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) GROUP BY u.business_id,b.short_name ORDER BY calls DESC"),
    recent: await q("SELECT u.id,u.created_at,b.short_name AS business,us.name AS user_name,u.kind,u.model,u.question,u.tool_calls,u.latency_ms,u.status,u.error,u.prompt_tokens+u.completion_tokens AS tokens FROM ai_usage u LEFT JOIN businesses b ON b.id=u.business_id LEFT JOIN users us ON us.id=u.user_id ORDER BY u.id DESC LIMIT 60") });
}));

// ---------- feature modules ----------
router.get('/modules', wrap(async (req, res) => {
  const bs = await q('SELECT id,name,short_name,template,settings,status FROM businesses ORDER BY id');
  res.json({ modules: modules.MODULES, businesses: bs.map(b => ({ id: b.id, name: b.name, short_name: b.short_name, status: b.status, enabled: modules.state({ settings: safeJSON(b.settings, {}) }) })) });
}));
router.put('/businesses/:id/modules', wrap(async (req, res) => {
  const b = await one('SELECT * FROM businesses WHERE id=?', [req.params.id]); if (!b) throw notFound('Business not found');
  const s = safeJSON(b.settings, {}); s.modules = { ...modules.state({ settings: s }), ...modules.clean(req.body.modules) };
  await q('UPDATE businesses SET settings=? WHERE id=?', [JSON.stringify(s), b.id]);
  await audit(req, { business_id: b.id, action: 'business.modules', entity: 'business', entity_id: b.id, details: s.modules });
  require('../lib/realtime').broadcast(b.id, 'settings.changed', {});
  res.json({ enabled: s.modules });
}));

// ---------- public API policy & keys ----------
router.get('/api-policy', wrap(async (req, res) => res.json({ policy: await platform.api(), scopes: SCOPES })));
router.put('/api-policy', wrap(async (req, res) => {
  const b = req.body || {}; const p = await platform.api();
  const n = { enabled: b.enabled !== undefined ? !!b.enabled : p.enabled, default_rate_limit: Math.min(1000, Math.max(10, int(b.default_rate_limit, p.default_rate_limit))), max_keys_per_business: Math.min(100, Math.max(1, int(b.max_keys_per_business, p.max_keys_per_business))), max_webhooks_per_business: Math.min(50, Math.max(0, int(b.max_webhooks_per_business, p.max_webhooks_per_business))) };
  await platform.set('api_policy', n); await audit(req, { business_id: null, action: 'platform.api_policy', details: n }); res.json(n);
}));
router.get('/api-keys', wrap(async (req, res) => {
  const rows = await q(`SELECT k.id,k.business_id,b.short_name AS business,k.name,k.key_prefix,k.scopes,k.allowed_origins,k.rate_limit,k.status,k.expires_at,k.last_used_at,k.request_count,k.created_at,
    (SELECT COUNT(*) FROM api_request_log l WHERE l.key_id=k.id AND l.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS requests_24h,
    (SELECT COUNT(*) FROM api_request_log l WHERE l.key_id=k.id AND l.status>=400 AND l.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS errors_24h FROM api_keys k JOIN businesses b ON b.id=k.business_id ORDER BY k.id DESC`);
  rows.forEach(r => { r.scopes = safeJSON(r.scopes, []); r.allowed_origins = safeJSON(r.allowed_origins, []); });
  const hooks = await q("SELECT w.id,b.short_name AS business,w.url,w.events,w.status,w.last_status,w.failure_count FROM webhooks w JOIN businesses b ON b.id=w.business_id ORDER BY w.id DESC"); hooks.forEach(h => { h.events = safeJSON(h.events, []); });
  res.json({ keys: rows, webhooks: hooks });
}));
router.put('/api-keys/:id', wrap(async (req, res) => { const r = await q('UPDATE api_keys SET rate_limit=?, status=? WHERE id=?', [Math.min(1000, Math.max(10, int(req.body.rate_limit, 120))), req.body.status === 'revoked' ? 'revoked' : 'active', req.params.id]); if (!r.affectedRows) throw notFound('Key not found'); await audit(req, { business_id: null, action: 'platform.apikey', entity: 'apikey', entity_id: int(req.params.id), details: { status: req.body.status, rate_limit: req.body.rate_limit } }); res.json({ ok: true }); }));
router.put('/webhooks/:id', wrap(async (req, res) => { await q('UPDATE webhooks SET status=? WHERE id=?', [req.body.status === 'disabled' ? 'disabled' : 'active', req.params.id]); res.json({ ok: true }); }));

// ---------- branch groups ----------
router.get('/groups', wrap(async (req, res) => { const gs = await q('SELECT * FROM business_groups ORDER BY name'); const bs = await q('SELECT id,short_name,group_id FROM businesses'); res.json({ groups: gs.map(g => ({ ...g, businesses: bs.filter(b => b.group_id === g.id) })), businesses: bs }); }));
router.post('/groups', wrap(async (req, res) => { const name = clip(req.body.name, 120); if (name.length < 2) throw bad('Enter the group name'); const r = await q('INSERT INTO business_groups (name) VALUES (?)', [name]); await audit(req, { business_id: null, action: 'group.create', details: { name } }); res.json({ id: r.insertId }); }));
router.put('/businesses/:id/group', wrap(async (req, res) => { const gid = req.body.group_id ? int(req.body.group_id) : null; if (gid && !(await one('SELECT id FROM business_groups WHERE id=?', [gid]))) throw bad('Unknown group'); await q('UPDATE businesses SET group_id=? WHERE id=?', [gid, req.params.id]); await audit(req, { business_id: int(req.params.id), action: 'business.group', details: { group_id: gid } }); res.json({ ok: true }); }));
router.delete('/groups/:id', wrap(async (req, res) => { await q('UPDATE businesses SET group_id=NULL WHERE group_id=?', [req.params.id]); await q('DELETE FROM business_groups WHERE id=?', [req.params.id]); res.json({ ok: true }); }));

// ---------- system monitor, maintenance ----------
router.get('/system', wrap(async (req, res) => {
  const t0 = Date.now(); await one('SELECT 1'); const dbMs = Date.now() - t0; const mu = process.memoryUsage();
  const counts = await one(`SELECT (SELECT COUNT(*) FROM businesses) AS businesses,(SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM sales) AS sales,(SELECT COUNT(*) FROM products) AS products,(SELECT COUNT(*) FROM customers) AS customers,
    (SELECT COUNT(*) FROM sessions WHERE revoked=0 AND last_seen > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)) AS active_sessions,(SELECT COUNT(*) FROM api_request_log WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS api_requests_24h,
    (SELECT COUNT(*) FROM ai_usage WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS ai_calls_24h,(SELECT COUNT(*) FROM login_history WHERE success=0 AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS failed_logins_24h`);
  const mailer = require('../config/mailer'); const cl = require('../lib/cloudinary');
  res.json({ server: { uptime_s: Math.round(process.uptime()), node: process.version, env: process.env.NODE_ENV || 'development', rss_mb: Math.round(mu.rss / 1048576), heap_mb: Math.round(mu.heapUsed / 1048576), db_latency_ms: dbMs }, counts,
    services: { email: mailer.configured(), images: cl.configured(), payments: require('../lib/billing').configured(), ai: (await ai.config()).usable, jwt_secret_ok: !!process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 24 }, scheduler: require('../lib/scheduler').status(), errors: { total_5xx: errors.stats.requests5xx, recent: errors.recent().slice(0, 25) }, platform: await platform.platform(), backup: { settings: await platform.backup(), files: backup.list().slice(0, 5) } });
}));
router.get('/platform', wrap(async (req, res) => res.json(await platform.platform())));
router.put('/platform', wrap(async (req, res) => { const p = await platform.platform(); if (req.body.default_language !== undefined && !['en', 'sw'].includes(req.body.default_language)) throw bad('Choose English or Swahili'); const n = { ...p, maintenance: req.body.maintenance !== undefined ? !!req.body.maintenance : p.maintenance, maintenance_message: req.body.maintenance_message !== undefined ? clip(req.body.maintenance_message, 300) : p.maintenance_message, default_language: req.body.default_language !== undefined ? req.body.default_language : (p.default_language || 'en') }; await platform.set('platform', n); await audit(req, { business_id: null, action: 'platform.maintenance', details: n }); res.json(n); }));

// ---------- backups ----------
router.get('/backups', wrap(async (req, res) => res.json({ settings: await platform.backup(), files: backup.list() })));
router.put('/backups/settings', wrap(async (req, res) => { const n = { enabled: !!req.body.enabled, hour: Math.min(23, Math.max(0, int(req.body.hour, 2))), keep: Math.min(60, Math.max(1, int(req.body.keep, 7))) }; await platform.set('backup', n); await audit(req, { business_id: null, action: 'platform.backup_settings', details: n }); res.json(n); }));
router.post('/backups/run', wrap(async (req, res) => { const r = await backup.run(); backup.prune((await platform.backup()).keep); await audit(req, { business_id: null, action: 'platform.backup', details: r }); res.json(r); }));
router.get('/backups/:name', wrap(async (req, res) => { const f = backup.resolve(req.params.name); if (!f || !fs.existsSync(f)) throw notFound('Backup not found'); await audit(req, { business_id: null, action: 'platform.backup_download', details: { name: req.params.name } }); res.download(f); }));
router.delete('/backups/:name', wrap(async (req, res) => { backup.remove(req.params.name); await audit(req, { business_id: null, action: 'platform.backup_delete', details: { name: req.params.name } }); res.json({ ok: true }); }));

// ---------- accounts & security ----------
router.post('/users/:id/revoke-sessions', wrap(async (req, res) => { const r = await q('UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0', [req.params.id]); await audit(req, { business_id: null, action: 'user.revoke_sessions', entity: 'user', entity_id: int(req.params.id), details: { count: r.affectedRows } }); res.json({ revoked: r.affectedRows }); }));
router.get('/users/:id/logins', wrap(async (req, res) => res.json({ history: await q('SELECT success,ip,user_agent,note,created_at FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 50', [req.params.id]), sessions: await q('SELECT id,ip,device,created_at,last_seen,revoked FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [req.params.id]) })));
router.get('/security', wrap(async (req, res) => res.json({ failed: await q("SELECT email,ip,note,created_at FROM login_history WHERE success=0 ORDER BY id DESC LIMIT 40"), recent_ok: await q("SELECT u.name,u.email,h.ip,h.user_agent,h.created_at FROM login_history h JOIN users u ON u.id=h.user_id WHERE h.success=1 ORDER BY h.id DESC LIMIT 40") })));

// ---------- per-business deep look ----------
router.get('/businesses/:id/stats', wrap(async (req, res) => {
  const id = int(req.params.id); const b = await one('SELECT id,name FROM businesses WHERE id=?', [id]); if (!b) throw notFound('Business not found');
  const s = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE business_id=? AND sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS sales_30d,
    (SELECT COUNT(DISTINCT m.user_id) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? AND u.last_login > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) AS active_users_7d,
    (SELECT MAX(sold_at) FROM sales WHERE business_id=?) AS last_sale, (SELECT COUNT(*) FROM customers WHERE business_id=?) AS customers, (SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers,
    (SELECT COUNT(*) FROM api_request_log WHERE business_id=? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS api_24h, (SELECT COUNT(*) FROM ai_usage WHERE business_id=? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS ai_24h,
    (SELECT COUNT(*) FROM notifications WHERE business_id=? AND is_read=0) AS unread_alerts`, Array(8).fill(id));
  res.json(s);
}));

module.exports = router;
