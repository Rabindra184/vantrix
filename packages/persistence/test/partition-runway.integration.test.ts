import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/index.js';
import { requireDatabaseUrl } from './support/db.js';

const pool = createPool(requireDatabaseUrl());
afterAll(async () => { await pool.end(); });

/**
 * ═══ THE METRICS TABLES MUST NOT RUN OUT OF PARTITIONS QUIETLY ═══
 *
 * `0001_init` created twelve months from 2026-01 and said why: "Automatic
 * rollover is a later milestone; until then a write past the last partition
 * fails loudly rather than silently landing somewhere wrong." That is the
 * right call — a DEFAULT partition would accept the rows into a bag retention
 * cannot drop, which is worse than an error.
 *
 * WHAT WAS MISSING IS THAT NOTHING MEASURED THE DISTANCE. Measured on
 * 2026-09-25, all four partitioned tables ended at `TO ('2027-01-01')` — 98
 * days of runway — with no default partition and no job that creates one. The
 * partition key is the RUN's own start date, so from 1 January 2027 every new
 * load test would have failed to ingest, on all four tables at once. Proven
 * against a migrated database:
 *
 *     2026-12-31 -> INSERT 0 1
 *     2027-01-01 -> ERROR: no partition of relation "run_series_bucket"
 *                   found for row
 *
 * AND IT WOULD HAVE BEEN ILLEGIBLE. A Prisma "no partition found" reaches the
 * caller through the generic 500 path as "Retry the request" — the
 * remediation-that-cannot-work class this repository has already spent a
 * branch removing. Retrying re-sends a run whose date has not changed.
 *
 * ═══ THIS CASE FAILS ON THE CALENDAR, AND THAT IS THE DESIGN ═══
 *
 * Every other test here fails because somebody changed something. This one
 * fails because time passed, and it is the only shape that can warn about a
 * dated cliff: the product genuinely stops working on a date no commit
 * mentions. A red build six months early is the cheapest possible notice, and
 * the fix when it goes red is one migration — extend the partitions, exactly
 * as `20260925120000_partitions_2027` did.
 *
 * DO NOT "FIX" A FAILURE HERE BY LOWERING THE FLOOR. The floor is the warning
 * period, not a threshold to be tuned until the build is green.
 */

/** Six months, so a quarterly release cycle meets this twice before it bites. */
const FLOOR_DAYS = 180;

/** One row per PARTITION; the bound is parsed in TypeScript rather than in
 *  SQL, because `pg_get_expr` returns a literal this file can read directly
 *  and a regex threaded through a template literal into POSIX escaping is a
 *  second place to be wrong — the first draft was, and the vacuity guard
 *  below is what said so rather than a null reading as infinite runway. */
type Row = { parent: string; expr: string };

const UPPER_BOUND = /TO \('(\d{4}-\d{2}-\d{2})'\)/;

describe('every partitioned table has runway left', () => {
  it('keeps the furthest partition at least FLOOR_DAYS ahead of today', async () => {
    const { rows } = await pool.query<Row>(`
      SELECT p.relname AS parent, pg_get_expr(c.relpartbound, c.oid) AS expr
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relkind = 'p'
    `);

    const furthest = new Map<string, string>();
    for (const r of rows) {
      const m = UPPER_BOUND.exec(r.expr ?? '');
      if (!m) continue;
      const seen = furthest.get(r.parent);
      if (!seen || m[1]! > seen) furthest.set(r.parent, m[1]!);
    }

    /**
     * VACUITY, AND IT IS LOAD-BEARING TWICE OVER. A query that matched no
     * partitioned parents would pass this case for ever — and so would one
     * whose bound regex stopped matching, because a parent with no readable
     * bound would simply drop out of the map instead of reading as zero
     * runway. Both are asserted before any date arithmetic happens.
     */
    expect(rows.length, 'no partitions found — the catalogue query has rotted')
      .toBeGreaterThan(10);
    const parents = [...new Set(rows.map((r) => r.parent))];
    expect(parents.length, 'no partitioned tables found').toBeGreaterThan(3);
    expect(
      parents.filter((p) => !furthest.has(p)),
      'partitioned tables whose upper bound could not be read — the regex has rotted',
    ).toEqual([]);

    const today = Date.now();
    const short = [...furthest.entries()]
      .map(([parent, bound]) => ({
        parent,
        bound,
        days: Math.floor((Date.parse(`${bound}T00:00:00Z`) - today) / 86_400_000),
      }))
      .filter((r) => r.days < FLOOR_DAYS)
      .sort((a, b) => a.days - b.days)
      .map((r) => `${r.parent} ends ${r.bound} (${r.days} days left)`);

    expect(
      short,
      `partitions run out within ${FLOOR_DAYS} days — add the next year's, the way ` +
        '20260925120000_partitions_2027 did. A write past the last partition fails ' +
        'ingest outright; there is no default partition, deliberately.',
    ).toEqual([]);
  });
});
