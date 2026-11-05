// Creates / upgrades all FBBMS tables in the database named in .env. Safe to run repeatedly, on a fresh or an existing (v2) database.
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const mysql = require('mysql2/promise');

async function hasCol(conn, table, col) {
  const [r] = await conn.query('SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, col]);
  return r.length > 0;
}
async function hasIndex(conn, table, name) {
  const [r] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?', [table, name]);
  return r.length > 0;
}
async function ensureCol(conn, table, col, ddl) { if (!(await hasCol(conn, table, col))) { await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`); return true; } return false; }
async function ensureIndex(conn, table, name, cols) { if (!(await hasIndex(conn, table, name))) await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${cols})`); }

async function migrate(conn) {
  const dir = path.join(__dirname, '..');
  await conn.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(dir, 'schema_v3.sql'), 'utf8'));

  // ---- upgrades to v2 tables ----
  await ensureCol(conn, 'users', 'language', 'VARCHAR(5) NULL');
  await ensureCol(conn, 'businesses', 'group_id', 'INT NULL');
  await ensureCol(conn, 'businesses', 'next_po', 'INT NOT NULL DEFAULT 0');
  await ensureCol(conn, 'businesses', 'next_refund', 'INT NOT NULL DEFAULT 0');
  await ensureCol(conn, 'products', 'barcode', 'VARCHAR(64) NULL');
  await ensureCol(conn, 'products', 'expiry_date', 'DATE NULL');
  await ensureIndex(conn, 'products', 'idx_barcode', 'business_id, barcode');
  await ensureCol(conn, 'sales', 'customer_id', 'INT NULL');
  await ensureCol(conn, 'sales', 'tax_amount', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await ensureCol(conn, 'sales', 'refunded_total', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await ensureCol(conn, 'sales', 'points_earned', 'INT NOT NULL DEFAULT 0');
  await ensureCol(conn, 'sales', 'points_redeemed', 'INT NOT NULL DEFAULT 0');
  const addedPaid = await ensureCol(conn, 'sales', 'amount_paid', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await ensureCol(conn, 'sales', 'paid_status', "ENUM('paid','partial','unpaid') NOT NULL DEFAULT 'paid'");
  await ensureIndex(conn, 'sales', 'idx_cust', 'business_id, customer_id');
  await ensureCol(conn, 'expenses', 'status', "ENUM('approved','pending','rejected') NOT NULL DEFAULT 'approved'");
  await ensureCol(conn, 'expenses', 'approved_by', 'INT NULL');
  await ensureCol(conn, 'expenses', 'recurring_id', 'INT NULL');
  await ensureCol(conn, 'expenses', 'from_till', 'TINYINT(1) NOT NULL DEFAULT 0');
  await conn.query("ALTER TABLE stock_movements MODIFY COLUMN type ENUM('opening','purchase','sale','void_return','adjustment','damage','refund_return','transfer_out','transfer_in') NOT NULL");
  await conn.query("ALTER TABLE stock_movements MODIFY COLUMN ref_type VARCHAR(20) NULL");

  // ---- one-time back-fill so old sales behave like new ones ----
  if (addedPaid) await conn.query("UPDATE sales SET amount_paid=total WHERE status='completed'");
  await conn.query(`INSERT INTO sale_payments (business_id,sale_id,customer_id,method,amount,created_by,created_at)
    SELECT s.business_id,s.id,NULL,s.payment_method,s.total,s.sold_by,s.sold_at FROM sales s
    WHERE s.total>0 AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id=s.id)`);
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  (async () => {
    const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
    await migrate(conn);
    console.log('✅ Database ready (FBBMS v3):', process.env.DB_NAME);
    await conn.end();
  })().catch(e => { console.error('❌ Migration failed:', e.message); process.exit(1); });
}
