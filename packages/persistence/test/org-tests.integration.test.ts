import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Sketch } from '@perfportal/statistics';
import { createPool, createPrisma, SCHEMA_TABLES, TestRepository } from '../src/index.js';

/**
 * ═══ EVERY TEST IN THE ORG, WITH ITS LATEST RUN AND ITS p95 HISTORY ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-and-command-palette-design.md)
 *
 * `TestRepository.listOrg` is what `GET /v1/tests` reads. Three things in it
 * are easy to get subtly wrong and none of them shows in a happy-path row:
 *
 *   - "latest run" is the newest ARRIVAL (`created_at DESC, id DESC`), which is
 *     the order run numbers follow — NOT the run list's by-start order. Every
 *     run here carries a `created_at` and a `started_at` that DISAGREE, because
 *     a fixture where the two agree cannot tell the two orderings apart.
 *   - the keyset over `ORDER BY latest DESC NULLS LAST, name, id` has three
 *     boundaries (dated to dated, dated to never-run, never-run to never-run)
 *     and a tie inside the first; the paging cases walk every one.
 *   - the p95 history is capped at ten points because the wire schema is; a
 *     query that returned eleven would make the browser's parse of the WHOLE
 *     response throw.
 */
const pool = createPool(process.env.DATABASE_URL ?? '');
const prisma = createPrisma(process.env.DATABASE_URL ?? '');
const repo = new TestRepository(prisma);

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

const scope = () => ({ orgId });

const testRow = (
  slug: string,
  over: { name?: string; simulationClass?: string; projectId?: string } = {},
) =>
  prisma.test.create({
    data: {
      orgId,
      projectId: over.projectId ?? projectId,
      slug,
      name: over.name ?? slug,
      simulationClass: over.simulationClass ?? `example.${slug}`,
    },
  });

/** A sketch of `n` observations: the stat table's `sketch` column is NOT NULL
 *  and a placeholder byte would fail to deserialise in any reader that tried. */
function sketchOf(n: number): Sketch {
  const s = new Sketch();
  for (let i = 0; i < n; i += 1) s.accept(i + 1);
  return s;
}

interface RunOpts {
  testId: string | null;
  /** When the run ARRIVED. Always explicit: `createMany` stamps every row with
   *  the same `now()`, and a fixture with one timestamp orders nothing. */
  createdAt: string;
  /** When the load test ran. Deliberately independent of `createdAt`. */
  startedAt?: string;
  toolStartedAt?: string | null;
  status?: string;
  verdict?: string | null;
  runNumber?: number | null;
  durationMs?: number | null;
  toolAssertions?: unknown;
  /** Present = a run-scope response-time stat row carrying these. */
  stat?: { percentiles: Record<string, unknown>; minMs: number; maxMs: number };
  projectId?: string;
}

async function seedRun(opts: RunOpts): Promise<string> {
  const id = randomUUID();
  const startedAt = opts.startedAt ?? opts.createdAt;
  const project = opts.projectId ?? projectId;
  await prisma.run.create({
    data: {
      id,
      orgId,
      projectId: project,
      testId: opts.testId,
      runNumber: opts.runNumber ?? null,
      status: opts.status ?? 'complete',
      verdict: opts.verdict === undefined ? 'passed' : opts.verdict,
      tool: 'gatling',
      bundleKey: `runs/${project}/${id}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: new Date(opts.createdAt),
      startedAt: new Date(startedAt),
      startedOn: new Date(startedAt.slice(0, 10)),
      toolStartedAt:
        opts.toolStartedAt === undefined || opts.toolStartedAt === null
          ? null
          : new Date(opts.toolStartedAt),
      durationMs: opts.durationMs ?? null,
      toolAssertions: opts.toolAssertions === undefined ? undefined : (opts.toolAssertions as never),
      engineOptions: {},
    },
  });
  if (opts.stat) {
    await pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
          error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
          sketch, sketch_kind)
       VALUES ($1,$2,$3,$4,'run','','response_time',10,10,0,0,$5,$6,5,2,1.5,$7,$8,'ddsketch')`,
      [
        randomUUID(),
        id,
        orgId,
        project,
        opts.stat.minMs,
        opts.stat.maxMs,
        JSON.stringify(opts.stat.percentiles),
        Buffer.from(sketchOf(10).serialize()),
      ],
    );
  }
  return id;
}

const slugsOf = (items: { slug: string }[]) => items.map((i) => i.slug);

describe('TestRepository.listOrg', () => {
  it('lists every test in the org with its project', async () => {
    const search = await prisma.project.create({
      data: { orgId, slug: 'search', name: 'Search Service', settings: {} },
    });
    await testRow('checkout-smoke');
    await testRow('search-soak', { projectId: search.id });

    const { items, nextCursor } = await repo.listOrg(scope(), { limit: 25 });

    expect(nextCursor).toBeNull();
    expect(items.map((i) => [i.slug, i.project.slug, i.project.name]).sort()).toEqual([
      ['checkout-smoke', 'checkout', 'Checkout'],
      ['search-soak', 'search', 'Search Service'],
    ]);
  });

  it('counts every run of a test, whatever its status', async () => {
    const t = await testRow('checkout-smoke');
    await seedRun({ testId: t.id, createdAt: '2026-09-01T10:00:00Z' });
    await seedRun({ testId: t.id, createdAt: '2026-09-02T10:00:00Z', status: 'failed', verdict: null });
    await testRow('never-run');

    const { items } = await repo.listOrg(scope(), { limit: 25 });
    const bySlug = new Map(items.map((i) => [i.slug, i]));
    expect(bySlug.get('checkout-smoke')!.runCount).toBe(2);
    expect(bySlug.get('never-run')!.runCount).toBe(0);
    expect(bySlug.get('never-run')!.latestRun).toBeNull();
    expect(bySlug.get('never-run')!.p95History).toEqual([]);
  });

  it('takes the newest ARRIVAL as the latest run, not the newest start', async () => {
    const t = await testRow('checkout-smoke');
    // A arrived first but STARTED last; B arrived last but started first. By
    // start the latest would be A, by arrival it is B.
    await seedRun({ testId: t.id, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-09-01T09:00:00Z' });
    const b = await seedRun({
      testId: t.id, createdAt: '2026-09-01T11:00:00Z', startedAt: '2026-09-01T08:00:00Z',
    });

    const { items } = await repo.listOrg(scope(), { limit: 25 });
    expect(items[0]!.latestRun!.id).toBe(b);
  });

  it('breaks a tie in arrival by id, descending', async () => {
    const t = await testRow('checkout-smoke');
    const a = await seedRun({ testId: t.id, createdAt: '2026-09-01T10:00:00Z' });
    const b = await seedRun({ testId: t.id, createdAt: '2026-09-01T10:00:00Z' });
    const higher = a > b ? a : b;

    const { items } = await repo.listOrg(scope(), { limit: 25 });
    expect(items[0]!.latestRun!.id).toBe(higher);
  });

  it('agrees with listForProject about the latest run', async () => {
    const t = await testRow('checkout-smoke');
    await seedRun({
      testId: t.id, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-09-01T09:00:00Z', runNumber: 1,
    });
    const b = await seedRun({
      testId: t.id, createdAt: '2026-09-01T11:00:00Z', startedAt: '2026-09-01T08:00:00Z',
      runNumber: 2, status: 'complete', verdict: 'failed',
    });

    const org = await repo.listOrg(scope(), { limit: 25 });
    const project = await repo.listForProject({ orgId, projectId });
    const bySlug = await repo.findBySlug({ orgId, projectId }, 'checkout-smoke');

    expect(project[0]!.latestRun!.id).toBe(org.items[0]!.latestRun!.id);
    expect(bySlug!.latestRun!.id).toBe(org.items[0]!.latestRun!.id);
    expect(org.items[0]!.latestRun!.id).toBe(b);
    // The two project-scoped readers keep their documented four-field shape.
    expect(project[0]!.latestRun).toEqual({
      id: b, status: 'complete', verdict: 'failed', runNumber: 2,
    });
    expect(bySlug!.latestRun).toEqual(project[0]!.latestRun);
  });

  it('reads the latest run’s start, duration, assertions and p95', async () => {
    const t = await testRow('checkout-smoke');
    const assertions = [
      { expression: 'p95 < 100', actualValue: 120, outcome: 'failed' },
      { expression: 'ko < 1', actualValue: 0, outcome: 'passed' },
    ];
    const id = await seedRun({
      testId: t.id,
      createdAt: '2026-09-02T10:00:00Z',
      // THE LOAD TEST'S START, which wins over the row's own `started_at`.
      startedAt: '2026-09-02T10:00:00Z',
      toolStartedAt: '2026-09-02T09:30:00Z',
      runNumber: 7,
      durationMs: 61_000,
      toolAssertions: assertions,
      stat: { percentiles: { p50: 40, p95: 90 }, minMs: 5, maxMs: 300 },
    });

    const { items } = await repo.listOrg(scope(), { limit: 25 });
    const latest = items[0]!.latestRun!;
    expect(latest.id).toBe(id);
    expect(latest.runNumber).toBe(7);
    expect(latest.status).toBe('complete');
    expect(latest.verdict).toBe('passed');
    expect(latest.startedAt).toEqual(new Date('2026-09-02T09:30:00Z'));
    expect(latest.durationMs).toBe(61_000);
    expect(latest.toolAssertions).toEqual(assertions);
    expect(latest.p95Ms).toBe(90);
  });

  it('falls back to the row’s own start when the tool recorded none', async () => {
    const t = await testRow('checkout-smoke');
    await seedRun({
      testId: t.id, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-09-02T09:15:00Z',
    });

    const { items } = await repo.listOrg(scope(), { limit: 25 });
    expect(items[0]!.latestRun!.startedAt).toEqual(new Date('2026-09-02T09:15:00Z'));
    // No stat row at all, and no recorded assertions: both read as null, which
    // is a different fact from zero.
    expect(items[0]!.latestRun!.p95Ms).toBeNull();
    expect(items[0]!.latestRun!.toolAssertions).toBeNull();
    expect(items[0]!.latestRun!.durationMs).toBeNull();
  });

  describe('order and paging', () => {
    /** t12 latest arrival 12:00, t11 11:00, and two that never ran. */
    async function fourTests() {
      const t12 = await testRow('t12');
      const t11 = await testRow('t11');
      // Created b first, so a name ordering — not an insertion ordering — is
      // what puts a-test ahead of it.
      await testRow('b-test');
      await testRow('a-test');
      await seedRun({ testId: t11.id, createdAt: '2026-09-01T11:00:00Z' });
      await seedRun({ testId: t12.id, createdAt: '2026-09-01T12:00:00Z' });
      // An older run beneath t12's newest: only the NEWEST arrival counts.
      await seedRun({ testId: t12.id, createdAt: '2026-09-01T08:00:00Z' });
      return { t12, t11 };
    }

    it('orders by latest arrival, never-run tests last by name', async () => {
      await fourTests();
      const { items } = await repo.listOrg(scope(), { limit: 25 });
      expect(slugsOf(items)).toEqual(['t12', 't11', 'a-test', 'b-test']);
    });

    it.each([1, 2, 3])('pages through that order with a cursor, limit %i', async (limit) => {
      await fourTests();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await repo.listOrg(scope(), { limit, cursor });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...slugsOf(page.items));
        if (page.nextCursor === null) break;
        // The cursor is the LAST item's id, so the next page starts after it.
        expect(page.nextCursor).toBe(page.items[page.items.length - 1]!.id);
        cursor = page.nextCursor;
      }
      // Every test exactly once, in the one order: no duplicate, none skipped.
      expect(seen).toEqual(['t12', 't11', 'a-test', 'b-test']);
    });

    it('crosses from dated to never-run mid-page', async () => {
      const { t11 } = await fourTests();
      const page = await repo.listOrg(scope(), { limit: 2, cursor: t11.id });
      expect(slugsOf(page.items)).toEqual(['a-test', 'b-test']);
      expect(page.nextCursor).toBeNull();
    });

    it('continues from a never-run cursor to the next never-run test', async () => {
      await fourTests();
      const a = await prisma.test.findFirstOrThrow({ where: { slug: 'a-test' } });
      const page = await repo.listOrg(scope(), { limit: 5, cursor: a.id });
      expect(slugsOf(page.items)).toEqual(['b-test']);
    });

    it('pages across a tie in latest arrival by name, then id', async () => {
      const x = await testRow('x', { name: 'Alpha' });
      const y = await testRow('y', { name: 'Beta' });
      const z = await testRow('z', { name: 'Gamma' });
      for (const t of [z, x, y]) {
        await seedRun({ testId: t.id, createdAt: '2026-09-01T10:00:00Z' });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await repo.listOrg(scope(), { limit: 1, cursor });
        seen.push(...slugsOf(page.items));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(['x', 'y', 'z']);
    });

    it('answers an unresolvable cursor with an empty page', async () => {
      await fourTests();
      expect(await repo.listOrg(scope(), { limit: 25, cursor: randomUUID() })).toEqual({
        items: [],
        nextCursor: null,
      });
      // Not a uuid at all: the column is a uuid, so an unguarded cast would
      // THROW here instead of answering the way the run list does.
      expect(await repo.listOrg(scope(), { limit: 25, cursor: 'not-a-uuid' })).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('does not resolve a cursor that belongs to another org', async () => {
      await fourTests();
      const other = await prisma.org.create({ data: { slug: 'other', name: 'Other' } });
      const otherProject = await prisma.project.create({
        data: { orgId: other.id, slug: 'other-p', name: 'Other P', settings: {} },
      });
      const foreign = await prisma.test.create({
        data: {
          orgId: other.id, projectId: otherProject.id, slug: 'foreign', name: 'foreign',
          simulationClass: 'example.foreign',
        },
      });
      expect(await repo.listOrg(scope(), { limit: 25, cursor: foreign.id })).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('q', () => {
    it('matches q against test name, slug, class, project name and project slug', async () => {
      const search = await prisma.project.create({
        data: { orgId, slug: 'search-svc', name: 'Discovery Platform', settings: {} },
      });
      await testRow('by-name', { name: 'Zebra checkout' });
      await testRow('by-slug-quokka');
      await testRow('by-class', { simulationClass: 'com.acme.WombatSimulation' });
      await testRow('in-project', { projectId: search.id });
      await testRow('unrelated');

      const find = async (q: string) =>
        slugsOf((await repo.listOrg(scope(), { limit: 25, q })).items);

      expect(await find('zebra')).toEqual(['by-name']);
      expect(await find('quokka')).toEqual(['by-slug-quokka']);
      expect(await find('wombat')).toEqual(['by-class']);
      expect(await find('discovery')).toEqual(['in-project']);
      expect(await find('search-svc')).toEqual(['in-project']);
    });

    it('matches q literally: % and _ are not wildcards', async () => {
      await testRow('literal', { name: '50%_off checkout' });
      await testRow('decoy', { name: '500-offset' });
      await testRow('slash', { name: 'a\\b' });

      const find = async (q: string) =>
        slugsOf((await repo.listOrg(scope(), { limit: 25, q })).items);

      expect(await find('50%_off')).toEqual(['literal']);
      expect(await find('a\\b')).toEqual(['slash']);
      // And unescaped, the wildcards would have matched the decoy.
      expect(await find('50_off')).toEqual([]);
    });

    it('pages a filtered list without leaking an unmatched test across the cursor', async () => {
      const a = await testRow('hit-a');
      const b = await testRow('hit-b');
      await testRow('miss');
      await seedRun({ testId: a.id, createdAt: '2026-09-01T10:00:00Z' });
      await seedRun({ testId: b.id, createdAt: '2026-09-01T11:00:00Z' });

      const first = await repo.listOrg(scope(), { limit: 1, q: 'hit' });
      expect(slugsOf(first.items)).toEqual(['hit-b']);
      const second = await repo.listOrg(scope(), { limit: 1, q: 'hit', cursor: first.nextCursor! });
      expect(slugsOf(second.items)).toEqual(['hit-a']);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('narrows to the token’s project', async () => {
    const search = await prisma.project.create({
      data: { orgId, slug: 'search', name: 'Search', settings: {} },
    });
    await testRow('checkout-smoke');
    await testRow('search-soak', { projectId: search.id });

    const mine = await repo.listOrg({ orgId, projectId: search.id }, { limit: 25 });
    expect(slugsOf(mine.items)).toEqual(['search-soak']);
  });

  it('never returns another org’s tests', async () => {
    const other = await prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await prisma.project.create({
      data: { orgId: other.id, slug: 'other-p', name: 'Other P', settings: {} },
    });
    await testRow('mine');
    await prisma.test.create({
      data: {
        orgId: other.id, projectId: otherProject.id, slug: 'theirs', name: 'theirs',
        simulationClass: 'example.theirs',
      },
    });
    const { items } = await repo.listOrg(scope(), { limit: 25 });
    expect(slugsOf(items)).toEqual(['mine']);
  });

  describe('p95 history', () => {
    it('reads it oldest first, complete runs only, clamped like the run list', async () => {
      const t = await testRow('checkout-smoke');
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        // Arrival is hourly; the p95 climbs with it so the order is legible.
        const hour = String(i).padStart(2, '0');
        const last = i === 11;
        ids.push(
          await seedRun({
            testId: t.id,
            createdAt: `2026-09-01T${hour}:00:00Z`,
            runNumber: i + 1,
            // The newest run's STORED p95 (500) sits above its own maximum
            // (300): the estimate escaped the sample's range, which is the
            // case the clamp exists for.
            stat: last
              ? { percentiles: { p95: 500 }, minMs: 10, maxMs: 300 }
              : { percentiles: { p95: 100 + i }, minMs: 10, maxMs: 1000 },
          }),
        );
      }
      // A failed run with a stat row of its own, sitting in the middle of the
      // window: it must be absent, not merely sorted away.
      const failed = await seedRun({
        testId: t.id,
        createdAt: '2026-09-01T10:30:00Z',
        status: 'failed',
        verdict: null,
        stat: { percentiles: { p95: 999 }, minMs: 1, maxMs: 2000 },
      });

      const { items } = await repo.listOrg(scope(), { limit: 25 });
      const history = items[0]!.p95History;

      expect(history).toHaveLength(10);
      // The ten most recent COMPLETE runs, oldest first: runs 3..12.
      expect(history.map((p) => p.runId)).toEqual(ids.slice(2));
      expect(history.map((p) => p.runNumber)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(history.map((p) => p.runId)).not.toContain(failed);
      expect(history.slice(0, -1).map((p) => p.p95Ms)).toEqual([
        102, 103, 104, 105, 106, 107, 108, 109, 110,
      ]);
      // Clamped to its own max, exactly as the run list's metrics.p95Ms is.
      expect(history[9]!.p95Ms).toBe(300);
      // And the latest run's own p95 is the same clamped number.
      expect(items[0]!.latestRun!.id).toBe(ids[11]);
      expect(items[0]!.latestRun!.p95Ms).toBe(300);
    });

    it('keeps each test’s history to its own runs', async () => {
      const a = await testRow('a');
      const b = await testRow('b');
      const ra = await seedRun({
        testId: a.id, createdAt: '2026-09-01T10:00:00Z',
        stat: { percentiles: { p95: 11 }, minMs: 1, maxMs: 100 },
      });
      const rb = await seedRun({
        testId: b.id, createdAt: '2026-09-01T11:00:00Z',
        stat: { percentiles: { p95: 22 }, minMs: 1, maxMs: 100 },
      });

      const { items } = await repo.listOrg(scope(), { limit: 25 });
      const bySlug = new Map(items.map((i) => [i.slug, i]));
      expect(bySlug.get('a')!.p95History).toEqual([{ runId: ra, runNumber: null, p95Ms: 11 }]);
      expect(bySlug.get('b')!.p95History).toEqual([{ runId: rb, runNumber: null, p95Ms: 22 }]);
    });

    it('leaves a run with no usable p95 out of the history', async () => {
      const t = await testRow('checkout-smoke');
      const first = await seedRun({
        testId: t.id, createdAt: '2026-09-01T10:00:00Z',
        stat: { percentiles: { p95: 50 }, minMs: 1, maxMs: 100 },
      });
      // A project whose percentile set omits p95: the stat row exists and has
      // other bands, but THIS question has no answer, and a neighbouring
      // percentile is a different question.
      await seedRun({
        testId: t.id, createdAt: '2026-09-01T11:00:00Z',
        stat: { percentiles: { p50: 40, p99: 90 }, minMs: 1, maxMs: 100 },
      });
      // A stored value that is not a number is not a usable p95 either.
      await seedRun({
        testId: t.id, createdAt: '2026-09-01T12:00:00Z',
        stat: { percentiles: { p95: 'fast' }, minMs: 1, maxMs: 100 },
      });
      // No stat row at all.
      await seedRun({ testId: t.id, createdAt: '2026-09-01T13:00:00Z' });
      const last = await seedRun({
        testId: t.id, createdAt: '2026-09-01T14:00:00Z',
        stat: { percentiles: { p95: 70 }, minMs: 1, maxMs: 100 },
      });

      const { items } = await repo.listOrg(scope(), { limit: 25 });
      expect(items[0]!.p95History.map((p) => [p.runId, p.p95Ms])).toEqual([
        [first, 50],
        [last, 70],
      ]);
    });

    it('does not let runs without a stat row eat the window of ten', async () => {
      const t = await testRow('checkout-smoke');
      for (let i = 0; i < 4; i += 1) {
        await seedRun({
          testId: t.id, createdAt: `2026-09-01T0${i}:00:00Z`,
          stat: { percentiles: { p95: 10 + i }, minMs: 1, maxMs: 100 },
        });
      }
      // Newer, complete, but never measured: the history is of MEASURED runs.
      for (let i = 0; i < 12; i += 1) {
        await seedRun({
          testId: t.id, createdAt: `2026-09-02T${String(i).padStart(2, '0')}:00:00Z`,
        });
      }
      const { items } = await repo.listOrg(scope(), { limit: 25 });
      expect(items[0]!.p95History.map((p) => p.p95Ms)).toEqual([10, 11, 12, 13]);
    });
  });
});
