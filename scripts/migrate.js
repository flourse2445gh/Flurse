import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from '../lib/db.js';
import { loadEnv } from './load-env.js';

const here = dirname(fileURLToPath(import.meta.url));
await loadEnv(join(here, '..', '.env'));

const sql = await readFile(join(here, '..', 'db', 'schema.sql'), 'utf8');
const pool = getPool();
try {
  await pool.query(sql);
  console.log('Schema applied.');
} finally {
  await closePool();
}
