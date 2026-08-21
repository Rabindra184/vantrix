import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ErrorsResponseSchema,
  RunListResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
} from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'read-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

async function ingested(extra: Record<string, unknown> = {}): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...extra }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

describe('GET /v1/runs/:id', () => {
  it('rejects a malformed id with 400 and remediation that says what a valid value looks like, not "retry"', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/not-a-uuid').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.remediation).toMatch(/uuid/i);
    // The old failure mode's remediation told the caller to retry — which
    // can never succeed for a malformed id, since the id itself is the
    // problem. Guard against regressing to that shape.
    expect(res.body.remediation.toLowerCase()).not.toContain('retry the request');
  });

  it('serves the tool run header on the run endpoint', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('simulation');
    expect(res.body).toHaveProperty('durationMs');
    expect(res.body.simulation).toBe('example.ParitySimulation');
    expect(res.body.durationMs).toBeGreaterThan(60_000);
  });
});

describe('GET /v1/runs/:id/stats', () => {
  it('rejects a malformed id with 400, not a 500 that leaks a Prisma error', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/not-a-uuid/stats')
      .set(auth());
    expect(res.status).toBe(400);
    expect(res.body.remediation).toMatch(/uuid/i);
  });

  it('returns the run-scope statistics matching the fixture', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(() => StatsResponseSchema.parse(res.body)).not.toThrow();

    const runStat = res.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(runStat.count).toBe(895);
    expect(runStat.okCount).toBe(871);
    expect(runStat.koCount).toBe(24);
    expect(Math.round(runStat.maxMs)).toBe(2503);
  });

  it('reports the indicator bands the Gatling report shows', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
  });

  it('returns indicator bands per row, folded at the project bounds', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.configurable).toBe(true);
    expect(res.body.bounds).toEqual({ lowerMs: 800, higherMs: 1200 });
    const run = res.body.stats.find((s: { scope: string }) => s.scope === 'run');
    expect(run.indicators.under + run.indicators.between + run.indicators.over).toBe(run.okCount);
    expect(run.indicators.failed).toBe(run.koCount);
  });

  // The claim of AC-PARITY-4, end to end: same stored bytes, different settings.
  it('restates history when the project changes its bounds, with no re-ingest', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const before = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats`).set(auth()).expect(200);
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 100, higherMs: 200 }), ctx.projectId],
    );
    const after = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats`).set(auth()).expect(200);
    const pick = (b: { stats: { scope: string; indicators: { under: number } }[] }) =>
      b.stats.find((s) => s.scope === 'run')!.indicators.under;
    expect(pick(after.body)).not.toBe(pick(before.body));
    expect(after.body.bounds).toEqual({ lowerMs: 100, higherMs: 200 });
    // Restore: settings are shared state for the rest of this file, and the
    // case above asserts the 800/1200 defaults.
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 800, higherMs: 1200 }), ctx.projectId],
    );
  });

  // The claim of AC-PARITY-4 / K-03 for percentiles specifically: the sketch
  // is persisted precisely so the percentile columns can be recomputed at any
  // configured set with no re-ingest, exactly like indicators above.
  it('recomputes percentile columns when the project changes its percentile set, with no re-ingest', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const pick = (b: { stats: { scope: string; family: string; percentiles: Record<string, number> }[] }) =>
      b.stats.find((s) => s.scope === 'run' && s.family === 'response_time')!.percentiles;

    const before = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats`).set(auth()).expect(200);
    expect(Object.keys(pick(before.body)).sort()).toEqual(['p50', 'p75', 'p95', 'p99']);

    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{percentiles}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify([90, 99.9]), ctx.projectId],
    );
    const after = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats`).set(auth()).expect(200);
    const afterPercentiles = pick(after.body);
    expect(Object.keys(afterPercentiles).sort()).toEqual(['p90', 'p99.9']);
    // Both keys are guaranteed present by the assertion immediately above,
    // which pins the key set exactly; the assertions carry that through to
    // the types rather than restating it.
    expect(afterPercentiles['p99.9']!).toBeGreaterThanOrEqual(afterPercentiles['p90']!);

    // Restore: settings are shared state for the rest of this file.
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{percentiles}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify([50, 75, 95, 99]), ctx.projectId],
    );
  });

  it('returns an actionable 400, not a 500, when the project has inverted indicator bounds', async () => {
    // No settings-write endpoint validates this yet (Task 12 is the first
    // real reader of the column), so an inverted project misconfiguration is
    // reachable in practice, not just in theory - exercise it directly via SQL.
    ctx = await createTestApp();
    const id = await ingested();

    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 1200, higherMs: 800 }), ctx.projectId],
    );
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_SETTINGS_INVALID');
    expect(res.body.remediation).toMatch(/indicators/i);
    expect(res.body).not.toHaveProperty('stack');

    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 800, higherMs: 1200 }), ctx.projectId],
    );
  });

  it('filters by scope', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats?scope=request`)
      .set(auth());
    expect(res.body.stats.length).toBeGreaterThan(0);
    expect(res.body.stats.every((s: { scope: string }) => s.scope === 'request')).toBe(true);
  });
});

describe('GET /v1/runs/:id/series', () => {
  it('returns buckets that account for every request', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=run&name=`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(() => SeriesResponseSchema.parse(res.body)).not.toThrow();
    expect(
      res.body.buckets.reduce((a: number, b: { startedCount: number }) => a + b.startedCount, 0),
    ).toBe(895);
  });

  it('reports group series as unavailable for a run that has none', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    // The only way to reach this state: this fixture has real group records
    // ('Cart', 'Catalog', 'Catalog/Recommendations'), and the current engine
    // and write pipeline persist group-scope series for every run that has
    // any — there is no gate left to ingest through that skips them. Delete
    // the rows the way a run ingested before that support existed would never
    // have written them, mirroring the startedSplitAvailable pre-migration
    // simulation in parity-endpoints.integration.test.ts.
    await ctx.pool.query(`DELETE FROM run_series_bucket WHERE run_id = $1 AND scope = 'group'`, [id]);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=group&name=Cart&family=group_cumulated`)
      .set(auth());

    expect(res.status).toBe(200);
    // Not "no data" — the run predates group series. An empty bucket array is
    // also what a quiet group returns, which is why this flag exists.
    expect(res.body.groupSeriesAvailable).toBe(false);
    expect(res.body.buckets).toEqual([]);
  });
});

describe('GET /v1/runs/:id/errors', () => {
  it('returns the error table with the fixture counts', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/errors`).set(auth());

    expect(() => ErrorsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
  });
});

describe('GET /v1/projects/:slug/runs', () => {
  it('lists runs newest first and paginates by cursor', async () => {
    ctx = await createTestApp();
    await ingested();
    await ingested();

    const first = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=1')
      .set(auth());
    expect(() => RunListResponseSchema.parse(first.body)).not.toThrow();
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(ctx.app.getHttpServer())
      .get(`/v1/projects/checkout/runs?limit=1&cursor=${first.body.nextCursor}`)
      .set(auth());
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it('orders by the real run start when known, not by upload/ingest order', async () => {
    // A same-value fixture (upload order agrees with tool-start order) would
    // pass under either the old ORDER BY started_at or the new coalesce —
    // this seeds them to DISAGREE so only the new ordering can pass.
    ctx = await createTestApp();

    // Uploaded first, but the load test itself ran later (e.g. a delayed
    // upload of an earlier CI artifact isn't the case here — this is the
    // opposite: prompt upload of a run that started later in wall-clock terms).
    const runA = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'a', bundleSha256: 'a'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-01T10:00:00Z'),
        startedOn: new Date('2026-08-01T00:00:00Z'),
        toolStartedAt: new Date('2026-08-01T20:00:00Z'),
        ingestedAt: new Date('2026-08-01T10:00:05Z'),
        engineOptions: {},
      },
    });

    // Uploaded second (after A), but its own run started earlier than A's.
    const runB = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'b', bundleSha256: 'b'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-01T11:00:00Z'),
        startedOn: new Date('2026-08-01T00:00:00Z'),
        toolStartedAt: new Date('2026-08-01T09:00:00Z'),
        ingestedAt: new Date('2026-08-01T11:00:05Z'),
        engineOptions: {},
      },
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs')
      .set(auth());
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);

    // Upload order (started_at desc) would list B before A.
    // Real-start order (coalesce(tool_started_at, started_at) desc) lists A before B.
    expect(ids.indexOf(runA.id)).toBeLessThan(ids.indexOf(runB.id));
  });

  it('returns each run exactly once across cursor pages under the new ordering', async () => {
    ctx = await createTestApp();

    const seeds: { startedAt: string; toolStartedAt: string | null }[] = [
      { startedAt: '2026-08-01T09:00:00Z', toolStartedAt: '2026-08-01T23:00:00Z' },
      { startedAt: '2026-08-01T10:00:00Z', toolStartedAt: null },
      { startedAt: '2026-08-01T11:00:00Z', toolStartedAt: '2026-08-01T08:00:00Z' },
      { startedAt: '2026-08-01T12:00:00Z', toolStartedAt: '2026-08-01T22:00:00Z' },
      { startedAt: '2026-08-01T13:00:00Z', toolStartedAt: null },
    ];
    const ids: string[] = [];
    for (const [i, s] of seeds.entries()) {
      const run = await ctx.prisma.run.create({
        data: {
          orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
          tool: 'gatling', bundleKey: `k${i}`, bundleSha256: String(i).repeat(64).slice(0, 64),
          bundleBytes: BigInt(1),
          startedAt: new Date(s.startedAt),
          startedOn: new Date(`${s.startedAt.slice(0, 10)}T00:00:00Z`),
          toolStartedAt: s.toolStartedAt ? new Date(s.toolStartedAt) : null,
          ingestedAt: new Date(s.startedAt),
          engineOptions: {},
        },
      });
      ids.push(run.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await request(ctx.app.getHttpServer())
        .get(`/v1/projects/checkout/runs?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(auth());
      expect(res.status).toBe(200);
      for (const item of res.body.items as { id: string }[]) seen.push(item.id);
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(seen.length).toBe(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('refuses a project the token does not belong to', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/some-other-project/runs')
      .set(auth());
    expect(res.status).toBe(404);
  });

  it('clamps a negative limit instead of silently returning zero items', async () => {
    // Math.min(-5, 100) === -5, and Array.prototype.slice(0, -5) on a
    // handful of rows returns [] — a paginating client would read that as
    // "this project has no runs," a silent wrong answer, not an error it
    // could act on. limit=-5 must behave like a sane positive limit instead.
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=-5')
      .set(auth());
    expect(res.status).toBe(200);
    expect(() => RunListResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('clamps limit=0 to at least one item rather than returning an empty page', async () => {
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=0')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('clamps an excessive limit to the 100-item cap instead of passing it through', async () => {
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=99999')
      .set(auth());
    expect(res.status).toBe(200);
    // Only one run was seeded, so this mainly asserts the request succeeds
    // (does not 500 or otherwise choke on an out-of-range limit) — the cap
    // itself is exercised directly in the parseLimit unit coverage.
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe('project identity', () => {
  it('names the run\'s project on both the detail and the list', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const detail = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.project).toEqual({
      id: ctx.projectId,
      slug: 'checkout',
      name: 'Checkout',
    });

    const list = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(list.status).toBe(200);
    const row = list.body.items.find((i: { id: string }) => i.id === runId);
    // Derived from the detail response, not written down a second time: the
    // two shapes must agree, and hard-coding both proves only that this test
    // is self-consistent.
    expect(row.project).toEqual(detail.body.project);
    expect(row.simulation).toBe(detail.body.simulation);
  });
});

describe('GET /v1/runs?project=', () => {
  it('filters to the named project', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=checkout').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(runId);
  });

  it('404s for a slug that does not exist in this org', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?project=no-such-project')
      .set(auth());
    // 404, never an empty 200: an empty 200 would describe a project that
    // exists and happens to be idle, and a caller cannot tell those apart.
    expect(res.status).toBe(404);
  });

  it('404s — not 403 — for a project belonging to another org', async () => {
    ctx = await createTestApp();
    const otherOrg = await ctx.prisma.org.create({
      data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' },
    });
    await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'secret', name: 'Secret', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=secret').set(auth());
    // 403 would confirm the project exists. The status code must not
    // distinguish "no such project" from "not yours".
    expect(res.status).toBe(404);
  });

  it('is identical to omitting the parameter when a token names its own project', async () => {
    ctx = await createTestApp();
    await ingested();
    const withParam = await request(ctx.app.getHttpServer())
      .get('/v1/runs?project=checkout')
      .set(auth());
    const without = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(withParam.body).toEqual(without.body);
  });

  it('400s with PROJECT_MISMATCH when a token names another project', async () => {
    ctx = await createTestApp();
    await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=search').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_MISMATCH');
  });
});

/**
 * The three list filters, on both routes that offer them.
 *
 * THESE ONLY EXIST AT THIS LEVEL. `RunRepository.list` binds every filter as
 * a query parameter, so an unknown status cannot inject — it comes back as
 * an EMPTY PAGE, which a caller reads as "there are no runs like that". A
 * wrong answer with a 200 on it is exactly what a repository test cannot
 * see, and `parseRunListFilters` is the only thing standing between the two.
 */
describe('GET /v1/runs — status, verdict and search filters', () => {
  it('narrows to a status, and to the runs with no verdict yet', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const complete = await request(ctx.app.getHttpServer())
      .get('/v1/runs?status=complete')
      .set(auth());
    expect(complete.status).toBe(200);
    expect(RunListResponseSchema.parse(complete.body).items.map((i) => i.id)).toContain(runId);

    // Derived from the run this test just ingested rather than written down:
    // whatever verdict the pipeline gave it, asking for a DIFFERENT status
    // must not return it.
    const running = await request(ctx.app.getHttpServer())
      .get('/v1/runs?status=running')
      .set(auth());
    expect(running.status).toBe(200);
    expect(running.body.items.map((i: { id: string }) => i.id)).not.toContain(runId);
  });

  it('treats verdict=none as "no verdict recorded", not as a verdict', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    const { verdict } = await ctx.prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: { verdict: true },
    });
    // The fixture must actually HAVE a verdict, or the negative below is
    // vacuous.
    expect(verdict).not.toBeNull();

    const none = await request(ctx.app.getHttpServer()).get('/v1/runs?verdict=none').set(auth());
    expect(none.status).toBe(200);
    expect(none.body.items.map((i: { id: string }) => i.id)).not.toContain(runId);

    const own = await request(ctx.app.getHttpServer())
      .get(`/v1/runs?verdict=${verdict}`)
      .set(auth());
    expect(own.status).toBe(200);
    expect(own.body.items.map((i: { id: string }) => i.id)).toContain(runId);
  });

  it('searches the run’s own words, and the id by prefix only', async () => {
    ctx = await createTestApp();
    const runId = await ingested({ branch: 'release/checkout-v2' });

    const byBranch = await request(ctx.app.getHttpServer())
      .get('/v1/runs?q=checkout-v2')
      .set(auth());
    expect(byBranch.body.items.map((i: { id: string }) => i.id)).toContain(runId);

    const byPrefix = await request(ctx.app.getHttpServer())
      .get(`/v1/runs?q=${runId.slice(0, 8)}`)
      .set(auth());
    expect(byPrefix.body.items.map((i: { id: string }) => i.id)).toContain(runId);

    // A single hex character READ OFF this run's own id. Matched anywhere in
    // the id it would return the run (and, on a real tenant, everything
    // else); matched by prefix it is not an id query at all.
    const noisy = await request(ctx.app.getHttpServer())
      .get(`/v1/runs?q=${runId[14]}`)
      .set(auth());
    expect(noisy.status).toBe(200);
    expect(noisy.body.items.map((i: { id: string }) => i.id)).not.toContain(runId);
  });

  /**
   * 400 WITH A REMEDIATION, never an empty 200. `ProblemFilter`'s fallback
   * ("consult the OpenAPI description") is useless for a request the
   * document describes perfectly, so the code names the value it did not
   * understand and lists the ones it does.
   */
  it('refuses an unknown status and an unknown verdict, on both list routes', async () => {
    ctx = await createTestApp();
    await ingested();

    for (const url of [
      '/v1/runs?status=completed',
      '/v1/runs?verdict=pass',
      '/v1/projects/checkout/runs?status=completed',
      '/v1/projects/checkout/runs?verdict=pass',
    ]) {
      const res = await request(ctx.app.getHttpServer()).get(url).set(auth());
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe('RUN_FILTER_INVALID');
      // The remediation is the actionable half — it must list the values
      // that WOULD work, not say "retry".
      expect(res.body.remediation, url).toMatch(/complete|passed/);
      expect(res.body.remediation, url).not.toMatch(/retry/i);
    }
  });

  it('reads an empty filter as "any", so a form can submit its own controls', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?status=&verdict=&q=')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(runId);
  });

  it('applies the filter before the cursor, not to the page in hand', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    // limit=1 with a filter that excludes the only run must be an EMPTY
    // page, not a page of one filtered down to nothing after the fact.
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?limit=1&q=no-such-simulation-anywhere')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
    expect(runId).toBeTruthy();
  });
});

describe('ingest provenance', () => {
  it('stores environment, branch and commitSha from ingest metadata', async () => {
    ctx = await createTestApp();
    const runId = await ingested({
      environment: 'staging',
      branch: 'release/24.8',
      commitSha: 'abc1234def5678',
    });

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('staging');
    expect(res.body.branch).toBe('release/24.8');
    expect(res.body.commitSha).toBe('abc1234def5678');
  });

  it('reads null, not empty string, for a run that carried none of them', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    // null, never '': an empty string would claim the caller sent an empty
    // branch, which is a different fact from having sent nothing.
    expect(res.body.environment).toBeNull();
    expect(res.body.branch).toBeNull();
    expect(res.body.commitSha).toBeNull();
  });
});
