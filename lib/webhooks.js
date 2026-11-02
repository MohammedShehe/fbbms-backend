// Outgoing webhooks: signed JSON POSTs to the URLs a business registered. Retries, then disables a dead endpoint.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { q } = require('../config/db');
const { safeJSON } = require('./util');

const EVENTS = ['order.created', 'order.updated', 'sale.completed', 'stock.low'];

const privateIp = ip => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:'); }
  return true;
};
/** Refuses internal addresses so a webhook can never be pointed at the server's own network. */
async function assertPublicUrl(url) {
  let u; try { u = new URL(url); } catch { const e = new Error('Enter a valid URL'); e.status = 400; throw e; }
  const prod = process.env.NODE_ENV === 'production';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !prod)) { const e = new Error('Webhook URLs must start with https://'); e.status = 400; throw e; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) { const e = new Error('That host could not be resolved'); e.status = 400; throw e; }
  if (!(process.env.ALLOW_PRIVATE_WEBHOOKS === 'true') && addrs.some(a => privateIp(a.address))) { const e = new Error('Webhook URLs cannot point to private or local addresses'); e.status = 400; throw e; }
  return u.toString();
}

const sign = (secret, ts, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

async function deliver(hook, event, payload, attempt = 1) {
  const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(8).toString('hex'), event, created: new Date().toISOString(), data: payload });
  const ts = Math.floor(Date.now() / 1000);
  let status = 0;
  try {
    await assertPublicUrl(hook.url);
    const res = await fetch(hook.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'FBBMS-Webhook/1.0', 'X-FBBMS-Event': event, 'X-FBBMS-Timestamp': String(ts), 'X-FBBMS-Signature': sign(hook.secret, ts, body) }, body });
    status = res.status;
  } catch (e) { status = 0; }
  const ok = status >= 200 && status < 300;
  if (ok) await q('UPDATE webhooks SET last_status=?, last_attempt_at=UTC_TIMESTAMP(), failure_count=0 WHERE id=?', [status, hook.id]).catch(() => {});
  else {
    await q("UPDATE webhooks SET last_status=?, last_attempt_at=UTC_TIMESTAMP(), failure_count=failure_count+1, status=IF(failure_count>=12,'disabled',status) WHERE id=?", [status, hook.id]).catch(() => {});
    if (attempt < 3) setTimeout(() => deliver(hook, event, payload, attempt + 1), attempt === 1 ? 5000 : 30000).unref();
  }
  return { ok, status };
}

/** Fire-and-forget: tell every active hook of this business that subscribed to the event. */
function emit(bizId, event, payload) {
  q("SELECT * FROM webhooks WHERE business_id=? AND status='active'", [bizId]).then(rows => {
    rows.filter(h => safeJSON(h.events, []).includes(event)).forEach(h => deliver(h, event, payload).catch(() => {}));
  }).catch(() => {});
}

module.exports = { EVENTS, emit, deliver, assertPublicUrl, sign };
