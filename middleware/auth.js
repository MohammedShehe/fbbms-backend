const jwt = require('jsonwebtoken');
const { one } = require('../config/db');
const { HttpError, forbidden, safeJSON } = require('../lib/util');
const { ALL_KEYS } = require('../lib/permissions');

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign({ uid: user.id, t: 'session' }, secret(), { expiresIn: '12h' });
}

/** Verifies Bearer token (or ?token= for SSE) and loads the active user. */
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

module.exports = { signToken, authenticate, tenant, can, canAny, requireSuper, requireDeveloper, has };
