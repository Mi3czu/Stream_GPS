const fs = require('fs/promises');
const path = require('path');
const { pool } = require('./postgres');

const migrationsDirectory = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '../../../database/migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const files = (await fs.readdir(migrationsDirectory))
      .filter((filename) => /^\d+_.+\.sql$/.test(filename))
      .sort();
    const applied = await client.query('SELECT filename FROM schema_migrations');
    const appliedNames = new Set(applied.rows.map((row) => row.filename));

    for (const filename of files) {
      if (appliedNames.has(filename)) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
      console.log(`Applying migration ${filename}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
