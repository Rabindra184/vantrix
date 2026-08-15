import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorSeriesResponseSchema, SeriesResponseSchema } from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * `GET /v1/runs/:id/errors/series` — a run's failures on a time axis.
 *
 * ═══ EVERY CASE INGESTS FOR REAL ═══
 *
 * Unlike the trends suite, which seeds `run` rows directly because its subject
 * is a WHERE clause, this endpoint's subject is data the ingest pipeline
 * produces. Its two load-bearing properties — that the bucket width matches
 * `/series`, and that the counts reconcile with `koCount` — are only meaningful
 * against buckets the engine really wrote. Seeded rows would let both hold
 * trivially while the write path was broken.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'error-series-'));
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

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

async function ingested(): Promise<string> {
  const q = new Queue('ingest', {
    connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' },
  });
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

const errorSeries = (id: string) =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/errors/series`).set(auth());

const runSeries = (id: string) =>
  request(ctx.app.getHttpServer())
    .get(`/v1/runs/${id}/series?scope=run&name=&family=response_time`)
    .set(auth());

describe('GET /v1/runs/:id/errors/series', () => {
  it('serves at most five named series plus the folded remainder', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.series.filter((s) => s.message !== null).length).toBeLessThanOrEqual(5);
    expect(body.series.length).toBeLessThanOrEqual(6);
    expect(body.available).toBe(true);
    // The reference bundle really does fail, so this is not vacuous.
    expect(body.series.length).toBeGreaterThan(0);
  });

  it('reports the same bucket width as /series for the same run', async () => {
    // Derived from the other endpoint, never written down. This alignment is
    // what the whole design exists for: two charts on one page at one
    // resolution.
    ctx = await createTestApp();
    const id = await ingested();

    const series = SeriesResponseSchema.parse((await runSeries(id)).body);
    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.bucketWidthMs).toBe(series.bucketWidthMs);
  });

  it('reconciles with the run series koCount, bucket by bucket', async () => {
    // The invariant the end-edge feed buys, and the reason failures are
    // bucketed at endMs rather than startMs.
    ctx = await createTestApp();
    const id = await ingested();

    const series = SeriesResponseSchema.parse((await runSeries(id)).body);
    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);

    const drawn = new Map<number, number>();
    for (const s of body.series) {
      for (const p of s.points) {
        drawn.set(p.startOffsetMs, (drawn.get(p.startOffsetMs) ?? 0) + p.count);
      }
    }
    for (const bucket of series.buckets) {
      expect(drawn.get(bucket.startOffsetMs) ?? 0).toBe(bucket.koCount);
    }
    // And the run really has failures to reconcile, so the loop above is not
    // comparing zero against zero throughout.
    expect(series.buckets.reduce((n, b) => n + b.koCount, 0)).toBeGreaterThan(0);
  });

  it('totals agree with the flat errors table when there is no warm-up', async () => {
    // The engine's default warmupMs is 0, so the two surfaces must agree
    // exactly here. They diverge only when a project configures a warm-up
    // window, because series include it and the flat rollup does not.
    ctx = await createTestApp();
    const id = await ingested();

    const flat = (await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/errors?scope=run&name=`)
      .set(auth())).body as { errors: { count: number }[] };
    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);

    expect(body.series.reduce((n, s) => n + s.total, 0)).toBe(
      flat.errors.reduce((n, e) => n + e.count, 0),
    );
  });

  it('reports NOT available when flat errors exist and bucket rows do not', async () => {
    // Exactly the state a run ingested before this migration is in: the flat
    // errors table has its rows, this table has none. An empty chart with no
    // explanation would claim the run succeeded.
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query('DELETE FROM run_error_bucket WHERE run_id = $1', [id]);

    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.available).toBe(false);
    expect(body.series).toEqual([]);
  });

  it('reports a placeholder width for a run with no failures, and draws nothing', async () => {
    // A run with no failures has no rows, and the width lives ON the rows — so
    // there is nowhere to carry it and the endpoint reports 1000 even where
    // /series reports more. Pinned rather than fixed: `series` is empty in this
    // state, so nothing is scaled by the number and nothing is drawn wrong.
    //
    // Deleting BOTH tables is what makes this a clean run rather than a
    // pre-migration one — the case above deletes only the bucket rows, and the
    // difference between the two is exactly what `available` reports.
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query('DELETE FROM run_error_bucket WHERE run_id = $1', [id]);
    await ctx.pool.query('DELETE FROM run_error WHERE run_id = $1', [id]);

    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.available).toBe(true);
    expect(body.series).toEqual([]);
    expect(body.bucketWidthMs).toBe(1000);
  });

  it('404s for a run in another org', async () => {
    // 404, never 403: the status must not distinguish "no such run" from "not
    // yours", exactly as the sibling routes already reason about.
    ctx = await createTestApp();
    const theirRun = randomUUID();
    const other = await ctx.prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'p', name: 'P', settings: {} },
    });
    await ctx.prisma.run.create({
      data: {
        id: theirRun,
        orgId: other.id,
        projectId: otherProject.id,
        status: 'complete',
        tool: 'gatling',
        startedAt: new Date('2026-08-02T10:00:00Z'),
        startedOn: new Date('2026-08-02T10:00:00Z'),
        bundleKey: `k/${theirRun}`,
        bundleSha256: 'y'.repeat(64),
        bundleBytes: BigInt(1),
        engineOptions: {},
      },
    });

    expect((await errorSeries(theirRun)).status).toBe(404);
  });
});
