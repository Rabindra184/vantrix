import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SeriesResponseSchema,
  StatsResponseSchema,
  type SeriesResponse,
  type StatsResponse,
} from '@perfportal/contracts';
import { Histogram, mergedHistogram } from '@perfportal/statistics';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * `GET /v1/runs/:id/stats?percentiles=` — Compare asks for ranks the project
 * never configured (p90, p99.9, p99.99), and every one is answered from the
 * stored histograms rather than guessed.
 *
 * ═══ THE EXPECTATION IS COMPUTED BESIDE THE ENDPOINT, NOT THROUGH IT ═══
 *
 * Each expected rank is read out of `run_stat` / `run_series_bucket` with raw
 * SQL and the histogram's own `percentiles`, so a controller that threaded the
 * wrong set (or the project's) through `storedPercentiles` cannot agree with
 * itself here. Ingested for real, as `window.integration.test.ts` does, so
 * the histograms are the ones the engine actually wrote.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-percentiles-'));
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

const parsed = async (id: string, query = ''): Promise<StatsResponse> => {
  const res = await stats(id, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return StatsResponseSchema.parse(res.body);
};

const runRowOf = (body: StatsResponse) =>
  body.stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

const keyOf = (r: { scope: string; name: string; family: string }) => `${r.scope}/${r.name}/${r.family}`;

const fromBytes = (b: Buffer) => Histogram.deserialize(new Uint8Array(b));

describe('GET /v1/runs/:id/stats?percentiles=', () => {
  it("answers p99.9 for the run row equal to the histogram's own nearest rank", async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const stored = await ctx.pool.query<{
      scope: string; name: string; family: string; histogram_ok: Buffer; histogram_ko: Buffer;
    }>(`SELECT scope, name, family, histogram_ok, histogram_ko FROM run_stat WHERE run_id = $1`, [id]);
    expect(stored.rows.length).toBeGreaterThan(3);

    const body = await parsed(id, '?percentiles=99.9');
    const served = new Map(body.stats.map((s) => [keyOf(s), s.percentiles]));
    expect(served.size).toBe(stored.rows.length);

    // EVERY row, not only the run's: a set threaded into one branch and not
    // another would otherwise pass on the run row alone.
    for (const row of stored.rows) {
      const ok = fromBytes(row.histogram_ok);
      const ko = fromBytes(row.histogram_ko);
      expect(ok.exact && ko.exact, keyOf(row)).toBe(true);
      const [expected] = mergedHistogram(ok, ko).percentiles([99.9]);
      expect(served.get(keyOf(row)), keyOf(row)).toEqual({ 'p99.9': expected });
    }

    // The project's own set (p50/p75/p95/p99) is REPLACED, not joined.
    expect(runRowOf(body).percentiles).not.toHaveProperty('p95');
  });

  it('answers exactly the requested ranks, under their existing key spelling', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const row = runRowOf(await parsed(id, '?percentiles=99.99,90,99.9'));
    expect(Object.keys(row.percentiles).sort()).toEqual(['p90', 'p99.9', 'p99.99']);
  });

  it('leaves every other field identical', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const plain = await parsed(id);
    const ranked = await parsed(id, '?percentiles=90,99.9,99.99');

    const strip = (body: StatsResponse) => ({
      ...body,
      stats: body.stats.map((row) => ({ ...row, percentiles: null })),
    });
    expect(strip(ranked)).toEqual(strip(plain));
    // A vacuity guard: the comparison above must have had rows to compare.
    expect(plain.stats.length).toBeGreaterThan(3);
  });

  it('applies to a windowed read', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const body = await parsed(id, '?from=10000&to=40000&percentiles=90');
    expect(body.window).not.toBeNull();
    const row = runRowOf(body);

    // The windowed rollup's own p90, merged from the same buckets the
    // selection takes (`start_offset_ms >= from AND < to`).
    const buckets = await ctx.pool.query<{ histogram_ok: Buffer | null; histogram_ko: Buffer | null }>(
      `SELECT histogram_ok, histogram_ko FROM run_series_bucket
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time' AND name = ''
          AND start_offset_ms >= 10000 AND start_offset_ms < 40000`,
      [id],
    );
    expect(buckets.rows.length).toBeGreaterThan(5);
    const all = new Histogram();
    for (const b of buckets.rows) {
      if (b.histogram_ok) all.merge(fromBytes(b.histogram_ok));
      if (b.histogram_ko) all.merge(fromBytes(b.histogram_ko));
    }
    expect(all.total).toBe(row.count);
    const [p90] = all.percentiles([90]);

    expect(row.percentiles).toEqual({ p90 });
  });

  /**
   * A legacy estimated row has no histogram left to recompute from, so a
   * requested rank it never stored is OMITTED — never zero, never
   * interpolated — while one it did store is still answered. Flipped the way
   * `read.integration.test.ts`' legacy case flips it.
   */
  it('omits a rank an estimated row never stored', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query(
      `UPDATE run SET stats_method = 'estimated', recompute_error = 'raw_log_missing' WHERE id = $1`, [id]);
    await ctx.pool.query(
      `UPDATE run_stat
          SET histogram_kind = 'sparse-ms-v1', histogram_ok = $2, histogram_ko = $3,
              percentiles = $4::jsonb
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [id, Buffer.from(Histogram.legacyV1ForTests([100, 200, 300])), Buffer.from(Histogram.legacyV1ForTests([])),
       JSON.stringify({ p50: 205.5, p75: 300.25, p95: 412 })],
    );

    const row = runRowOf(await parsed(id, '?percentiles=50,99.9'));
    expect(row.percentiles).toEqual({ p50: 205.5 });
    expect(row.percentiles).not.toHaveProperty('p99.9');
  });

  it('refuses a malformed list', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    for (const query of ['?percentiles=0', '?percentiles=90&percentiles=95', '?percentiles=50,']) {
      const res = await stats(id, query);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe('INVALID_QUERY');
      expect(res.body.detail, query).toContain('percentiles');
    }
  });
});

/**
 * `GET /v1/runs/:id/series?percentiles=` — each bucket gains the requested
 * ranks beside the ones it stored, from that bucket's own OK and KO
 * histograms. The expectation is again read out of `run_series_bucket` by raw
 * SQL and computed with the histogram's own `percentiles`, never through the
 * endpoint.
 */
describe('GET /v1/runs/:id/series?percentiles=', () => {
  const series = (id: string, query = '') =>
    request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/series${query}`).set(auth());

  const parsedSeries = async (id: string, query = ''): Promise<SeriesResponse> => {
    const res = await series(id, query);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return SeriesResponseSchema.parse(res.body);
  };

  /** Each stored bucket's two histograms, keyed by start offset. */
  async function storedBuckets(id: string, scope: string, name: string) {
    const { rows } = await ctx.pool.query<{
      start_offset_ms: number; histogram_ok: Buffer; histogram_ko: Buffer;
    }>(
      `SELECT start_offset_ms, histogram_ok, histogram_ko FROM run_series_bucket
        WHERE run_id = $1 AND scope = $2 AND name = $3 AND family = 'response_time'
        ORDER BY start_offset_ms`,
      [id, scope, name],
    );
    return new Map(rows.map((r) => [r.start_offset_ms, { ok: fromBytes(r.histogram_ok), ko: fromBytes(r.histogram_ko) }]));
  }

  /** The rank a histogram answers, as the map entry it should produce: absent when empty. */
  const entry = (h: Histogram, p: number) => {
    const [v] = h.percentiles([p]);
    return v === undefined ? {} : { [`p${p}`]: v };
  };

  const pick = (map: Record<string, number>, key: string) =>
    key in map ? { [key]: map[key] } : {};

  it('adds p99.9 to every bucket from its own histograms', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const stored = await storedBuckets(id, 'run', '');
    const body = await parsedSeries(id, '?percentiles=99.9');
    expect(body.buckets.length).toBeGreaterThan(5);
    expect(body.buckets.map((b) => b.startOffsetMs)).toEqual([...stored.keys()]);

    for (const b of body.buckets) {
      const h = stored.get(b.startOffsetMs)!;
      expect(h.ok.exact && h.ko.exact, String(b.startOffsetMs)).toBe(true);
      const [all] = mergedHistogram(h.ok, h.ko).percentiles([99.9]);
      expect(b.percentiles['p99.9'], String(b.startOffsetMs)).toBe(all);
      expect(pick(b.percentilesOk, 'p99.9'), String(b.startOffsetMs)).toEqual(entry(h.ok, 99.9));
      expect(pick(b.percentilesKo, 'p99.9'), String(b.startOffsetMs)).toEqual(entry(h.ko, 99.9));
    }
    // Vacuity: the KO map must have been exercised by some bucket.
    expect(body.buckets.some((b) => 'p99.9' in b.percentilesKo)).toBe(true);
    // The run's last second only ENDS a request; a bucket that started none
    // has an empty population and gains no rank — not a 0.
    const empty = body.buckets.filter((b) => b.startedCount === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const b of empty) expect(b.percentiles, String(b.startOffsetMs)).not.toHaveProperty('p99.9');
  });

  it('keeps the stored p95 byte-identical', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const plain = await parsedSeries(id);
    const ranked = await parsedSeries(id, '?percentiles=95,99.9');

    const strip = (m: Record<string, number>) =>
      Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'p99.9'));
    const stripAll = (body: SeriesResponse) => ({
      ...body,
      buckets: body.buckets.map((b) => ({
        ...b,
        percentiles: strip(b.percentiles),
        percentilesOk: strip(b.percentilesOk),
        percentilesKo: strip(b.percentilesKo),
      })),
    });
    expect(stripAll(ranked)).toEqual(stripAll(plain));
    expect(plain.buckets.length).toBeGreaterThan(5);
    // Buckets that started a request (an empty one stores no rank at all).
    const started = (body: SeriesResponse) => body.buckets.filter((b) => b.startedCount > 0);
    expect(started(plain).every((b) => typeof b.percentiles['p95'] === 'number')).toBe(true);
    // And the extra rank is really there, so the comparison above stripped something.
    expect(started(ranked).every((b) => typeof b.percentiles['p99.9'] === 'number')).toBe(true);
  });

  it('a window past the run end clamps', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const whole = await parsedSeries(id, '?percentiles=99.9');
    const windowed = await parsedSeries(id, '?from=0&to=999999&percentiles=99.9');
    expect(windowed.window).not.toBeNull();
    expect(windowed.buckets.map((b) => b.startOffsetMs)).toEqual(whole.buckets.map((b) => b.startOffsetMs));
    expect(windowed.buckets).toEqual(whole.buckets);
    expect(windowed.buckets.filter((b) => b.startedCount > 0).every((b) => 'p99.9' in b.percentiles)).toBe(true);
  });

  it('a failed-only bucket has KO ranks and no OK rank', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    // Place Order fails outright in some seconds of the reference run.
    const stored = await storedBuckets(id, 'request', 'Place Order');
    const failedOnly = [...stored].filter(([, h]) => h.ok.total === 0 && h.ko.total > 0).map(([o]) => o);
    expect(failedOnly.length).toBeGreaterThan(0);

    const body = await parsedSeries(id, `?scope=request&name=${encodeURIComponent('Place Order')}&percentiles=99.9`);
    for (const offset of failedOnly) {
      const b = body.buckets.find((x) => x.startOffsetMs === offset)!;
      expect(b.percentilesKo['p99.9'], String(offset)).toBe(stored.get(offset)!.ko.percentiles([99.9])[0]);
      expect(b.percentilesOk, String(offset)).not.toHaveProperty('p99.9');
      expect(b.percentiles['p99.9'], String(offset)).toBe(b.percentilesKo['p99.9']);
    }
    // And a mixed or OK bucket of the same series DOES get an OK rank.
    expect(body.buckets.some((b) => 'p99.9' in b.percentilesOk)).toBe(true);
  });

  it('adds no rank to a bucket whose histograms are not exact', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const stored = await storedBuckets(id, 'run', '');
    const legacy = [...stored.keys()][1]!;
    await ctx.pool.query(
      `UPDATE run_series_bucket SET histogram_ok = $2, histogram_ko = $3
        WHERE run_id = $1 AND scope = 'run' AND name = '' AND family = 'response_time' AND start_offset_ms = $4`,
      [id, Buffer.from(Histogram.legacyV1ForTests([100, 200, 300])), Buffer.from(Histogram.legacyV1ForTests([])), legacy],
    );

    const body = await parsedSeries(id, '?percentiles=99.9');
    const b = body.buckets.find((x) => x.startOffsetMs === legacy)!;
    expect(b.percentiles).not.toHaveProperty('p99.9');
    expect(b.percentilesOk).not.toHaveProperty('p99.9');
    expect(b.percentilesKo).not.toHaveProperty('p99.9');
    // Its stored ranks survive, and every other bucket still gains the rank.
    expect(typeof b.percentiles['p95']).toBe('number');
    expect(
      body.buckets
        .filter((x) => x.startOffsetMs !== legacy && x.startedCount > 0)
        .every((x) => 'p99.9' in x.percentiles),
    ).toBe(true);
  });

  it('refuses a malformed list', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    for (const query of ['?percentiles=100', '?percentiles=90&percentiles=95', '?percentiles=,']) {
      const res = await series(id, query);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe('INVALID_QUERY');
      expect(res.body.detail, query).toContain('percentiles');
    }
  });
});
