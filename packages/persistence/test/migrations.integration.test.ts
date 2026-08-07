import { describe, expect, it } from 'vitest';
import { createPool, SCHEMA_TABLES } from '../src/index.js';

const URL_ = process.env.DATABASE_URL;
if (!URL_) throw new Error('DATABASE_URL is required for integration tests. See infra/docker-compose.yml.');

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

  it('has at least one partition ready to accept writes', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhparent WHERE c.relname = 'run_series_bucket'`,
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
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
