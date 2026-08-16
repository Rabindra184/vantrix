import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SeriesResponseSchema, StatsResponseSchema, type StatsResponse } from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * `GET /v1/runs/:id/stats?from=&to=` — the statistics table re-aggregated.
 *
 * ═══ EVERY CASE INGESTS FOR REAL ═══
 *
 * The subject is whether the numbers actually change, and they can only change
 * against buckets the engine really wrote. Seeded rows would let every
 * assertion here hold trivially while the write path was broken.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'window-'));
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


const stats = (id: string, query = '') =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats${query}`).set(auth());

const runRowOf = (body: StatsResponse) =>
  body.stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

const seriesOf = async (id: string) =>
  SeriesResponseSchema.parse((await request(ctx.app.getHttpServer())
    .get(`/v1/runs/${id}/series?scope=run&name=&family=response_time`).set(auth())).body);

describe('GET /v1/runs/:id/stats — windowed', () => {
  it('reports no window when none was asked for', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    expect(StatsResponseSchema.parse((await stats(id)).body).window).toBeNull();
  });

  it('a full-extent window reproduces the unwindowed row', async () => {
    // Within RELATIVE_ACCURACY, not exactly: the windowed path merges exact
    // histograms and the unwindowed path reads the 1%-relative sketch. That
    // divergence is designed and documented; this pins its size.
    ctx = await createTestApp();
    const id = await ingested();

    const whole = runRowOf(StatsResponseSchema.parse((await stats(id)).body));
    const windowed = runRowOf(
      StatsResponseSchema.parse((await stats(id, '?from=0&to=2147483647')).body));

    expect(windowed.count).toBe(whole.count);
    expect(windowed.okCount).toBe(whole.okCount);
    expect(windowed.koCount).toBe(whole.koCount);
    expect(windowed.maxMs).toBe(whole.maxMs);
    expect(windowed.minMs).toBe(whole.minMs);
    for (const key of Object.keys(whole.percentiles)) {
      const a = whole.percentiles[key]!;
      const b = windowed.percentiles[key]!;
      expect(Math.abs(a - b) / a, key).toBeLessThanOrEqual(0.01);
    }
  });

  it('a half window reports strictly fewer requests and no larger a max', async () => {
    // The assertion that separates a real re-aggregation from a redrawn axis.
    ctx = await createTestApp();
    const id = await ingested();

    const whole = runRowOf(StatsResponseSchema.parse((await stats(id)).body));
    const series = await seriesOf(id);
    const offsets = series.buckets.map((b) => b.startOffsetMs).sort((a, b) => a - b);
    const half = offsets[Math.floor(offsets.length / 2)]!;

    const body = StatsResponseSchema.parse((await stats(id, `?from=0&to=${half}`)).body);
    const part = runRowOf(body);

    expect(part.count).toBeGreaterThan(0);
    expect(part.count).toBeLessThan(whole.count);
    expect(part.maxMs).toBeLessThanOrEqual(whole.maxMs);
    expect(body.window).not.toBeNull();
    expect(body.window!.bucketWidthMs).toBe(series.bucketWidthMs);
  });

  it('reports the SNAPPED window, not the one asked for', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const width = (await seriesOf(id)).bucketWidthMs;

    // Deliberately off a boundary, by construction.
    const body = StatsResponseSchema.parse(
      (await stats(id, `?from=${width + 1}&to=${width * 3 + 1}`)).body);

    expect(body.window!.fromMs % width).toBe(0);
    expect(body.window!.toMs % width).toBe(0);
    // OUTWARD, so nothing the reader selected falls outside the answer.
    expect(body.window!.fromMs).toBeLessThanOrEqual(width + 1);
    expect(body.window!.toMs).toBeGreaterThanOrEqual(width * 3 + 1);
  });

  it('rejects an inverted or malformed range instead of guessing', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    expect((await stats(id, '?from=500&to=500')).status).toBe(400);
    expect((await stats(id, '?from=900&to=100')).status).toBe(400);
    expect((await stats(id, '?from=-1&to=100')).status).toBe(400);
    expect((await stats(id, '?from=abc&to=100')).status).toBe(400);
  });

  it('honours from alone and to alone, never silently ignoring one', async () => {
    // The `?name=` without `scope` trap, not repeated: each bound is
    // meaningful on its own, and the two halves must partition the run.
    ctx = await createTestApp();
    const id = await ingested();

    const series = await seriesOf(id);
    const offsets = series.buckets.map((b) => b.startOffsetMs).sort((a, b) => a - b);
    const cut = offsets[Math.floor(offsets.length / 2)]!;

    // The whole run through the WINDOWED path, not the unwindowed one.
    // Comparing against `run_stat` would mix two sources — the sketch path and
    // the histogram path — and drag their designed divergence into a test
    // about something else entirely. That equivalence has its own case above;
    // this one is purely about the seam.
    const whole = runRowOf(
      StatsResponseSchema.parse((await stats(id, '?from=0&to=2147483647')).body));
    const head = runRowOf(StatsResponseSchema.parse((await stats(id, `?to=${cut}`)).body));
    const tail = runRowOf(StatsResponseSchema.parse((await stats(id, `?from=${cut}`)).body));

    expect(head.count).toBeGreaterThan(0);
    expect(tail.count).toBeGreaterThan(0);
    // Half-open at the top, so the two halves partition the run exactly —
    // no request counted twice and none dropped at the seam.
    expect(head.count + tail.count).toBe(whole.count);
  });

  it('refuses a window on a run that predates the columns', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query(
      'UPDATE run_series_bucket SET histogram_ok = NULL, histogram_ko = NULL WHERE run_id = $1', [id]);

    const res = await stats(id, '?from=0&to=1000');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINDOW_UNAVAILABLE');
    // And the unwindowed call still works — the run is readable, just not
    // brushable, which is exactly what `windowable` will tell the UI.
    expect((await stats(id)).status).toBe(200);
  });

  it('windows the per-request rows too, not only the run', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const series = await seriesOf(id);
    const offsets = series.buckets.map((b) => b.startOffsetMs).sort((a, b) => a - b);
    const half = offsets[Math.floor(offsets.length / 2)]!;

    const whole = StatsResponseSchema.parse((await stats(id, '?scope=request')).body);
    const part = StatsResponseSchema.parse(
      (await stats(id, `?scope=request&from=0&to=${half}`)).body);

    expect(whole.stats.length).toBeGreaterThan(1);
    const total = (b: StatsResponse) => b.stats.reduce((n, s) => n + s.count, 0);
    expect(total(part)).toBeLessThan(total(whole));
  });
});

describe('the range applies to every time-axis endpoint', () => {
  const windowed = (id: string) => [
    `/v1/runs/${id}/series?scope=run&name=&family=response_time`,
    `/v1/runs/${id}/users`,
    `/v1/runs/${id}/distribution?scope=run&name=`,
    `/v1/runs/${id}/errors/series`,
  ];

  const get = (path: string) =>
    request(ctx.app.getHttpServer()).get(path).set(auth());

  it('reports a snapped window on each of them, and null without one', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const width = (await seriesOf(id)).bucketWidthMs;

    for (const path of windowed(id)) {
      const join = path.includes('?') ? '&' : '?';
      const whole = await get(path);
      const part = await get(`${path}${join}from=0&to=${width * 3}`);

      expect(whole.status, path).toBe(200);
      expect(whole.body.window, path).toBeNull();
      expect(part.status, path).toBe(200);
      expect(part.body.window, path).not.toBeNull();
      expect(part.body.window.bucketWidthMs, path).toBe(width);
    }
  });

  it('actually narrows the payload, rather than only labelling it', async () => {
    // The difference between a window and a decoration.
    ctx = await createTestApp();
    const id = await ingested();
    const width = (await seriesOf(id)).bucketWidthMs;

    const wholeSeries = SeriesResponseSchema.parse((await get(
      `/v1/runs/${id}/series?scope=run&name=&family=response_time`)).body);
    const partSeries = SeriesResponseSchema.parse((await get(
      `/v1/runs/${id}/series?scope=run&name=&family=response_time&from=0&to=${width * 3}`)).body);

    // DERIVED, not written down as 3: a bucket that recorded nothing is
    // absent from the table, so the offsets are not contiguous and the window
    // holds however many of them really fall inside it.
    const expected = wholeSeries.buckets.filter((b) => b.startOffsetMs < width * 3).length;
    expect(wholeSeries.buckets.length).toBeGreaterThan(expected);
    expect(expected).toBeGreaterThan(0);
    expect(partSeries.buckets).toHaveLength(expected);
    // The width is inferred from the WHOLE series, so a narrow window does not
    // mistake its own span for the run's resolution.
    expect(partSeries.bucketWidthMs).toBe(wholeSeries.bucketWidthMs);
  });

  it('refuses a window on a non-windowable run from every endpoint', async () => {
    // The shared guard: forgetting it on one endpoint would let a brushed page
    // show five windowed figures beside one whole-run figure.
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query(
      'UPDATE run_series_bucket SET histogram_ok = NULL, histogram_ko = NULL WHERE run_id = $1', [id]);

    for (const path of windowed(id)) {
      const join = path.includes('?') ? '&' : '?';
      const res = await get(`${path}${join}from=0&to=1000`);
      expect(res.status, path).toBe(400);
      expect(res.body.code, path).toBe('WINDOW_UNAVAILABLE');
    }
  });

  it('leaves the flat errors table whole-run, deliberately', async () => {
    // run_error_bucket is run scope only and holds five messages plus a
    // remainder, against this table's two hundred. A brushed errors table
    // would be a poorer table wearing the same heading — design §6.
    ctx = await createTestApp();
    const id = await ingested();
    const res = await get(`/v1/runs/${id}/errors?scope=run&name=&from=0&to=5000`);
    expect(res.status).toBe(200);
    expect(res.body.window).toBeUndefined();
  });

  it('keeps a windowed distribution consistent with the windowed table', async () => {
    // Two endpoints, one merge path — their counts must agree or the page
    // shows a histogram that disagrees with the row above it.
    ctx = await createTestApp();
    const id = await ingested();
    const width = (await seriesOf(id)).bucketWidthMs;
    const q = `from=0&to=${width * 4}`;

    const dist = (await get(`/v1/runs/${id}/distribution?scope=run&name=&${q}`)).body;
    const table = StatsResponseSchema.parse(
      (await get(`/v1/runs/${id}/stats?scope=run&name=&${q}`)).body);

    const drawn = (dist.okCount as number[]).reduce((a, b) => a + b, 0)
      + (dist.koCount as number[]).reduce((a, b) => a + b, 0);
    expect(drawn).toBe(runRowOf(table).count);
  });
});
