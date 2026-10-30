const { q } = require('../config/db');

/** Append-only audit trail. Never throws (auditing must not break a sale). */
async function audit(req, { business_id, action, entity = null, entity_id = null, details = null, conn = null }) {
  try {
    const biz = business_id !== undefined ? business_id : (req.biz ? req.biz.id : null);
    const params = [biz, req.user ? req.user.id : null, action, entity, entity_id, details ? JSON.stringify(details) : null, (req.ip || '').slice(0, 60)];
    const sql = 'INSERT INTO audit_log (business_id,user_id,action,entity,entity_id,details,ip) VALUES (?,?,?,?,?,?,?)';
    if (conn) await conn.query(sql, params); else await q(sql, params);
  } catch (e) { console.error('audit failed:', e.message); }
}
module.exports = { audit };
