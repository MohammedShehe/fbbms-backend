// Platform-wide settings stored in platform_settings (theme, AI, API policy, maintenance...). Small in-memory cache.
const { q, one } = require('../config/db');
const { safeJSON } = require('./util');
const cache = new Map();
async function get(k, fallback = {}) {
  const c = cache.get(k); if (c && Date.now() - c.at < 5000) return c.v;
  const r = await one('SELECT v FROM platform_settings WHERE k=?', [k]);
  const v = safeJSON(r && r.v, null); const out = v === null ? fallback : (typeof fallback === 'object' && !Array.isArray(fallback) && typeof v === 'object' ? { ...fallback, ...v } : v);
  cache.set(k, { v: out, at: Date.now() }); return out;
}
async function set(k, v) { await q('INSERT INTO platform_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, JSON.stringify(v)]); cache.delete(k); return v; }

const AI_DEFAULTS = { enabled: false, provider: 'groq', model: 'openai/gpt-oss-20b', base_url: 'https://api.groq.com/openai/v1', temperature: 0.2, max_tokens: 1800, max_rounds: 6, reasoning_effort: 'low', daily_limit_per_business: 200, per_user_per_minute: 6, extra_instructions: '', api_key_enc: '' };
const API_DEFAULTS = { enabled: true, default_rate_limit: 120, max_keys_per_business: 10, max_webhooks_per_business: 5 };
const PLATFORM_DEFAULTS = { maintenance: false, maintenance_message: 'FBBMS is being updated. Please try again in a few minutes.' };
const BACKUP_DEFAULTS = { enabled: false, hour: 2, keep: 7 };
module.exports = { get, set, AI_DEFAULTS, API_DEFAULTS, PLATFORM_DEFAULTS, BACKUP_DEFAULTS, ai: () => get('ai', AI_DEFAULTS), api: () => get('api_policy', API_DEFAULTS), platform: () => get('platform', PLATFORM_DEFAULTS), backup: () => get('backup', BACKUP_DEFAULTS) };
