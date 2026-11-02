const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { one, q } = require('../config/db');
const { HttpError, forbidden, safeJSON } = require('../lib/util');
const { ALL_KEYS } = require('../lib/permissions');
const modules = require('../lib/modules');

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';

function deviceOf(ua = '') {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

/** Legacy token without a tracked session (kept so existing helpers keep working). */
function signToken(user) { return jwt.sign({ uid: user.id, t: 'session' }, secret(), { expiresIn: '12h' }); }

/** Creates a tracked session (device, IP, revocable) and returns the signed token. */
async function issueToken(user, req) {
  const sid = crypto.randomBytes(16).toString('hex');
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 255);
  await q('INSERT INTO sessions (id,user_id,ip,user_agent,device,last_seen) VALUES (?,?,?,?,?,UTC_TIMESTAMP())', [sid, user.id, String((req && req.ip) || '').slice(0, 60), ua, deviceOf(ua)]);
  return jwt.sign({ uid: user.id, t: 'session', sid }, secret(), { expiresIn: '12h' });
}

/** Verifies Bearer token (or ?token= for SSE), checks the session was not signed out remotely, loads the active user. */
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    if (!token) throw new HttpError(401, 'Please sign in');
    let payload;
    try { payload = jwt.verify(token, secret()); } catch { throw new HttpError(401, 'Session expired. Please sign in again.'); }
    if (payload.t !== 'session') throw new HttpError(401, 'Invalid session');
    const user = await one('SELECT id,name,email,phone,is_developer,status,must_change_password FROM users WHERE id=?', [payload.uid]);
    if (!user || user.status !== 'active') throw new HttpError(401, 'Account disabled');
    if (payload.sid) {
      const s = await one('SELECT revoked,last_seen FROM sessions WHERE id=? AND user_id=?', [payload.sid, user.id]);
      if (!s || s.revoked) throw new HttpError(401, 'You were signed out. Please sign in again.');
      if (!s.last_seen || Date.now() - new Date(s.last_seen).getTime() > 60000) q('UPDATE sessions SET last_seen=UTC_TIMESTAMP() WHERE id=?', [payload.sid]).catch(() => {});
      req.sessionId = payload.sid;
    }
    req.user = user;
    next();
  } catch (e) { next(e); }
}

/** Resolves the business from X-Business-Id (or ?b=) and the caller's rights in it. */
async function tenant(req, res, next) {
  try {
    const bid = parseInt(req.headers['x-business-id'] || req.query.b, 10);
    if (!bid) throw new HttpError(400, 'No business selected');
    const biz = await one('SELECT * FROM businesses WHERE id=?', [bid]);
    if (!biz) throw new HttpError(404, 'Business not found');
    if (req.user.is_developer) {
      req.member = { role: 'super_admin', permissions: new Set(ALL_KEYS), developer: true };
    } else {
      const m = await one('SELECT * FROM memberships WHERE user_id=? AND business_id=?', [req.user.id, bid]);
      if (!m || m.status !== 'active') throw forbidden('You do not have access to this business');
      if (biz.status !== 'active') throw forbidden('This business is currently suspended');
      req.member = { id: m.id, role: m.role, permissions: new Set(m.role === 'super_admin' ? ALL_KEYS : safeJSON(m.permissions, [])) };
    }
    if (!req.user.is_developer) { const plat = await require('../lib/platform').platform(); if (plat.maintenance) throw new HttpError(503, plat.maintenance_message); }
    biz.settings = safeJSON(biz.settings, {});
    biz.theme = safeJSON(biz.theme, {});
    req.biz = biz;
    next();
  } catch (e) { next(e); }
}

const can = perm => (req, res, next) => req.member.permissions.has(perm) ? next() : next(forbidden());
const canAny = (...perms) => (req, res, next) => perms.some(p => req.member.permissions.has(p)) ? next() : next(forbidden());
const requireSuper = (req, res, next) => req.member.role === 'super_admin' ? next() : next(forbidden('Super Admin only'));
const requireDeveloper = (req, res, next) => req.user.is_developer ? next() : next(forbidden('Developer only'));
const has = (req, perm) => req.member.permissions.has(perm);
/** Blocks a route when the Developer has not enabled that module for this business. */
const requireModule = key => (req, res, next) => modules.enabled(req.biz, key) ? next() : next(forbidden('This feature is not enabled for your business. Ask the platform Developer to switch it on.'));

module.exports = { signToken, issueToken, deviceOf, authenticate, tenant, can, canAny, requireSuper, requireDeveloper, has, requireModule };
