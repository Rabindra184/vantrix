import { PrismaClient } from '@prisma/client';
import pg from 'pg';

export interface PrismaOptions {
  /**
   * Pins Prisma's OWN connection pool size, via the `connection_limit`
   * query parameter its datasource URL accepts.
   *
   * Omitted, Prisma sizes its pool as `num_physical_cpus * 2 + 1` --
   * roughly 9 to 17 connections depending on the machine, and NOTHING in
   * this repository accounts for it. That matters because `createPool`
   * below is sized with great care from what its consumers hold, and this
   * client opens a SECOND, entirely separate pool against the same
   * database. A process that budgets 31 connections for the pg pool and
   * says so actually opens up to ~48, and the difference is a function of
   * the host's CPU count rather than of anything the code decides.
   *
   * A caller that has sized `createPool` from a real bound should size this
   * from one too, so its total is a number someone chose. An operator's own
   * `connection_limit` already in the URL WINS -- see `createPrisma`.
   */
  connectionLimit?: number;
}

/**
 * Prisma owns schema, migrations, and CRUD. The metric tables are written and
 * read with raw parameterized SQL through this pool: Prisma is weak at bytea
 * payloads, batched inserts of tens of thousands of rows, and analytical
 * aggregation, and that is where query performance would quietly rot.
 *
 * "This pool" in that sentence is `createPool`'s. THIS function opens a
 * different one -- see {@link PrismaOptions.connectionLimit}, which is the
 * only way to bound it.
 */
export function createPrisma(url: string, options: PrismaOptions = {}): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, options.connectionLimit) } } });
}

/**
 * `url` with `?connection_limit=N` applied, unless the caller passed no
 * limit or the URL already carries one.
 *
 * AN EXISTING VALUE WINS, deliberately: `connection_limit` is the knob an
 * operator reaches for when a deployment's database says otherwise, and a
 * code-level default that silently overrode a deliberately-set URL
 * parameter would be the harder failure to diagnose of the two.
 *
 * Left completely alone when the URL cannot be parsed. A malformed
 * `DATABASE_URL` must fail where it already fails -- inside Prisma, with
 * Prisma's own message -- not here with a `TypeError` from `new URL` that
 * says nothing about what is wrong.
 *
 * Exported for its own test. `PrismaClient` does not expose the datasource
 * URL it was constructed with, so testing this through `createPrisma` would
 * mean asserting nothing at all.
 */
export function withConnectionLimit(url: string, limit: number | undefined): string {
  if (limit === undefined) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.searchParams.has('connection_limit')) return url;
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
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
  'runner_artifact',
  'runner_job',
  'user',
  'session',
  'account',
  'verification',
  'org_member',
] as const;
