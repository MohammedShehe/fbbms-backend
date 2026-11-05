// Public endpoint Snippe calls when a payment completes or fails. Mounted with a RAW body so the signature can be checked.
const crypto = require('crypto');
const { one, q } = require('../config/db');
const billing = require('../lib/billing');

const safeEq = (a, b) => { try { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch { return false; } };

/** Accepts "sha256=<hex>" over the raw body, or an HMAC over "<timestamp>.<body>" (header formats differ between API versions). */
function signatureValid(raw, headers, secret) {
  if (!secret) return false;
  const h = String(headers['x-snippe-signature'] || headers['x-webhook-signature'] || headers['x-signature'] || ''); if (!h) return false;
  const parts = h.split(',').map(s => s.trim()); const got = (parts.find(s => /^(v1|sha256|signature)=/.test(s)) || parts[parts.length - 1]).replace(/^(v1|sha256|signature)=/, '').trim();
  const t = headers['x-snippe-timestamp'] || headers['x-webhook-timestamp'] || headers['x-timestamp'] || (h.match(/t=(\d+)/) || [])[1];
  const hmac = s => crypto.createHmac('sha256', secret).update(s).digest('hex');
  const body = raw.toString('utf8');
  return safeEq(hmac(body), got) || (t && safeEq(hmac(`${t}.${body}`), got));
}

module.exports = async function handler(req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }
    const data = body.data || body; const ref = data.reference || body.reference || (data.payment && data.payment.reference);
    const status = String(data.status || '').toLowerCase(); const meta = data.metadata || body.metadata || {};
    let pay = ref ? await one('SELECT * FROM billing_payments WHERE provider_ref=?', [String(ref)]) : null;
    if (!pay && meta.payment_id) { pay = await one("SELECT * FROM billing_payments WHERE id=? AND provider='snippe'", [Number(meta.payment_id) || 0]); if (pay && !pay.provider_ref && ref) { await q('UPDATE billing_payments SET provider_ref=? WHERE id=?', [String(ref), pay.id]); pay.provider_ref = String(ref); } }
    if (!pay) return res.status(200).json({ ok: true, ignored: true });
    const trusted = signatureValid(raw, req.headers, process.env.SNIPPE_WEBHOOK_SECRET);
    if (process.env.SNIPPE_WEBHOOK_SECRET && !trusted) console.warn('billing webhook: signature did not match (verifying with the Snippe API instead)');
    // The payment is always re-checked with Snippe, so a forged webhook can never grant access.
    await billing.reconcile(pay.id, { status, trusted });
    res.status(200).json({ ok: true });
  } catch (e) { console.error('billing webhook error:', e.message); res.status(200).json({ ok: true }); }
};
