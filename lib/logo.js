// Business logo storage. The logo lives in businesses.theme (JSON): logo_url, logo_public_id, logo_updated_at.
// Files are stored on Cloudinary under fbbms/<slug>/logo; the previous file is removed when it is replaced or deleted.
const { q, one } = require('../config/db');
const { uploadImage, destroyImage } = require('./cloudinary');
const { bad, safeJSON } = require('./util');

const MAX_BYTES = 2 * 1024 * 1024;
const LOGO_KEYS = ['logo_url', 'logo_public_id', 'logo_updated_at'];
const OWN_ID = /^fbbms\/[a-z0-9_-]+\/logo\/[A-Za-z0-9_-]+$/; // we only ever delete files that we created in a logo folder

/** Removes logo fields from a theme object that came from a request body (the logo is only changed through the logo endpoints). */
const stripLogo = t => { const o = { ...(t && typeof t === 'object' ? t : {}) }; LOGO_KEYS.forEach(k => delete o[k]); return o; };

/** Validates a data-URL image (JPEG/PNG/WebP, real file signature, size limit). Returns the same string. */
function checkImage(data) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) throw bad('Upload a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100) throw bad('That file is not a valid image');
  if (buf.length > MAX_BYTES) throw bad('Logo is too large (max 2 MB)');
  const sig = buf.slice(0, 12).toString('hex');
  const okSig = (m[1] === 'image/jpeg' && sig.startsWith('ffd8ff')) || (m[1] === 'image/png' && sig.startsWith('89504e47')) || (m[1] === 'image/webp' && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
  if (!okSig) throw bad('That file is not a valid image');
  return String(data);
}

const readTheme = async id => { const r = await one('SELECT theme FROM businesses WHERE id=?', [id]); return safeJSON(r && r.theme, {}); };

/** Uploads the new logo, saves it on the business and then deletes the previous file. Returns { logo_url, public_id }. */
async function setLogo(biz, data) {
  checkImage(data);
  const up = await uploadImage(data, `fbbms/${biz.slug}/logo`);
  const theme = await readTheme(biz.id); const old = theme.logo_public_id;
  theme.logo_url = up.url; theme.logo_public_id = up.public_id; theme.logo_updated_at = new Date().toISOString();
  try { await q('UPDATE businesses SET theme=? WHERE id=?', [JSON.stringify(theme), biz.id]); }
  catch (e) { destroyImage(up.public_id).catch(() => {}); throw e; }
  if (old && old !== up.public_id && OWN_ID.test(old)) destroyImage(old).catch(() => {});
  return { logo_url: up.url, public_id: up.public_id };
}

/** Removes the custom logo (the app falls back to the default mark). */
async function clearLogo(biz) {
  const theme = await readTheme(biz.id); const old = theme.logo_public_id; const had = !!theme.logo_url;
  LOGO_KEYS.forEach(k => delete theme[k]);
  await q('UPDATE businesses SET theme=? WHERE id=?', [JSON.stringify(theme), biz.id]);
  if (old && OWN_ID.test(old)) destroyImage(old).catch(() => {});
  return { had };
}

module.exports = { setLogo, clearLogo, stripLogo, checkImage, MAX_BYTES, LOGO_KEYS };
