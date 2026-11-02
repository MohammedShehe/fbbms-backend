// API keys and webhooks, managed by the business's Super Admin (module: public_api).
const router = require('express').Router();
const crypto = require('crypto');
const { q, one } = require('../config/db');
const { requireSuper, requireModule } = require('../middleware/auth');
const { bad, notFound, wrap, clip, int, safeJSON } = require('../lib/util');
const { sha256 } = require('../lib/secrets');
const platform = require('../lib/platform');
const hooks = require('../lib/webhooks');
const { SCOPES } = require('./v1');
const { audit } = require('../lib/audit');

const gate = [requireModule('public_api'), requireSuper];
const cleanScopes = a => [...new Set((Array.isArray(a) ? a : []).filter(s => SCOPES[s]))];
const cleanOrigins = a => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,]+/)).map(s => String(s).trim().replace(/\/$/, '')).filter(Boolean))].map(o => { try { const u = new URL(o); return u.origin; } catch { throw bad(`"${o}" is not a valid website address (use https://example.com)`); } }).slice(0, 10);

router.get('/integrations/meta', gate, wrap(async (req, res) => res.json({ scopes: SCOPES, events: hooks.EVENTS, policy: await platform.api() })));

router.get('/integrations/keys', gate, wrap(async (req, res) => {
  const rows = await q(`SELECT k.id,k.name,k.key_prefix,k.scopes,k.allowed_origins,k.rate_limit,k.status,k.expires_at,k.last_used_at,k.request_count,k.created_at,
    (SELECT COUNT(*) FROM api_request_log l WHERE l.key_id=k.id AND l.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS requests_24h,
    (SELECT COUNT(*) FROM api_request_log l WHERE l.key_id=k.id AND l.status>=400 AND l.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)) AS errors_24h FROM api_keys k WHERE k.business_id=? ORDER BY k.id DESC`, [req.biz.id]);
  rows.forEach(r => { r.scopes = safeJSON(r.scopes, []); r.allowed_origins = safeJSON(r.allowed_origins, []); }); res.json(rows);
}));

router.post('/integrations/keys', gate, wrap(async (req, res) => {
  const pol = await platform.api(); const name = clip(req.body.name, 100); if (name.length < 2) throw bad('Name the key (e.g. "Main website")');
  const scopes = cleanScopes(req.body.scopes); if (!scopes.length) throw bad('Choose what this key may do');
  const n = (await one("SELECT COUNT(*) AS n FROM api_keys WHERE business_id=? AND status='active'", [req.biz.id])).n; if (n >= pol.max_keys_per_business) throw bad(`You can have at most ${pol.max_keys_per_business} active keys. Revoke one first.`);
  const rate = Math.min(1000, Math.max(10, int(req.body.rate_limit, pol.default_rate_limit))); const origins = cleanOrigins(req.body.allowed_origins);
  const days = int(req.body.expires_in_days, 0);
  const secret = 'fbk_live_' + crypto.randomBytes(24).toString('hex');
  const r = await q('INSERT INTO api_keys (business_id,name,key_prefix,key_hash,scopes,allowed_origins,rate_limit,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)', [req.biz.id, name, secret.slice(0, 16), sha256(secret), JSON.stringify(scopes), JSON.stringify(origins), rate, days > 0 ? new Date(Date.now() + days * 86400000) : null, req.user.id]);
  await audit(req, { action: 'apikey.create', entity: 'apikey', entity_id: r.insertId, details: { name, scopes } });
  res.json({ id: r.insertId, api_key: secret, note: 'Copy this key now. For your security it is never shown again.' });
}));
router.put('/integrations/keys/:id', gate, wrap(async (req, res) => {
  const k = await one('SELECT * FROM api_keys WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); if (!k) throw notFound('Key not found');
  const scopes = req.body.scopes ? cleanScopes(req.body.scopes) : safeJSON(k.scopes, []); if (!scopes.length) throw bad('Choose what this key may do');
  await q('UPDATE api_keys SET name=?, scopes=?, allowed_origins=?, rate_limit=? WHERE id=?', [clip(req.body.name, 100) || k.name, JSON.stringify(scopes), JSON.stringify(req.body.allowed_origins !== undefined ? cleanOrigins(req.body.allowed_origins) : safeJSON(k.allowed_origins, [])), Math.min(1000, Math.max(10, int(req.body.rate_limit, k.rate_limit))), k.id]);
  await audit(req, { action: 'apikey.update', entity: 'apikey', entity_id: k.id }); res.json({ ok: true });
}));
router.post('/integrations/keys/:id/revoke', gate, wrap(async (req, res) => {
  const r = await q("UPDATE api_keys SET status='revoked' WHERE id=? AND business_id=?", [req.params.id, req.biz.id]); if (!r.affectedRows) throw notFound('Key not found');
  await audit(req, { action: 'apikey.revoke', entity: 'apikey', entity_id: int(req.params.id) }); res.json({ ok: true });
}));
router.get('/integrations/keys/:id/log', gate, wrap(async (req, res) => {
  res.json(await q('SELECT l.method,l.path,l.status,l.ms,l.ip,l.created_at FROM api_request_log l JOIN api_keys k ON k.id=l.key_id WHERE k.id=? AND k.business_id=? ORDER BY l.id DESC LIMIT 50', [req.params.id, req.biz.id]));
}));

// ---- webhooks ----
const cleanEvents = a => [...new Set((Array.isArray(a) ? a : []).filter(e => hooks.EVENTS.includes(e)))];
router.get('/integrations/webhooks', gate, wrap(async (req, res) => { const rows = await q('SELECT id,url,events,status,last_status,last_attempt_at,failure_count,created_at FROM webhooks WHERE business_id=? ORDER BY id DESC', [req.biz.id]); rows.forEach(r => { r.events = safeJSON(r.events, []); }); res.json(rows); }));
router.post('/integrations/webhooks', gate, wrap(async (req, res) => {
  const pol = await platform.api(); const n = (await one('SELECT COUNT(*) AS n FROM webhooks WHERE business_id=?', [req.biz.id])).n; if (n >= pol.max_webhooks_per_business) throw bad(`At most ${pol.max_webhooks_per_business} webhooks are allowed.`);
  const url = await hooks.assertPublicUrl(clip(req.body.url, 400)); const events = cleanEvents(req.body.events); if (!events.length) throw bad('Choose at least one event');
  const secret = 'whsec_' + crypto.randomBytes(20).toString('hex');
  const r = await q('INSERT INTO webhooks (business_id,url,secret,events,created_by) VALUES (?,?,?,?,?)', [req.biz.id, url, secret, JSON.stringify(events), req.user.id]);
  await audit(req, { action: 'webhook.create', entity: 'webhook', entity_id: r.insertId, details: { url, events } });
  res.json({ id: r.insertId, secret, note: 'Use this secret to verify the X-FBBMS-Signature header. It is shown only once.' });
}));
router.put('/integrations/webhooks/:id', gate, wrap(async (req, res) => {
  const h = await one('SELECT * FROM webhooks WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); if (!h) throw notFound('Webhook not found');
  const url = req.body.url ? await hooks.assertPublicUrl(clip(req.body.url, 400)) : h.url; const events = req.body.events ? cleanEvents(req.body.events) : safeJSON(h.events, []); if (!events.length) throw bad('Choose at least one event');
  await q('UPDATE webhooks SET url=?, events=?, status=?, failure_count=IF(?="active",0,failure_count) WHERE id=?', [url, JSON.stringify(events), req.body.status === 'disabled' ? 'disabled' : 'active', req.body.status === 'disabled' ? 'disabled' : 'active', h.id]); res.json({ ok: true });
}));
router.delete('/integrations/webhooks/:id', gate, wrap(async (req, res) => { await q('DELETE FROM webhooks WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); res.json({ ok: true }); }));
router.post('/integrations/webhooks/:id/test', gate, wrap(async (req, res) => {
  const h = await one('SELECT * FROM webhooks WHERE id=? AND business_id=?', [req.params.id, req.biz.id]); if (!h) throw notFound('Webhook not found');
  res.json(await hooks.deliver(h, 'ping', { message: 'Test event from FBBMS', business: req.biz.slug }, 3));
}));
module.exports = router;
