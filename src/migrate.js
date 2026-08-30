require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL yet — skipping migration.');
    process.exit(0);
  }
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema is up to date.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
