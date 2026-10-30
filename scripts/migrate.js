// Creates all FBBMS v2 tables in the database named in .env (safe to run repeatedly).
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  await conn.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  console.log('✅ Database ready:', process.env.DB_NAME);
  await conn.end();
})().catch(e => { console.error('❌ Migration failed:', e.message); process.exit(1); });
