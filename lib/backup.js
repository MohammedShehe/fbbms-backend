// Logical database backups (gzip SQL) written to BACKUP_DIR (default ./backups). No mysqldump needed.
const fs = require('fs'); const path = require('path'); const zlib = require('zlib'); const mysql = require('mysql2');
const { q } = require('../config/db');

const dir = () => { const d = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups')); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const SKIP = new Set(['otp_codes', 'sessions', 'api_request_log', 'idempotency_keys']);
const NAME = /^fbbms-\d{8}-\d{6}\.sql\.gz$/;

async function run() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); const name = `fbbms-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.sql.gz`;
  const file = path.join(dir(), name); const gz = zlib.createGzip(); const out = fs.createWriteStream(file, { mode: 0o600 }); gz.pipe(out);
  const write = s => new Promise(r => { if (!gz.write(s)) gz.once('drain', r); else r(); });
  await write(`-- FBBMS backup ${new Date().toISOString()}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n`);
  const tables = (await q('SHOW TABLES')).map(r => Object.values(r)[0]).filter(t => !SKIP.has(t));
  let rowsTotal = 0;
  for (const t of tables) {
    const [c] = await q(`SHOW CREATE TABLE \`${t}\``); await write(`DROP TABLE IF EXISTS \`${t}\`;\n${c['Create Table']};\n\n`);
    for (let off = 0; ; off += 500) {
      const rows = await q(`SELECT * FROM \`${t}\` LIMIT 500 OFFSET ${off}`); if (!rows.length) break;
      const cols = Object.keys(rows[0]).map(k => `\`${k}\``).join(',');
      await write(`INSERT INTO \`${t}\` (${cols}) VALUES\n${rows.map(r => '(' + Object.values(r).map(v => mysql.escape(v)).join(',') + ')').join(',\n')};\n`); rowsTotal += rows.length;
    }
    await write('\n');
  }
  await write('SET FOREIGN_KEY_CHECKS=1;\n'); gz.end(); await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  return { name, tables: tables.length, rows: rowsTotal, size: fs.statSync(file).size };
}
function list() { return fs.readdirSync(dir()).filter(f => NAME.test(f)).sort().reverse().map(f => { const s = fs.statSync(path.join(dir(), f)); return { name: f, size: s.size, created_at: s.mtime.toISOString() }; }); }
const resolve = name => NAME.test(String(name)) ? path.join(dir(), name) : null;
function prune(keep) { list().slice(Math.max(1, keep)).forEach(f => { try { fs.unlinkSync(path.join(dir(), f.name)); } catch (_) { /* ignore */ } }); }
module.exports = { run, list, resolve, prune, remove: n => { const f = resolve(n); if (f && fs.existsSync(f)) fs.unlinkSync(f); } };
