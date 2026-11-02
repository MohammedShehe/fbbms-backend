// In-app notifications (stored, de-duplicated, pushed live) + optional e-mail to the business's Super Admins.
const { q, one } = require('../config/db');
const rt = require('./realtime');
const { safeJSON } = require('./util');
const modules = require('./modules');

async function notify(biz, { type, severity = 'info', audience = 'super', title, body = null, data = null, dedupe = null }) {
  try {
    if (!modules.enabled(biz, 'alerts')) return false;
    const r = await q('INSERT IGNORE INTO notifications (business_id,type,severity,audience,title,body,data,dedupe_key) VALUES (?,?,?,?,?,?,?,?)',
      [biz.id, type, severity, audience, String(title).slice(0, 160), body, data ? JSON.stringify(data) : null, dedupe]);
    if (!r.affectedRows) return false;
    rt.broadcast(biz.id, 'notification', { id: r.insertId, type, severity, audience, title, body });
    if (severity !== 'info' || type.endsWith('.summary')) emailSupers(biz, title, body).catch(() => {});
    return true;
  } catch (e) { console.error('notify failed:', e.message); return false; }
}

// E-mail only when the Super Admin turned it on (settings.notify_email) and SMTP exists. Never throws.
async function emailSupers(biz, subject, text) {
  const mailer = require('../config/mailer');
  if (process.env.DISABLE_EMAIL === 'true' || !mailer.configured() || !(biz.settings && biz.settings.notify_email)) return;
  const rows = await q("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? AND m.role='super_admin' AND m.status='active' AND u.status='active'", [biz.id]);
  for (const r of rows) await mailer.sendMail({ to: r.email, subject: `[${biz.short_name}] ${subject}`, text: String(text || subject) }).catch(e => console.error('mail failed:', e.message));
}

const forUser = (req) => (req.member.role === 'super_admin' ? ['all', 'super'] : ['all']);

module.exports = { notify, forUser, safeJSON };
