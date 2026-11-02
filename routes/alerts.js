// Notification centre (module: alerts).
const router = require('express').Router();
const { q, one } = require('../config/db');
const { requireModule } = require('../middleware/auth');
const { wrap, int, safeJSON } = require('../lib/util');
const { forUser } = require('../lib/notify');

router.get('/notifications', requireModule('alerts'), wrap(async (req, res) => {
  const aud = forUser(req); const limit = Math.min(100, int(req.query.limit, 40));
  const rows = await q(`SELECT id,type,severity,title,body,data,is_read,created_at FROM notifications WHERE business_id=? AND audience IN (?) ${req.query.unread === '1' ? 'AND is_read=0' : ''} ORDER BY id DESC LIMIT ?`, [req.biz.id, aud, limit]);
  rows.forEach(r => { r.data = safeJSON(r.data, null); });
  const c = await one('SELECT COUNT(*) AS n FROM notifications WHERE business_id=? AND audience IN (?) AND is_read=0', [req.biz.id, aud]);
  res.json({ rows, unread: c.n });
}));
router.post('/notifications/read', requireModule('alerts'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(int).filter(Boolean) : null;
  await q(`UPDATE notifications SET is_read=1 WHERE business_id=? AND audience IN (?) ${ids ? 'AND id IN (?)' : ''}`, ids ? [req.biz.id, forUser(req), ids] : [req.biz.id, forUser(req)]);
  res.json({ ok: true });
}));
module.exports = router;
