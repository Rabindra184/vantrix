import type pg from 'pg';
import { SCHEMA_TABLES } from '../../src/index.js';

/** TRUNCATE, not DROP: the schema is migrated once per run, the data per test. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for integration tests. Run: docker compose -f infra/docker-compose.yml up -d',
    );
  }
  return url;
}
