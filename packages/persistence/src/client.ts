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

export interface PoolOptions {
  /**
   * Defaults to 10 — today's behaviour, unchanged for every existing caller
   * that omits this. A caller that shares this pool across several
   * connection-holding consumers (apps/worker/src/main.ts, once
   * `LiveFoldOwner` is wired in beside `PipelineService` and `Sweeper`) must
   * size this from what those consumers can actually hold at once, not
   * leave it at the default and discover the gap the hard way — see design
   * part-2a §1.3, amended after exactly that gap was found: a `max: 10`
   * pool against a `maxOwnedRuns` default of 25 does not degrade, it
   * deadlocks the whole worker the instant a tenth run is owned, with no
   * error, no timeout, and no log, because `connectionTimeoutMillis` was
   * also left at pg's own default of 0 (wait forever).
   */
  max?: number;
  /**
   * Defaults to 0 — pg's own default, meaning `pool.connect()` queues
   * forever rather than ever rejecting. Every existing caller relies on
   * that default (none of them pass this today), so it stays opt-in rather
   * than becoming a breaking change for callers that never needed a
   * timeout. A caller that sizes `max` from a real, load-bearing bound
   * (see `max`'s own doc comment) should also set this, so a future
   * mis-sizing — or genuine connection pressure — surfaces as a loud,
   * rejected `connect()` instead of a silent, permanent stall.
   */
  connectionTimeoutMillis?: number;
}

export function createPool(url: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  });
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
  'run_error_bucket',
  'telemetry_sample',
  'sla_rule',
  'run_assertion',
  'user',
  'session',
  'account',
  'verification',
  'org_member',
] as const;
