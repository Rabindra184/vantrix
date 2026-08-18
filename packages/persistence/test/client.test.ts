import { describe, expect, it } from 'vitest';
import { createPool, withConnectionLimit } from '../src/client.js';

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

/**
 * Prisma opens a SECOND pool, separate from `createPool`'s, and nothing in
 * this repository accounted for it until `PrismaOptions.connectionLimit`
 * existed: Prisma's own default is `num_physical_cpus * 2 + 1`, so a worker
 * replica that budgeted 31 connections and said so in the README was really
 * taking 40 to 48 -- and by an amount that varied with the host's CPU
 * count.
 *
 * The string transform is what carries that fix, so it is what is tested.
 * `PrismaClient` does not expose the datasource URL it was built with.
 */
describe('withConnectionLimit', () => {
  const BASE = 'postgresql://perfportal:perfportal@localhost:5433/perfportal';

  it('leaves the url completely alone when no limit is given', () => {
    // Every existing caller (the API's own `createPrisma`) passes nothing,
    // and must keep getting exactly the URL it supplied -- not a
    // round-tripped, re-encoded near-copy of it.
    expect(withConnectionLimit(BASE, undefined)).toBe(BASE);
  });

  it('applies the limit as a query parameter', () => {
    const url = new URL(withConnectionLimit(BASE, 3));
    expect(url.searchParams.get('connection_limit')).toBe('3');
    // and changes nothing else about the target
    expect(url.pathname).toBe('/perfportal');
    expect(url.port).toBe('5433');
  });

  it('preserves query parameters the url already carried', () => {
    const withSchema = `${BASE}?schema=public`;
    const url = new URL(withConnectionLimit(withSchema, 3));
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('connection_limit')).toBe('3');
  });

  it("does not override an operator's own connection_limit", () => {
    // This is the knob someone reaches for when a deployment's database
    // says otherwise. A code-level default that silently overrode a
    // deliberately-set URL parameter is the harder of the two failures to
    // diagnose.
    const pinned = `${BASE}?connection_limit=42`;
    expect(withConnectionLimit(pinned, 3)).toBe(pinned);
  });

  it('passes a malformed url through untouched', () => {
    // It must fail inside Prisma, with Prisma's message about DATABASE_URL
    // -- not here with a TypeError from `new URL` that names nothing.
    expect(withConnectionLimit('not a url at all', 3)).toBe('not a url at all');
  });
});
