import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();
const { Pool } = pkg;

function sanitizeDbUrl(url) {
  if (!url) return '';
  try {
    // mask password in formats like: postgres://user:password@host:port/db
    return url.replace(/(postgres(?:ql)?:\/\/[^:]*:)([^@]+)(@)/i, '$1****$3');
  } catch (_) {
    return '';
  }
}

export const safeConnectionString = sanitizeDbUrl(process.env.DATABASE_URL || '');

if (!process.env.DATABASE_URL) {
  console.warn('[DB] DATABASE_URL is not set. The server will exit after failing to connect.');
} else {
  console.log('[DB] Initializing PG pool with connectionString:', safeConnectionString);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If you ever need SSL (managed DBs), add: ssl: { rejectUnauthorized: false }
});

// verify connection at startup
export async function assertDbConnection() {
  try {
    const res = await pool.query('select 1 as ok');
    if (res.rows?.[0]?.ok !== 1) throw new Error('DB connection test failed');
  } catch (err) {
    // Surface rich pg error info when available
    const details = {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
      where: err?.where,
      routine: err?.routine,
      connectionString: safeConnectionString,
    };
    console.error('[DB] Connection test failed:', details);
    throw err;
  }
}