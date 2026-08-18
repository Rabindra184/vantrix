import { describe, expect, it } from 'vitest';
import { createPool } from '../src/client.js';

/**
 * Fix round 1, Critical 1 (apps/worker/src/live/fold-owner.ts's Task 4
 * design review). `createPool` gained an optional second `PoolOptions`
 * argument (`max`, `connectionTimeoutMillis`) so `apps/worker/src/main.ts`
 * can size its shared pool from `maxOwnedRuns` instead of leaving it at
 * pg's own defaults -- design part-2a §1.3's whole point is that those
 * defaults (`max: 10`, no `connectionTimeoutMillis`) silently deadlock a
 * worker once more than 10 runs are owned at once.
 *
 * `pg.Pool` is lazy: constructing one issues no connection, so these
 * assertions run with no database and no `docker compose` stack at all --
 * this file belongs in `pnpm test:unit`, not `test:integration`.
 */
describe('createPool', () => {
  it('defaults to max: 10 and no connection timeout -- unchanged for every existing caller', async () => {
    const pool = createPool('postgresql://example.invalid/db');
    try {
      expect(pool.options.max).toBe(10);
      expect(pool.options.connectionTimeoutMillis).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('accepts an explicit max and connectionTimeoutMillis', async () => {
    const pool = createPool('postgresql://example.invalid/db', {
      max: 30,
      connectionTimeoutMillis: 10_000,
    });
    try {
      expect(pool.options.max).toBe(30);
      expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    } finally {
      await pool.end();
    }
  });

  it('lets max be set without also setting connectionTimeoutMillis', async () => {
    // Not the shape apps/worker/src/main.ts actually uses (it always sets
    // both), but the two options are independent flags on PoolOptions, not
    // an all-or-nothing pair, and nothing should force them together.
    const pool = createPool('postgresql://example.invalid/db', { max: 5 });
    try {
      expect(pool.options.max).toBe(5);
      expect(pool.options.connectionTimeoutMillis).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
