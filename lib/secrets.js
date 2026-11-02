// Encrypts secrets (e.g. the AI API key) before they are stored in the database. AES-256-GCM, key derived from the server secret.
const crypto = require('crypto');
const key = () => crypto.createHash('sha256').update('fbbms-secret-store:' + (process.env.SETTINGS_KEY || process.env.JWT_SECRET || 'dev-secret-change-me')).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(blob) {
  try {
    const [v, iv, tag, ct] = String(blob || '').split(':'); if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
const mask = k => !k ? '' : k.length <= 10 ? '••••' : k.slice(0, 4) + '••••••••' + k.slice(-4);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
module.exports = { encrypt, decrypt, mask, sha256, randomToken };
