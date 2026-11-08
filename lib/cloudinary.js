// Cloudinary uploads over the REST API (no extra npm package needed; uses Node's built-in fetch).
// Configure with CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME   -or-   the three CLOUDINARY_* variables.
const crypto = require('crypto');

function creds() {
  let cloud = process.env.CLOUDINARY_CLOUD_NAME, key = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  const u = process.env.CLOUDINARY_URL && /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(process.env.CLOUDINARY_URL.trim());
  if (u) { key = key || u[1]; secret = secret || u[2]; cloud = cloud || u[3]; }
  return cloud && key && secret ? { cloud, key, secret } : null;
}
const configured = () => !!creds();

/** Uploads a data-URI image; returns { url, public_id }. */
async function uploadImage(dataUri, folder) {
  const c = creds(); if (!c) { const e = new Error('Image storage (Cloudinary) is not configured on the server'); e.status = 503; throw e; }
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp, overwrite: 'false' }; // every key that is sent (except file/api_key/signature) must be signed
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + c.secret).digest('hex');
  const form = new FormData();
  form.append('file', dataUri); Object.entries(params).forEach(([k, v]) => form.append(k, String(v)));
  form.append('api_key', c.key); form.append('signature', signature);
  let res; try { res = await fetch(`https://api.cloudinary.com/v1_1/${c.cloud}/image/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) }); }
  catch { const e = new Error('Could not reach the image service. Try again.'); e.status = 502; throw e; }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Cloudinary error:', d.error && d.error.message); const e = new Error('Image upload failed' + (d.error && /signature|api_key|cloud/i.test(d.error.message) ? ' (check the Cloudinary credentials on the server)' : '')); e.status = 502; throw e; }
  return { url: d.secure_url, public_id: d.public_id };
}

/** Deletes an uploaded image (best effort — callers should not fail a request because clean-up failed). */
async function destroyImage(publicId) {
  const c = creds(); if (!c || !publicId) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { invalidate: 'true', public_id: publicId, timestamp };
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + c.secret).digest('hex');
  const form = new FormData();
  Object.entries(params).forEach(([k, v]) => form.append(k, String(v))); form.append('api_key', c.key); form.append('signature', signature);
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${c.cloud}/image/destroy`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
    const d = await res.json().catch(() => ({}));
    return res.ok && (d.result === 'ok' || d.result === 'not found');
  } catch (e) { console.error('Cloudinary destroy failed:', e.message); return false; }
}

/** Cloudinary public_id of an image we uploaded (fbbms/<slug>/...) taken from its URL, or null for anything else. */
function publicIdFromUrl(url) {
  const m = /\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(fbbms\/[A-Za-z0-9_\-/]+)\.[A-Za-z0-9]+(?:\?.*)?$/.exec(String(url || ''));
  return m ? m[1] : null;
}

module.exports = { uploadImage, destroyImage, configured, publicIdFromUrl };
