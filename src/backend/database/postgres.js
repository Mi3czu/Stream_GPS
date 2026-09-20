const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || (
  process.env.POSTGRES_PASSWORD &&
  `postgresql://stream_gps:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@127.0.0.1:5432/stream_gps`
);

if (!databaseUrl) {
  throw new Error('DATABASE_URL or POSTGRES_PASSWORD is required');
}

const pool = new Pool({ connectionString: databaseUrl });

module.exports = { pool };
