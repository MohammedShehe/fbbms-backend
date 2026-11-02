// Per-business time zone helpers (Africa/Dar_es_Salaam is the default so existing shops behave exactly as before).
const DEFAULT_TZ = 'Africa/Dar_es_Salaam';
const valid = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const bizTz = biz => { const t = biz && biz.settings && biz.settings.timezone; return t && valid(t) ? t : DEFAULT_TZ; };

function parts(d, tz) {
  const o = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return o;
}
/** 'YYYY-MM-DD' of a moment in the given zone */
const localDate = (d = new Date(), tz = DEFAULT_TZ) => { const p = parts(d, tz); return `${p.year}-${p.month}-${p.day}`; };
const localHour = (d = new Date(), tz = DEFAULT_TZ) => Number(parts(d, tz).hour) % 24;
const localDow = (d = new Date(), tz = DEFAULT_TZ) => new Date(localDate(d, tz) + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
/** zone offset from UTC in minutes at the given moment (used in SQL: DATE_ADD(col, INTERVAL ? MINUTE)) */
function offsetMinutes(tz = DEFAULT_TZ, d = new Date()) {
  const p = parts(d, tz); const asUtc = Date.UTC(p.year, Number(p.month) - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}
const today = biz => localDate(new Date(), bizTz(biz));
const offset = biz => offsetMinutes(bizTz(biz));
module.exports = { DEFAULT_TZ, valid, bizTz, localDate, localHour, localDow, offsetMinutes, today, offset };
