import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, SCHEMA_TABLES, TestRepository } from '../src/index.js';

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

  /** The single clearing statement (AFTER the delete, on `testId: null,
   *  runNumber: { not: null }`) has to catch two things at once: a run that
   *  was ALREADY sitting ungrouped-but-numbered before remove() was even
   *  called — the state a run that joined mid-delete is left in — and the
   *  run the delete's own cascade just ungrouped. One statement, both cases. */
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
