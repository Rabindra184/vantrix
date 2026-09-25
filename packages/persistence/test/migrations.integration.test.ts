import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPool, SCHEMA_TABLES } from '../src/index.js';

const URL_ = process.env.DATABASE_URL;
if (!URL_) throw new Error('DATABASE_URL is required for integration tests. See infra/docker-compose.yml.');

/**
 * Inserts (and always rolls back) a single run_series_bucket row dated
 * `runStartedOnSql` — a raw SQL date expression, e.g. `CURRENT_DATE` or
 * `'2027-06-15'::date` — so the caller can assert on whether Postgres could
 * route it to a partition at all. Rolling back either way means this leaves
 * no data behind regardless of whether the insert itself succeeds.
 */
async function insertBucketRow(pool: pg.Pool, runStartedOnSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO run_series_bucket
         (run_started_on, run_id, org_id, project_id, scope, name, family, start_offset_ms,
          started_count, ended_count, ok_count, ko_count, min_ms, max_ms, mean_ms, percentiles)
       VALUES (${runStartedOnSql}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
               'run', '', 'response_time', 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb)`,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('migrations', () => {
  it('creates every expected table', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...SCHEMA_TABLES]],
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual([...SCHEMA_TABLES].sort());
    } finally {
      await pool.end();
    }
  });

  it('partitions run_series_bucket by range, so retention is a partition drop', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ partstrat: string }>(
        `SELECT p.partstrat FROM pg_partitioned_table p
         JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = 'run_series_bucket'`,
      );
      expect(rows[0]?.partstrat).toBe('r');
    } finally {
      await pool.end();
    }
  });

  /**
   * `count(*) > 0` is true for as long as any partition exists at all — 12
   * do, and none are ever dropped, so that assertion is green forever,
   * including after 2027-01-01 once run.started_on falls past
   * run_series_bucket_2026_12 and every ingest starts failing with "no
   * partition of relation \"run_series_bucket\" found for row". The
   * discriminating version asks whether a partition actually covers
   * CURRENT_DATE: it stays green today and goes red in January, forcing the
   * rollover work migration 0001's hand-edited partitions defer.
   *
   * ═══ AND GOING RED IN JANUARY IS TOO LATE, WHICH IS WHY IT HAS A SIBLING
   * NOW ═══
   *
   * This case fires on the day `CURRENT_DATE` stops having a partition —
   * i.e. the morning of the outage, when every ingest is already failing.
   * That is DETECTION with no warning period.
   * `partition-runway.integration.test.ts` asks the other question — how far
   * away the end is — and goes red 180 days ahead, which is the difference
   * between being told and being told in time. Both are kept: this one
   * proves the actual INSERT works today, which a bound calculation cannot.
   *
   * Proven with a real INSERT (rolled back, not left behind) rather than by
   * re-deriving the answer from partition-bound metadata — an INSERT is
   * exactly the operation that fails in production when no partition
   * matches, so this exercises the actual failure mode, not a proxy for it.
   */
  it('has a partition ready to accept a write dated today', async () => {
    const pool = createPool(URL_);
    try {
      await expect(insertBucketRow(pool, 'CURRENT_DATE')).resolves.not.toThrow();
    } finally {
      await pool.end();
    }
  });

  /**
   * THE DATE IS DERIVED, AND IT USED TO BE WRITTEN DOWN.
   *
   * This case asserts that the partition set is FINITE — the one thing a
   * `count(*) > 0` assertion can never see. It did that by hard-coding
   * `'2027-06-15'`, which was past the last partition migration 0001
   * created... until `20260925120000_partitions_2027` created twelve more and
   * that date became an ordinary working day. **The case then failed for
   * being right**, on a tree where nothing was wrong.
   *
   * A test whose subject is "the set ends somewhere" must ASK where it ends.
   * The date now comes from the catalogue, plus a day, so every future
   * extension moves it automatically and the claim survives the migration it
   * is about. Same shape as `SCHEMA_TABLES` being derived rather than listed,
   * one file over.
   */
  it('demonstrates the fuse: a write dated past the last partition is rejected', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ expr: string }>(
        `SELECT pg_get_expr(c.relpartbound, c.oid) AS expr
           FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = 'run_series_bucket'`,
      );
      const bounds = rows
        .map((r) => /TO \('(\d{4}-\d{2}-\d{2})'\)/.exec(r.expr ?? '')?.[1])
        .filter((b): b is string => b !== undefined)
        .sort();
      // Vacuity: with no readable bound the `max` below is undefined and the
      // insert would be testing nothing at all.
      expect(bounds.length, 'no partition bounds could be read').toBeGreaterThan(0);
      const past = bounds[bounds.length - 1]!;

      await expect(insertBucketRow(pool, `'${past}'::date + 1`)).rejects.toThrow(
        /no partition of relation/i,
      );
    } finally {
      await pool.end();
    }
  });

  it('scopes every run to an org and a project', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'run' AND column_name IN ('org_id','project_id')`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
