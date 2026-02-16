/**
 * Run schema migrations against an existing database.
 * Use when DB already exists (init scripts won't run) or for schema updates.
 * Runs all *.sql files in init/ in alphabetical order (01, 02, 03...).
 *
 * Usage: npm run db:migrate
 *    or: DATABASE_URL=postgresql://... node infrastructure/db/run-migrations.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const initDir = path.join(__dirname, 'init');
const sqlFiles = fs.readdirSync(initDir).filter((f) => f.endsWith('.sql')).sort();

async function run() {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://fm_sync:fm_sync_dev@localhost:5432/fm_sync';
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    for (const file of sqlFiles) {
      const filePath = path.join(initDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      await client.query(sql);
      console.log('Applied:', file);
    }
    console.log('Migrations applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
