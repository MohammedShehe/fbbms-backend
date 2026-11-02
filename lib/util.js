class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, extra) => new HttpError(400, m, extra);
const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m, extra) => new HttpError(409, m, extra);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EAT_MS = 3 * 3600 * 1000; // Africa/Dar_es_Salaam is UTC+3, no DST

/** 'YYYY-MM-DD' for a Date in East Africa Time */
function eatDate(d = new Date()) { return new Date(d.getTime() + EAT_MS).toISOString().slice(0, 10); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const startOfMonth = ds => ds.slice(0, 8) + '01';

const safeJSON = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const phoneOk = p => /^\+?[0-9][0-9\s-]{7,16}$/.test(String(p || '').trim());
const normPhone = p => String(p || '').replace(/[\s-]/g, '');
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const money = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? round2(n) : d; };

function genPassword(len = 12) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%';
  const bytes = require('crypto').randomBytes(len);
  return Array.from(bytes, b => c[b % c.length]).join('');
}

const unauthorized = (m = 'Please sign in') => new HttpError(401, m);
const tooMany = (m = 'Too many requests') => new HttpError(429, m);

module.exports = { unauthorized, tooMany, HttpError, bad, forbidden, notFound, conflict, wrap, round2, eatDate, addDays, isDate, startOfMonth, safeJSON, clip, phoneOk, normPhone, emailOk, slugify, int, money, genPassword };
