import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-endpoints-'));
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

async function ingested(): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

/**
 * Independent reimplementation of parity.controller.ts's scatter x
 * computation — deliberately NOT importing/calling the controller's own
 * helper, so a bug in that helper can't also be "correct" here. Own and
 * global widths can diverge (each series' BucketSeries coalesces on its own
 * occupied-bucket count), so x for one own bucket is the rate over the
 * WINDOW [ownOffsetMs, ownOffsetMs + ownWidthMs), not a same-offset lookup.
 */
function inferWidthMs(offsets: number[]): number {
  let width = Number.POSITIVE_INFINITY;
  for (let i = 1; i < offsets.length; i++) {
    const gap = (offsets[i] as number) - (offsets[i - 1] as number);
    if (gap > 0 && gap < width) width = gap;
  }
  return Number.isFinite(width) ? width : 1000;
}
function expectedRate(
  ownOffsetMs: number, ownWidthMs: number, globalBuckets: { startOffsetMs: number; startedCount: number }[],
): number {
  let sum = 0;
  for (const g of globalBuckets) {
    if (g.startOffsetMs >= ownOffsetMs && g.startOffsetMs < ownOffsetMs + ownWidthMs) sum += g.startedCount;
  }
  return Math.round((sum / ownWidthMs) * 1000);
}

describe('GET /v1/runs/:id/distribution, /users, /scatter', () => {
  it('serves a Gatling-shaped distribution', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`)
      .set(auth())
      .expect(200);
    expect(res.body.labels.length).toBe(100);
    expect(res.body.overflowCount).toBe(0);
    const sum = [...res.body.okPercent, ...res.body.koPercent].reduce(
      (a: number, b: number) => a + b, 0,
    );
    expect(sum).toBeCloseTo(100, 6);
  });

  it('serves per-scenario users plus a summed total', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/users`)
      .set(auth())
      .expect(200);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
    const first = res.body.total[0];
    const perScenario = res.body.scenarios
      .map((s: { buckets: { startOffsetMs: number; maxConcurrent: number }[] }) =>
        s.buckets.find((b) => b.startOffsetMs === first.startOffsetMs)?.maxConcurrent ?? 0)
      .reduce((a: number, b: number) => a + b, 0);
    expect(first.maxConcurrent).toBe(perScenario);
  });

  // 'List Products' is one of the seven real request names the reference
  // fixture actually produces (see packages/plugin-gatling/test/records.test.ts) —
  // not the brief's placeholder 'Catalog / List', which does not exist here.
  it('serves the scatter as one point per bucket with a truncated p95', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    const name = 'List Products';

    const [ownSeries, globalSeries, res] = await Promise.all([
      request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/series?scope=request&name=${encodeURIComponent(name)}`).set(auth()).expect(200),
      request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/series?scope=run&name=`).set(auth()).expect(200),
      request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent(name)}`).set(auth()).expect(200),
    ]);
    expect(res.body.ok.length).toBeGreaterThan(0);
    for (const [x, y] of res.body.ok) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }

    // x pinned to a real value, independently derived from the two series the
    // scatter is built from — not merely "is an integer", which stays green
    // even if the rate computation is replaced with a constant.
    const ownBucket = ownSeries.body.buckets.find(
      (b: { percentilesOk: Record<string, number> }) => b.percentilesOk.p95 !== undefined,
    );
    expect(ownBucket).toBeDefined();
    const ownWidthMs = inferWidthMs(ownSeries.body.buckets.map((b: { startOffsetMs: number }) => b.startOffsetMs));
    const expectedX = expectedRate(ownBucket.startOffsetMs, ownWidthMs, globalSeries.body.buckets);
    expect(res.body.ok).toContainEqual([expectedX, Math.trunc(ownBucket.percentilesOk.p95)]);
  });

  it('emits an OK and a KO scatter point for a bucket containing both', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const stats = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats?scope=request`).set('Authorization', `Bearer ${ctx.readToken}`).expect(200);
    const failing = stats.body.stats.find((s: { koCount: number }) => s.koCount > 0);
    expect(failing).toBeDefined();
    const r = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent(failing.name)}`)
      .set('Authorization', `Bearer ${ctx.readToken}`).expect(200);
    expect(r.body.ko.length).toBeGreaterThan(0);
    expect(r.body.ok.length).toBeGreaterThan(0);

    // Strengthens the two checks above into a real regression guard: Gatling
    // emits one KO point per bucket that has any failures at all (see
    // parity.controller.ts's scatter loop), so the count must match exactly,
    // not merely be non-zero. A single-series routing bug (a bucket with both
    // statuses landing entirely on one series) still leaves `ko.length > 0`
    // here — this fixture's failing endpoint has bucket-level failures spread
    // across multiple 1s buckets, some of which are all-KO — so the weaker
    // assertion above does not, by itself, catch that regression.
    const series = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=request&name=${encodeURIComponent(failing.name)}`)
      .set('Authorization', `Bearer ${ctx.readToken}`).expect(200);
    const koBucketCount = series.body.buckets.filter((b: { koCount: number }) => b.koCount > 0).length;
    expect(r.body.ko.length).toBe(koBucketCount);
  });

  it('reports the bucket width, so a client never assumes 1000ms', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=run&name=`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.bucketWidthMs).toBe(1000);

    // The width must be the SMALLEST positive gap, not the first: a bucket with
    // no observations is absent, so consecutive offsets can be two widths apart.
    const offsets: number[] = res.body.buckets.map((b: { startOffsetMs: number }) => b.startOffsetMs);
    const gaps = offsets.slice(1).map((o, i) => o - (offsets[i] as number)).filter((g) => g > 0);
    expect(res.body.bucketWidthMs).toBe(Math.min(...gaps));
  });

  it('splits started requests by outcome, and the split sums to startedCount', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const [res, stats] = await Promise.all([
      request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/series?scope=run&name=`)
        .set('Authorization', `Bearer ${ctx.readToken}`),
      request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/stats?scope=run&name=&family=response_time`)
        .set('Authorization', `Bearer ${ctx.readToken}`).expect(200),
    ]);

    expect(res.body.startedSplitAvailable).toBe(true);
    const buckets = res.body.buckets as {
      startedCount: number; endedCount: number; koCount: number;
      startedOkCount: number; startedKoCount: number;
    }[];
    for (const b of buckets) {
      expect(b.startedOkCount + b.startedKoCount).toBe(b.startedCount);
    }

    // The sum invariant above is what discriminates the START edge from the
    // END edge on THIS fixture: 33 of its 62 run-scope buckets have
    // startedCount != endedCount, so a split recorded on the end edge sums to
    // the wrong total in every one of them. Asserted explicitly, because the
    // invariant is only load-bearing while that remains true — if the fixture
    // ever changed to one where every request starts and ends in the same
    // bucket, the loop above would pass against an end-edge implementation and
    // this line is what would say so.
    expect(buckets.filter((b) => b.startedCount !== b.endedCount).length).toBeGreaterThan(0);

    // The sum invariant alone cannot see a split that routes every request to
    // startedOkCount: 0 + startedCount == startedCount holds just as well.
    // Pin the KO magnitude against a DIFFERENT endpoint's total instead.
    const runStat = (stats.body.stats as { koCount: number }[])[0];
    expect(runStat!.koCount).toBeGreaterThan(0);
    expect(buckets.reduce((n, b) => n + b.startedKoCount, 0)).toBe(runStat!.koCount);
    expect(buckets.filter((b) => b.startedKoCount > 0).length).toBeGreaterThan(0);
  });

  it('reports a pre-migration run as unavailable, reading NULL through as null', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    // The only way to reach this state: every run the current engine ingests
    // carries the split, so the null path is unreachable through the API.
    // Blank the columns the way a row written before the migration would be.
    await ctx.pool.query(
      'UPDATE run_series_bucket SET started_ok_count = NULL, started_ko_count = NULL WHERE run_id = $1',
      [runId],
    );

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=run&name=`)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(200);

    // This is the one assertion standing between a pre-migration run and two
    // flat zero lines that would read as "no failures" rather than "not
    // recorded". Adding `?? 0` anywhere on the read path turns it red.
    expect(res.body.startedSplitAvailable).toBe(false);
    expect(res.body.buckets[0].startedOkCount).toBeNull();
    expect(res.body.buckets[0].startedKoCount).toBeNull();
  });

  it('404s for a run in another project', async () => {
    ctx = await createTestApp();

    // A run that exists, but not in ctx's org/project — created directly via
    // Prisma (as read.integration.test.ts's cursor-ordering tests do) rather
    // than a second createTestApp(), which would TRUNCATE the tables this
    // test's own ctx just populated.
    const otherOrg = await ctx.prisma.org.create({ data: { slug: 'other-org', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'other-project', name: 'Other Project' },
    });
    const otherRun = await ctx.prisma.run.create({
      data: {
        orgId: otherOrg.id, projectId: otherProject.id, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'other', bundleSha256: 'f'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date(), startedOn: new Date(), ingestedAt: new Date(), engineOptions: {},
      },
    });

    await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${otherRun.id}/distribution?scope=run&name=&family=response_time`)
      .set(auth())
      .expect(404);
  });
});
