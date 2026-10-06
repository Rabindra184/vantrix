import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, runNumberClause, SCHEMA_TABLES, TestRepository } from '../src/index.js';

/**
 * ═══ A RUN'S NUMBER, AT THE PERSISTENCE LAYER ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Two things live here rather than in the worker's suite: the backfill that
 * numbered history when the column arrived, and the delete that must clear a
 * number the foreign key's SET NULL cannot reach.
 */
const pool = createPool(process.env.DATABASE_URL ?? '');
const prisma = createPrisma(process.env.DATABASE_URL ?? '');

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

const testRow = (slug: string) =>
  prisma.test.create({
    data: { orgId, projectId, slug, name: slug, simulationClass: `example.${slug}` },
  });

/** A run row. `createdAt` and `startedAt` are set independently on purpose:
 *  the backfill orders by CREATION, and a fixture where the two agree cannot
 *  tell that rule from ordering by start. */
const runRow = (opts: {
  testId: string | null;
  createdAt: string;
  startedAt: string;
  runNumber?: number | null;
}) =>
  prisma.run.create({
    data: {
      orgId,
      projectId,
      testId: opts.testId,
      runNumber: opts.runNumber ?? null,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: new Date(opts.createdAt),
      startedAt: new Date(opts.startedAt),
      startedOn: new Date(opts.startedAt.slice(0, 10)),
      engineOptions: {},
    },
  });

/** The migration's own backfill, read out of the file between its markers and
 *  executed verbatim — never a copy of it, which could drift from the SQL
 *  that actually ran on every database. */
function backfillStatements(): string[] {
  const sql = readFileSync(
    fileURLToPath(
      new URL('../prisma/migrations/20260927180000_run_number/migration.sql', import.meta.url),
    ),
    'utf8',
  );
  const block = sql.split('-- BACKFILL: begin')[1]!.split('-- BACKFILL: end')[0]!;
  const statements = block
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Vacuity guard: a marker that moved would leave this with nothing to run,
  // and every assertion below would then be about the fixture's own nulls.
  expect(statements).toHaveLength(2);
  return statements;
}

describe('the backfill that numbered existing runs', () => {
  it('numbers each test’s runs by CREATION order and sets its counter past the last', async () => {
    const a = await testRow('checkout-smoke');
    const b = await testRow('checkout-soak');
    // Created in the order x, y, z — but STARTED in the order z, x, y, so
    // ordering by start would number them differently.
    const x = await runRow({ testId: a.id, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-08-02T10:00:00Z' });
    const y = await runRow({ testId: a.id, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-08-03T10:00:00Z' });
    const z = await runRow({ testId: a.id, createdAt: '2026-09-03T10:00:00Z', startedAt: '2026-08-01T10:00:00Z' });
    const other = await runRow({ testId: b.id, createdAt: '2026-09-04T10:00:00Z', startedAt: '2026-08-04T10:00:00Z' });
    const ungrouped = await runRow({ testId: null, createdAt: '2026-09-05T10:00:00Z', startedAt: '2026-08-05T10:00:00Z' });

    for (const statement of backfillStatements()) await pool.query(statement);

    const numbers = await prisma.run.findMany({ select: { id: true, runNumber: true } });
    const byId = new Map(numbers.map((r) => [r.id, r.runNumber]));
    expect([byId.get(x.id), byId.get(y.id), byId.get(z.id)]).toEqual([1, 2, 3]);
    expect(byId.get(other.id)).toBe(1);
    expect(byId.get(ungrouped.id)).toBeNull();

    const counters = await prisma.test.findMany({ select: { id: true, nextRunNumber: true } });
    const counterOf = new Map(counters.map((t) => [t.id, t.nextRunNumber]));
    expect(counterOf.get(a.id)).toBe(4);
    expect(counterOf.get(b.id)).toBe(2);
  });
});

describe('deleting a test', () => {
  it('leaves its runs ungrouped with no number, and touches no other test’s runs', async () => {
    const doomed = await testRow('checkout-smoke');
    const kept = await testRow('checkout-soak');
    const r1 = await runRow({ testId: doomed.id, runNumber: 1, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-09-01T10:00:00Z' });
    const r2 = await runRow({ testId: doomed.id, runNumber: 2, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-09-02T10:00:00Z' });
    const survivor = await runRow({ testId: kept.id, runNumber: 1, createdAt: '2026-09-03T10:00:00Z', startedAt: '2026-09-03T10:00:00Z' });

    const removed = await new TestRepository(prisma).remove({ orgId, projectId }, 'checkout-smoke');
    expect(removed?.slug).toBe('checkout-smoke');

    const rows = await prisma.run.findMany({ select: { id: true, testId: true, runNumber: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The runs survive — deleting a label must not delete a measurement —
    // and carry no number, because there is no test left to count within.
    expect(byId.get(r1.id)).toMatchObject({ testId: null, runNumber: null });
    expect(byId.get(r2.id)).toMatchObject({ testId: null, runNumber: null });
    expect(byId.get(survivor.id)).toMatchObject({ testId: kept.id, runNumber: 1 });
  });

  /** remove() clears numbers in two statements: (1) before the delete, on the
   *  runs committed in the test, and (3) after it, on every ungrouped-but-
   *  numbered run in the project (`testId: null, runNumber: { not: null }`).
   *  (3) is what catches a run that joined the test after (1) read it and was
   *  then ungrouped by the cascade still numbered. Producing that needs a
   *  concurrent writer (the worker's run-number suite forces one), so `stray`
   *  seeds its end state directly: ungrouped, numbered. `grouped` is (1)'s.
   *  Both must end unnumbered; drop (3) and `stray` keeps its 5. */
  it('clears a number left on a run that is already ungrouped', async () => {
    const stray = await runRow({ testId: null, runNumber: 5, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-09-01T10:00:00Z' });
    const doomed = await testRow('checkout-soak');
    const grouped = await runRow({ testId: doomed.id, runNumber: 1, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-09-02T10:00:00Z' });

    const removed = await new TestRepository(prisma).remove({ orgId, projectId }, 'checkout-soak');
    expect(removed?.slug).toBe('checkout-soak');

    const rows = await prisma.run.findMany({ select: { id: true, testId: true, runNumber: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(stray.id)).toMatchObject({ testId: null, runNumber: null });
    expect(byId.get(grouped.id)).toMatchObject({ testId: null, runNumber: null });
  });
});

describe('the run-number filter', () => {
  /**
   * THE PLAN, NOT JUST THE ROWS — every row assertion passes against a
   * sequential scan, so nothing else can tell the unique index from a
   * decorative one. `SET LOCAL enable_seqscan = off` removes the planner's
   * preference for a scan on a table too small to have one; an expression the
   * index cannot serve still plans as `Seq Scan`, so the plan names the index
   * only when the predicate really is one it can use. `SET LOCAL` inside a
   * transaction, never a bare `SET`, because Prisma hands out a pooled
   * connection and a bare one would leak onto whichever test drew it next.
   *
   * BUILT FROM THE SAME FUNCTION `RunRepository.list` builds from, so a change
   * to the real predicate is a change to this one.
   */
  it('is served by run_test_id_run_number_key', async () => {
    const test = await testRow('checkout-soak');
    await runRow({ testId: test.id, runNumber: 2, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-09-02T10:00:00Z' });

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (COSTS OFF)
       SELECT r.id FROM run r
        WHERE r.test_id = $1::uuid
          AND ${runNumberClause(2)}`,
        test.id,
        2,
      );
    });
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    // Guard first: EXPLAIN really did return a plan.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('run_test_id_run_number_key');
    expect(text).not.toContain('Seq Scan on run');
    // NAMING THE INDEX IS NOT ENOUGH, and it was measured not to be: with the
    // predicate written `run_number::text = …` the plan still names this
    // index — it serves `test_id`, the key's first column — and filters every
    // one of that test's runs for the number. The number has to be in the
    // INDEX CONDITION, which is what makes the lookup one row rather than a
    // test's whole history.
    expect(text).toMatch(/Index Cond:.*\brun_number = /);
  });

  it('spells the predicate as an int comparison against the placeholder it is given', () => {
    expect(runNumberClause(4)).toBe('r.run_number = $4::int');
  });
});
