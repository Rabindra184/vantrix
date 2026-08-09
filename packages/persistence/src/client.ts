import { PrismaClient } from '@prisma/client';
import pg from 'pg';

/**
 * Prisma owns schema, migrations, and CRUD. The metric tables are written and
 * read with raw parameterized SQL through this pool: Prisma is weak at bytea
 * payloads, batched inserts of tens of thousands of rows, and analytical
 * aggregation, and that is where query performance would quietly rot.
 */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export const SCHEMA_TABLES = [
  'org',
  'project',
  'api_token',
  'run',
  'run_stat',
  'run_series_bucket',
  'run_user_bucket',
  'run_error',
  'sla_rule',
  'run_assertion',
] as const;
