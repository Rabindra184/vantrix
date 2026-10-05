import { randomUUID } from 'node:crypto';
import {
  OrgTestListResponseSchema,
  RunListResponseSchema,
  type OrgTestListResponse,
} from '@perfportal/contracts';
import { Sketch } from '@perfportal/statistics';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

/**
 * `GET /v1/tests` — every test the caller may see, with its newest run and a
 * short p95 history. The repository's own cases (ordering, the keyset cursor,
 * the history window) live in `packages/persistence`; what is asserted HERE is
 * what only the endpoint decides: which credential sees how much, how `q` and
 * `limit` arrive at the query, and that the wire shape is the contract's.
 */

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestApp();
  // A REAL MEMBER of ctx's own org, for the reason tests.integration.test.ts
  // records: a no-membership session answers 403, so the wrong helper would
  // make every "a session sees the org" case pass or fail for the wrong cause.
  cookie = await signUpAsOrgMember(ctx, 'org-test-reader@example.test');
});

afterEach(async () => {
  await ctx?.close();
});

const PATH = '/v1/tests';

const asSession = (path: string) =>
  request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie);
const asToken = (path: string) =>
  request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ctx.readToken}`);

async function seedTest(
  slug: string,
  over: Partial<{ name: string; simulationClass: string; projectId: string; orgId: string }> = {},
) {
  return ctx.prisma.test.create({
    data: {
      orgId: over.orgId ?? ctx.orgId,
      projectId: over.projectId ?? ctx.projectId,
      slug,
      name: over.name ?? slug,
      simulationClass: over.simulationClass ?? `com.acme.${slug}`,
    },
  });
}

/**
 * A run with an explicit `createdAt`, because "latest" is by ARRIVAL and the
 * default would be the instant of seeding — two runs seeded back to back would
 * order by a clock nobody chose.
 */
async function seedRun(
  testId: string,
  createdAt: string,
  over: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await ctx.prisma.run.create({
    data: {
      id,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      testId,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: `runs/${ctx.projectId}/${id}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: new Date(createdAt),
      startedAt: new Date(createdAt),
      startedOn: new Date(createdAt.slice(0, 10)),
      engineOptions: {},
      ...over,
    },
  });
  return id;
}

/** The run-scope response-time row the endpoint reads a run's p95 from. */
async function seedRunStat(
  runId: string,
  p95: number,
  bounds: { minMs: number; maxMs: number },
) {
  const sketch = new Sketch();
  for (let i = 0; i < 10; i += 1) sketch.accept(i + 1);
  await ctx.pool.query(
    `INSERT INTO run_stat
       (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
        error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
        sketch, sketch_kind)
     VALUES ($1,$2,$3,$4,'run','','response_time',10,10,0,0,$5,$6,5,2,1.5,$7,$8,'ddsketch')`,
    [
      randomUUID(),
      runId,
      ctx.orgId,
      ctx.projectId,
      bounds.minMs,
      bounds.maxMs,
      JSON.stringify({ p95 }),
      Buffer.from(sketch.serialize()),
    ],
  );
}

/** A second project in ctx's OWN org: the axis an API token must not cross. */
async function seedOtherProject() {
  return ctx.prisma.project.create({
    data: { orgId: ctx.orgId, slug: 'other-project', name: 'Other Project', settings: {} },
  });
}

function parse(body: unknown): OrgTestListResponse {
  return OrgTestListResponseSchema.parse(body);
}

const slugsOf = (body: OrgTestListResponse) => body.items.map((i) => i.slug).sort();

describe('GET /v1/tests', () => {
  it('lists every test in the org for a session', async () => {
    await seedTest('checkout-smoke');
    const other = await seedOtherProject();
    await seedTest('search-soak', { projectId: other.id });

    const res = await asSession(PATH);

    expect(res.status).toBe(200);
    const body = parse(res.body);
    expect(slugsOf(body)).toEqual(['checkout-smoke', 'search-soak']);
    expect(body.nextCursor).toBeNull();
    // The row names its own project, so the table never asks per test.
    expect(
      body.items.map((i) => [i.slug, i.project.slug, i.project.name]).sort(),
    ).toEqual([
      ['checkout-smoke', 'checkout', expect.any(String)],
      ['search-soak', 'other-project', 'Other Project'],
    ]);
  });

  it('lists only the token’s own project for an API token', async () => {
    await seedTest('checkout-smoke');
    const other = await seedOtherProject();
    await seedTest('search-soak', { projectId: other.id });

    const res = await asToken(PATH);

    expect(res.status).toBe(200);
    expect(slugsOf(parse(res.body))).toEqual(['checkout-smoke']);
  });

  it('never shows another org’s tests', async () => {
    await seedTest('checkout-smoke');
    const otherOrg = await ctx.prisma.org.create({ data: { slug: 'other-org', name: 'Other' } });
    const theirs = await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'theirs', name: 'Theirs', settings: {} },
    });
    await seedTest('their-secret', { orgId: otherOrg.id, projectId: theirs.id });

    const session = await asSession(PATH);
    const token = await asToken(PATH);

    expect(slugsOf(parse(session.body))).toEqual(['checkout-smoke']);
    expect(slugsOf(parse(token.body))).toEqual(['checkout-smoke']);
    // And not through a free-text search either: a match is not a way in.
    expect(parse((await asSession(`${PATH}?q=secret`)).body).items).toEqual([]);
  });

  it('refuses an unauthenticated request', async () => {
    await seedTest('checkout-smoke');
    const res = await request(ctx.app.getHttpServer()).get(PATH);
    expect(res.status).toBe(401);
  });

  describe('q', () => {
    // REVIEW FOCUS 1. Two ways the same box can go wrong, and both make the
    // palette answer something other than what was typed.

    it('treats a whitespace-only q as no filter', async () => {
      await seedTest('checkout-smoke');
      await seedTest('search-soak');

      const plain = await asSession(PATH);
      const blank = await asSession(`${PATH}?q=%20%20`);

      expect(blank.status).toBe(200);
      // A blank `q` that reached the query would be `%  %`, which matches
      // nothing here — so equal, non-empty id lists are the whole assertion.
      expect(parse(plain.body).items).toHaveLength(2);
      expect(parse(blank.body).items.map((i) => i.id)).toEqual(
        parse(plain.body).items.map((i) => i.id),
      );
    });

    it('matches a q containing % and _ literally', async () => {
      await seedTest('promo', { name: 'Black Friday 50%_off' });
      // Decoys an unescaped `50%_off` would also match: `%` swallows the `0`
      // and `_` takes the space.
      await seedTest('decoy-a', { name: 'Black Friday 500 off' });
      await seedTest('decoy-b', { name: 'Black Friday 50xyoff' });

      const res = await asSession(`${PATH}?q=${encodeURIComponent('50%_off')}`);

      expect(res.status).toBe(200);
      expect(slugsOf(parse(res.body))).toEqual(['promo']);
    });

    it('trims a q before matching it', async () => {
      await seedTest('checkout-smoke');
      await seedTest('search-soak');

      const res = await asSession(`${PATH}?q=${encodeURIComponent('  search  ')}`);

      expect(slugsOf(parse(res.body))).toEqual(['search-soak']);
    });

    it('refuses a q given twice rather than failing on it', async () => {
      await seedTest('checkout-smoke');

      const res = await asSession(`${PATH}?q=checkout&q=search`);

      // A repeated parameter arrives as an array; `.trim()` on one would be a
      // TypeError, and a 500 for a request only the caller can have got wrong.
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_QUERY');
      expect(res.body.remediation).toMatch(/at most once/);
    });

    it('matches the owning project’s name as well as the test’s own words', async () => {
      const other = await seedOtherProject();
      await seedTest('smoke', { projectId: other.id });
      await seedTest('checkout-smoke');

      const res = await asSession(`${PATH}?q=${encodeURIComponent('other project')}`);

      expect(slugsOf(parse(res.body))).toEqual(['smoke']);
    });
  });

  describe('paging', () => {
    it('clamps limit and pages with nextCursor', async () => {
      const a = await seedTest('alpha');
      const b = await seedTest('bravo');
      await seedTest('charlie');
      await seedRun(a.id, '2026-09-01T10:00:00Z');
      await seedRun(b.id, '2026-09-02T10:00:00Z');

      const first = parse((await asSession(`${PATH}?limit=1`)).body);
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();

      const second = parse(
        (await asSession(`${PATH}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).body,
      );
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

      // limit=0 is clamped up to 1 rather than answered with an empty page a
      // paging client would read as the end of the list.
      const zero = parse((await asSession(`${PATH}?limit=0`)).body);
      expect(zero.items).toHaveLength(1);
      expect(zero.nextCursor).not.toBeNull();
    });

    it('pages with the opaque nextCursor', async () => {
      const a = await seedTest('alpha');
      const b = await seedTest('bravo');
      await seedTest('charlie');
      await seedTest('delta');
      await seedRun(a.id, '2026-09-01T10:00:00Z');
      await seedRun(b.id, '2026-09-02T10:00:00Z');

      const seen: string[] = [];
      let cursor: string | null = null;
      // A bound on the loop: a cursor that never ended would otherwise hang
      // the case instead of failing it.
      for (let page = 0; page < 10; page += 1) {
        const query: string =
          cursor === null ? `${PATH}?limit=1` : `${PATH}?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const body = parse((await asSession(query)).body);
        seen.push(...body.items.map((i) => i.slug));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(cursor).toBeNull();
      // Every test once: none skipped across a page boundary, none repeated.
      expect(seen.sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    });

    it('answers an empty page for a malformed cursor', async () => {
      await seedTest('checkout-smoke');

      const res = await asSession(`${PATH}?cursor=not-a-cursor`);

      // 200, not 400: the cursor is opaque, so a caller cannot have built one
      // wrongly — only held an old or foreign one, which is an empty page.
      expect(res.status).toBe(200);
      expect(parse(res.body)).toEqual({ items: [], nextCursor: null });
    });
  });

  it('reports the latest run’s checks and p95', async () => {
    const t = await seedTest('checkout-smoke');
    await seedRun(t.id, '2026-09-01T10:00:00Z');
    const latest = await seedRun(t.id, '2026-09-02T10:00:00Z', {
      runNumber: 2,
      durationMs: 61_000,
      toolStartedAt: new Date('2026-09-02T09:30:00Z'),
      toolAssertions: [
        { expression: 'p95 < 100', actualValue: 120, outcome: 'failed' },
        { expression: 'ko < 1', actualValue: 0, outcome: 'passed' },
      ],
    });
    await seedRunStat(latest, 90, { minMs: 5, maxMs: 300 });

    const res = await asSession(PATH);

    expect(res.status).toBe(200);
    const [row] = parse(res.body).items;
    expect(row).toMatchObject({ slug: 'checkout-smoke', runCount: 2 });
    expect(row!.latestRun).toEqual({
      id: latest,
      runNumber: 2,
      status: 'complete',
      verdict: 'passed',
      // The load test's own start, serialised as the contract's Z-suffixed
      // instant — not the instant the run arrived.
      startedAt: '2026-09-02T09:30:00.000Z',
      durationMs: 61_000,
      checks: { failed: 1, total: 2 },
      p95Ms: 90,
    });
    // The history point is the same figure the latest run's own row carries.
    expect(row!.p95History).toEqual([{ runId: latest, runNumber: 2, p95Ms: 90 }]);
  });

  /**
   * THE SPEC'S OWN CASE: "p95History equals the list rows' metrics.p95Ms, a
   * clamped value included". The portfolio and the palette read a test's p95
   * here; the run list reads the same run's from `GET /v1/runs`. A reader
   * moves between the two, so they must be one number — and the run's stored
   * p95 sits ABOVE its own maximum, so a path that skipped the clamp, or
   * joined a different statistics row, would show a different one.
   */
  it('reports the p95 the run list shows for the same run, clamped', async () => {
    const t = await seedTest('checkout-smoke');
    const runId = await seedRun(t.id, '2026-09-02T10:00:00Z', { runNumber: 1 });
    await seedRunStat(runId, 450, { minMs: 5, maxMs: 300 });

    const [row] = parse((await asSession(PATH)).body).items;
    const listed = await asSession(`/v1/runs?project=checkout&test=checkout-smoke`);

    expect(listed.status).toBe(200);
    const run = RunListResponseSchema.parse(listed.body).items.find((r) => r.id === runId);
    // Clamped to the run's own maximum, not the stored 450.
    expect(run?.metrics?.p95Ms).toBe(300);
    expect(row!.latestRun!.p95Ms).toBe(run!.metrics!.p95Ms);
    expect(row!.p95History.at(-1)).toEqual({ runId, runNumber: 1, p95Ms: run!.metrics!.p95Ms });
  });

  it('reports a test that has never run with no latest run and no history', async () => {
    await seedTest('never-ran');

    const [row] = parse((await asSession(PATH)).body).items;

    expect(row).toMatchObject({ slug: 'never-ran', runCount: 0, latestRun: null, p95History: [] });
  });

  it('reports no checks for a run that recorded none, which is not zero of zero', async () => {
    const t = await seedTest('checkout-smoke');
    await seedRun(t.id, '2026-09-02T10:00:00Z');

    const [row] = parse((await asSession(PATH)).body).items;

    expect(row!.latestRun!.checks).toBeNull();
    expect(row!.latestRun!.p95Ms).toBeNull();
  });
});
