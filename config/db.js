require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 12,
  decimalNumbers: true,   // DECIMAL columns come back as numbers
  timezone: 'Z',          // all DATETIMEs are stored/read as UTC
  dateStrings: ['DATE'],  // DATE columns stay 'YYYY-MM-DD' (Africa/Dar_es_Salaam calendar dates)
  charset: 'utf8mb4'
});

const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

/** Run fn(conn) inside a transaction. conn.query returns [rows]. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, q, one, tx };
