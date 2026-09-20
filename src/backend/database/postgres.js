const { Pool } = require('pg');

const databaseHost = process.env.POSTGRES_HOST || '127.0.0.1';
const databasePort = process.env.POSTGRES_PORT || '5432';
const databaseName = process.env.POSTGRES_DB || 'stream_gps';
const databaseUser = process.env.POSTGRES_USER || 'stream_gps';
const databaseUrl = process.env.DATABASE_URL || (
  process.env.POSTGRES_PASSWORD &&
  `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${databaseHost}:${databasePort}/${databaseName}`
);

if (!databaseUrl) {
  throw new Error('DATABASE_URL or POSTGRES_PASSWORD is required');
}

const pool = new Pool({ connectionString: databaseUrl });

module.exports = { pool };
