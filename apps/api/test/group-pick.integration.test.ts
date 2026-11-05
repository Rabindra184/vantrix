import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DistributionResponseSchema,
  SeriesResponseSchema,
  type DistributionResponse,
  type SeriesResponse,
} from '@perfportal/contracts';
import type { RequestEvent } from '@perfportal/core';
import { Histogram, distribution } from '@perfportal/statistics';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';
// Relative cross-package import, the precedent parity.e2e.test.ts sets:
// apps/api does not depend on plugin-gatling, and a test-only decode of the
// reference log is not a reason to add one.
import { parseSimulationLog } from '../../../packages/plugin-gatling/src/records.js';

/**
 * `group` on `GET /v1/runs/{id}/series` and `/distribution` — a group's
 * requests merged into one series and one distribution (the Report pickers
 * spec, section 4).
 *
 * ═══ THE ORACLE IS THE RUN'S OWN LOG, NOT THE STORED ROWS ═══
 *
 * Every expectation below is computed in this file from the reference bundle's
 * `simulation.log`, decoded with `parseSimulationLog` and bucketed here by each
 * request's start offset from the run header — never from `run_series_bucket`
 * or `run_stat`, which are what the endpoint reads. A merge that dropped a
 * member, double-counted one, or bucketed at the wrong width cannot agree with
 * itself through the oracle the way it could through its own inputs.
 *
 * Membership in the oracle is read off each request's GROUPS ARRAY
 * (`groups[0] === 'Cart'`), not off the joined name the endpoint matches by
 * prefix, so the two sides decide "is this request in Cart" two different ways.
 *
 * ONE INGEST FOR THE FILE. The cases that mutate a stored histogram restore it
 * in a `finally`, and the mixed-width case seeds a run of its own.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let ctx: TestContext;
let runId: string;
let requests: RequestEvent[];
let runStartMs: number;

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });
const get = (path: string) => request(ctx.app.getHttpServer()).get(path).set(auth());

beforeAll(async () => {
  const log = readFileSync(FIXTURE_LOG);
  requests = [];
  runStartMs = Number.NaN;
  for (const e of parseSimulationLog(log)) {
    if (e.type === 'meta') runStartMs = e.startedAtMs;
    if (e.type === 'request') requests.push(e);
  }

  const dir = mkdtempSync(join(tmpdir(), 'group-pick-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);

  ctx = await createTestApp();
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', readFileSync(out), 'bundle.tgz');
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  runId = res.body.id;
  await runPipelineFor(ctx, runId);
  const done = await get(`/v1/runs/${runId}`);
  expect(done.body.status, JSON.stringify(done.body)).toBe('complete');
}, 240_000);

afterAll(async () => {
  await ctx?.close();
});

// ─── the oracle ─────────────────────────────────────────────────────────────

type Pick = (r: RequestEvent) => boolean;
const inCart: Pick = (r) => r.groups[0] === 'Cart';
const inCatalog: Pick = (r) => r.groups[0] === 'Catalog';
const inNoGroup: Pick = (r) => r.groups.length === 0;

const WIDTH = 1000;
const durationOf = (r: RequestEvent) => Math.max(0, r.endMs - r.startMs);
const bucketOf = (ts: number) => Math.floor((ts - runStartMs) / WIDTH) * WIDTH;

/** Nearest rank, on integers: the value at 1-based position ceil(p/100 * n). */
function nearestRank(sorted: readonly number[], pTimes10: number): number | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  const rank = Math.max(1, Math.ceil((pTimes10 * n) / 1000));
  return sorted[Math.min(n, rank) - 1];
}

interface OracleBucket {
  startOffsetMs: number;
  startedCount: number;
  startedOkCount: number;
  startedKoCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  minMs: number;
  maxMs: number;
  p95: number | undefined;
  p999: number | undefined;
}

/** Per 1000 ms bucket: the start edge (counts and every latency figure) and the end edge (ended counts). */
function oracleSeries(pick: Pick, range: { fromMs: number; toMs: number } | null = null): OracleBucket[] {
  const starts = new Map<number, number[]>();
  const okStarts = new Map<number, number>();
  const ends = new Map<number, { ok: number; ko: number }>();
  for (const r of requests.filter(pick)) {
    const s = bucketOf(r.startMs);
    const list = starts.get(s) ?? [];
    list.push(durationOf(r));
    starts.set(s, list);
    if (r.ok) okStarts.set(s, (okStarts.get(s) ?? 0) + 1);
    const e = bucketOf(r.endMs);
    const end = ends.get(e) ?? { ok: 0, ko: 0 };
    if (r.ok) end.ok += 1; else end.ko += 1;
    ends.set(e, end);
  }
  const offsets = [...new Set([...starts.keys(), ...ends.keys()])].sort((a, b) => a - b);
  return offsets
    .filter((o) => range === null || (o >= range.fromMs && o < range.toMs))
    .map((o) => {
      const durations = [...(starts.get(o) ?? [])].sort((a, b) => a - b);
      const end = ends.get(o) ?? { ok: 0, ko: 0 };
      return {
        startOffsetMs: o,
        startedCount: durations.length,
        startedOkCount: okStarts.get(o) ?? 0,
        startedKoCount: durations.length - (okStarts.get(o) ?? 0),
        endedCount: end.ok + end.ko,
        okCount: end.ok,
        koCount: end.ko,
        // An empty start edge stores 0, as bucketLatency writes it.
        minMs: durations[0] ?? 0,
        maxMs: durations[durations.length - 1] ?? 0,
        p95: nearestRank(durations, 950),
        p999: nearestRank(durations, 999),
      };
    });
}

/** The same requests' histograms, filled from the log, folded by the product's own binning. */
function oracleDistribution(pick: Pick, range: { fromMs: number; toMs: number } | null = null) {
  const ok = new Histogram();
  const ko = new Histogram();
  let okN = 0;
  let koN = 0;
  for (const r of requests.filter(pick)) {
    const s = bucketOf(r.startMs);
    if (range !== null && !(s >= range.fromMs && s < range.toMs)) continue;
    if (r.ok) { ok.accept(durationOf(r)); okN += 1; } else { ko.accept(durationOf(r)); koN += 1; }
  }
  return { bins: distribution(ok, ko), okN, koN };
}

function expectSeriesEqualsOracle(body: SeriesResponse, oracle: OracleBucket[]): void {
  expect(oracle.length, 'the oracle selected no buckets — the predicate has rotted').toBeGreaterThan(3);
  expect(body.bucketWidthMs, 'the oracle buckets at 1000 ms; a coalesced member would need another').toBe(WIDTH);
  expect(body.buckets.map((b) => b.startOffsetMs)).toEqual(oracle.map((b) => b.startOffsetMs));
  for (const [i, want] of oracle.entries()) {
    const got = body.buckets[i]!;
    const at = `bucket ${want.startOffsetMs}`;
    expect({
      startedCount: got.startedCount,
      startedOkCount: got.startedOkCount,
      startedKoCount: got.startedKoCount,
      endedCount: got.endedCount,
      okCount: got.okCount,
      koCount: got.koCount,
      minMs: got.minMs,
      maxMs: got.maxMs,
      p95: got.percentiles['p95'],
    }, at).toEqual({
      startedCount: want.startedCount,
      startedOkCount: want.startedOkCount,
      startedKoCount: want.startedKoCount,
      endedCount: want.endedCount,
      okCount: want.okCount,
      koCount: want.koCount,
      minMs: want.minMs,
      maxMs: want.maxMs,
      p95: want.p95,
    });
  }
}

async function groupSeries(group: string, query = ''): Promise<SeriesResponse & { group?: string | null }> {
  const res = await get(
    `/v1/runs/${runId}/series?scope=request&group=${encodeURIComponent(group)}&family=response_time${query}`,
  );
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  // The echo, read off the raw body as well as the parse: a schema that did
  // not declare `group` would strip it and every check below would still pass.
  expect(res.body.group).toBe(group);
  return SeriesResponseSchema.parse(res.body);
}

async function groupDistribution(group: string, query = ''): Promise<DistributionResponse> {
  const res = await get(
    `/v1/runs/${runId}/distribution?scope=request&group=${encodeURIComponent(group)}&family=response_time${query}`,
  );
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  expect(res.body.group).toBe(group);
  return DistributionResponseSchema.parse(res.body);
}

// ─── series ─────────────────────────────────────────────────────────────────

describe('GET /v1/runs/{id}/series?group=', () => {
  it('series for Cart equals the oracle bucket by bucket, and echoes the group', async () => {
    const body = await groupSeries('Cart');
    expect(body.scope).toBe('request');
    expect(body.name).toBe('');
    expect(body.window).toBeNull();
    expect(body.startedSplitAvailable).toBe(true);
    expectSeriesEqualsOracle(body, oracleSeries(inCart));
  });

  it('series for Catalog includes its subgroup\'s requests', async () => {
    // Vacuity: Catalog/Recommendations must contribute, or "includes" is untested.
    expect(requests.filter((r) => r.groups[1] === 'Recommendations').length).toBeGreaterThan(0);
    expectSeriesEqualsOracle(await groupSeries('Catalog'), oracleSeries(inCatalog));
  });

  it('series for (no group) merges Place Order and Search', async () => {
    expect([...new Set(requests.filter(inNoGroup).map((r) => r.name))].sort()).toEqual(['Place Order', 'Search']);
    expectSeriesEqualsOracle(await groupSeries(''), oracleSeries(inNoGroup));
  });

  it('a windowed group series equals the oracle over the same window', async () => {
    const range = { fromMs: 10_000, toMs: 30_000 };
    const body = await groupSeries('Cart', '&from=10000&to=30000');
    expect(body.window).toEqual({ ...range, bucketWidthMs: WIDTH });
    expectSeriesEqualsOracle(body, oracleSeries(inCart, range));
  });

  it('answers extra ranks from the merged histograms', async () => {
    const body = await groupSeries('Catalog', '&percentiles=99.9');
    const oracle = oracleSeries(inCatalog);
    expect(body.buckets.length).toBe(oracle.length);
    for (const [i, want] of oracle.entries()) {
      expect(body.buckets[i]!.percentiles['p99.9'], `bucket ${want.startOffsetMs}`).toBe(want.p999);
    }
  });

  it('a group with no members answers an empty series, not a 404', async () => {
    const body = await groupSeries('Nope');
    expect(body.buckets).toEqual([]);
  });
});

// ─── distribution ───────────────────────────────────────────────────────────

describe('GET /v1/runs/{id}/distribution?group=', () => {
  it('distribution for Cart equals the oracle\'s bins over the whole run', async () => {
    const body = await groupDistribution('Cart');
    const { bins, okN, koN } = oracleDistribution(inCart);
    expect(okN + koN).toBeGreaterThan(10);
    expect(body.scope).toBe('request');
    expect(body.name).toBe('');
    expect(body.window).toBeNull();
    expect({ labels: body.labels, okCount: body.okCount, koCount: body.koCount, exactValues: body.exactValues })
      .toEqual({ labels: bins.labels, okCount: bins.okCount, koCount: bins.koCount, exactValues: bins.exactValues });
    expect(body.okCount.reduce((a, b) => a + b, 0)).toBe(okN);
    expect(body.koCount.reduce((a, b) => a + b, 0)).toBe(koN);
  });

  it('distribution for Cart equals the oracle\'s bins over a window', async () => {
    const range = { fromMs: 10_000, toMs: 30_000 };
    const body = await groupDistribution('Cart', '&from=10000&to=30000');
    const { bins, okN, koN } = oracleDistribution(inCart, range);
    expect(okN + koN).toBeGreaterThan(5);
    expect(body.window).toEqual({ ...range, bucketWidthMs: WIDTH });
    expect({ labels: body.labels, okCount: body.okCount, koCount: body.koCount })
      .toEqual({ labels: bins.labels, okCount: bins.okCount, koCount: bins.koCount });
    expect(body.okCount.reduce((a, b) => a + b, 0) + body.koCount.reduce((a, b) => a + b, 0)).toBe(okN + koN);
  });

  it('distribution for Catalog and (no group) each equal the oracle', async () => {
    for (const [group, pick] of [['Catalog', inCatalog], ['', inNoGroup]] as const) {
      const body = await groupDistribution(group);
      const { bins } = oracleDistribution(pick);
      expect({ labels: body.labels, okCount: body.okCount, koCount: body.koCount }, group)
        .toEqual({ labels: bins.labels, okCount: bins.okCount, koCount: bins.koCount });
    }
  });

  it('a group with no members answers 404, as an unknown name does, windowed or not', async () => {
    for (const query of ['', '&from=0&to=5000']) {
      const res = await get(`/v1/runs/${runId}/distribution?scope=request&group=Nope&family=response_time${query}`);
      expect(res.status, query).toBe(404);
      expect(res.body.remediation).toMatch(/GET \/v1\/runs\/\{id\}\/stats/);
    }
  });

  /**
   * NOT the ordinary read's quiet-window 404. An API pod older than `?group=`
   * answers every group distribution 404 with no body to echo, so a quiet
   * window must be told apart from it: 200, empty, echoed.
   */
  it('a group with members whose window selects none of their buckets answers 200, empty, echoed', async () => {
    const range = { fromMs: 0, toMs: 5000 };
    // Vacuity: Cart has members, and none of them starts inside the window.
    const { okN, koN } = oracleDistribution(inCart, range);
    expect(okN + koN).toBe(0);
    expect(oracleDistribution(inCart).okN).toBeGreaterThan(0);

    const body = await groupDistribution('Cart', '&from=0&to=5000');
    expect(body.window).toEqual({ ...range, bucketWidthMs: WIDTH });
    expect({ labels: body.labels, okCount: body.okCount, koCount: body.koCount, okPercent: body.okPercent })
      .toEqual({ labels: [], okCount: [], koCount: [], okPercent: [] });
    expect(body.scope).toBe('request');
    expect(body.name).toBe('');
  });
});

// ─── refusals and the echo ──────────────────────────────────────────────────

describe('what a group read refuses', () => {
  const ENDPOINTS = ['series', 'distribution'] as const;
  const CONFLICTS = [
    ['group with a name', '?scope=request&group=Cart&name=Cart%2FView%20Cart'],
    ['group with scope=group', '?scope=group&group=Cart'],
    ['group with no scope', '?group=Cart'],
    ['a repeated group', '?scope=request&group=Cart&group=Catalog'],
  ] as const;

  for (const endpoint of ENDPOINTS) {
    it.each(CONFLICTS)(`/${endpoint}: %s is 400 INVALID_QUERY`, async (_label, query) => {
      const res = await get(`/v1/runs/${runId}/${endpoint}${query}`);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('INVALID_QUERY');
      expect(res.body.remediation.length).toBeGreaterThan(10);
    });
  }

  it('an ordinary read echoes group: null', async () => {
    for (const path of [
      `/v1/runs/${runId}/series`,
      `/v1/runs/${runId}/series?scope=request&name=Search&family=response_time`,
      `/v1/runs/${runId}/distribution?scope=request&name=Search&family=response_time`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.group, path).toBeNull();
    }
  });
});

describe('a member that cannot be merged exactly', () => {
  /** Overwrites one column of one row, runs `fn`, and puts the bytes back. */
  async function patched(
    table: 'run_series_bucket' | 'run_stat',
    name: string,
    value: Buffer | null,
    fn: () => Promise<void>,
  ): Promise<void> {
    const extra = table === 'run_series_bucket' ? 'ORDER BY start_offset_ms LIMIT 1' : `AND family = 'response_time'`;
    const key = table === 'run_series_bucket' ? 'start_offset_ms' : 'id';
    const { rows } = await ctx.pool.query<{ k: unknown; histogram_ok: Buffer }>(
      `SELECT ${key} AS k, histogram_ok FROM ${table}
        WHERE run_id = $1 AND scope = 'request' AND name = $2 ${extra}`,
      [runId, name],
    );
    expect(rows.length, `no ${table} row for ${name}`).toBe(1);
    const row = rows[0]!;
    const set = (bytes: Buffer | null) => ctx.pool.query(
      `UPDATE ${table} SET histogram_ok = $3 WHERE run_id = $1 AND scope = 'request' AND name = $2 AND ${key} = $4`,
      [runId, name, bytes, row.k],
    );
    await set(value);
    try {
      await fn();
    } finally {
      await set(row.histogram_ok);
    }
  }

  const HOLES = [
    ['a null histogram', null],
    ['a legacy, non-exact histogram', Buffer.from(Histogram.legacyV1ForTests([120, 140]))],
  ] as const;

  it.each(HOLES)('series: a member bucket with %s is 409 GROUP_NOT_MERGEABLE', async (_label, value) => {
    await patched('run_series_bucket', 'Cart/View Cart', value, async () => {
      for (const query of ['', '&from=10000&to=30000']) {
        const res = await get(`/v1/runs/${runId}/series?scope=request&group=Cart&family=response_time${query}`);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe('GROUP_NOT_MERGEABLE');
        expect(res.body.remediation).toMatch(/GET \/v1\/runs\/\{id\}\/series\?scope=request&name=/);
      }
      // Only the group holding the member is refused.
      const other = await get(`/v1/runs/${runId}/series?scope=request&group=Catalog&family=response_time`);
      expect(other.status).toBe(200);
    });
  });

  it.each(HOLES)('distribution: a member row with %s is 409 GROUP_NOT_MERGEABLE', async (_label, value) => {
    await patched('run_stat', 'Cart/View Cart', value, async () => {
      const res = await get(`/v1/runs/${runId}/distribution?scope=request&group=Cart&family=response_time`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('GROUP_NOT_MERGEABLE');
      expect(res.body.remediation).toMatch(/GET \/v1\/runs\/\{id\}\/distribution\?scope=request&name=/);
    });
    // The windowed distribution merges the bucket histograms, so a bucket hole refuses it too.
    await patched('run_series_bucket', 'Cart/View Cart', value, async () => {
      const res = await get(`/v1/runs/${runId}/distribution?scope=request&group=Cart&family=response_time&from=0&to=70000`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('GROUP_NOT_MERGEABLE');
    });
  });
});

// ─── members of different widths (Review Focus 2) ───────────────────────────

describe('a group whose members were bucketed at different widths', () => {
  /**
   * `Seed/a` at 1000 ms and `Seed/b` at 2000 ms, written straight to the
   * tables the way `window-bench.integration.test.ts` seeds them.
   *
   * THE OFFSETS ARE SPARSE ON PURPOSE. `b` sits on 2000 ms boundaries (2000,
   * 6000, 10000 — at least two, so the merge reads its width rather than
   * defaulting a lone bucket to 1000) and `a` on odd seconds (3000, 7000,
   * 11000), so the merge is at 2000 and the merged offsets are 2000, 6000,
   * 10000 — 4000 apart. A width RE-INFERRED from those offsets reads 4000, and
   * this case is what tells that apart from the merge's own 2000.
   */
  const A = [3000, 7000, 11_000];
  const B = [2000, 6000, 10_000];

  function histogramOf(values: readonly number[]): Histogram {
    const h = new Histogram();
    for (const v of values) h.accept(v);
    return h;
  }
  const okValues = (offset: number, salt: number) => [40 + salt, 50 + (offset / 1000) + salt, 60 + salt];
  const koValues = (offset: number) => (offset % 4000 === 2000 ? [300] : []);

  async function seedMixedRun(): Promise<string> {
    const id = randomUUID();
    const startedOn = new Date('2026-08-16T00:00:00Z');
    await ctx.prisma.run.create({
      data: {
        id, orgId: ctx.orgId, projectId: ctx.projectId,
        status: 'complete', verdict: 'passed', tool: 'gatling',
        startedAt: startedOn, startedOn, durationMs: 12_000,
        bundleKey: `k/${id}`, bundleSha256: 'z'.repeat(64), bundleBytes: BigInt(1),
        engineOptions: {},
      },
    });
    const members = [['Seed/a', A, 1], ['Seed/b', B, 2]] as const;
    for (const [name, offsets, salt] of members) {
      const allOk = new Histogram();
      const allKo = new Histogram();
      for (const o of offsets) {
        const ok = histogramOf(okValues(o, salt));
        const ko = histogramOf(koValues(o));
        allOk.merge(ok);
        allKo.merge(ko);
        const n = ok.total + ko.total;
        await ctx.pool.query(
          `INSERT INTO run_series_bucket (run_started_on, run_id, org_id, project_id, scope, name, family,
             start_offset_ms, started_count, ended_count, ok_count, ko_count, started_ok_count, started_ko_count,
             min_ms, max_ms, mean_ms, percentiles, percentiles_ok, percentiles_ko, histogram_ok, histogram_ko)
           VALUES ($1, $2, $3, $4, 'request', $5, 'response_time', $6, $7, $7, $8, $9, $8, $9,
             0, 0, 0, '{}', '{}', '{}', $10, $11)`,
          // The UTC day as text, never the Date — CLAUDE.md, "A date partition key".
          ['2026-08-16', id, ctx.orgId, ctx.projectId, name, o, n, ok.total, ko.total,
            Buffer.from(ok.serialize()), Buffer.from(ko.serialize())],
        );
      }
      await ctx.prisma.runStat.create({
        data: {
          runId: id, orgId: ctx.orgId, projectId: ctx.projectId, scope: 'request', name, family: 'response_time',
          count: allOk.total + allKo.total, okCount: allOk.total, koCount: allKo.total, errorRate: 0,
          minMs: 0, maxMs: 0, meanMs: 0, stddevMs: 0, throughputRps: 0, percentiles: {},
          histogramOk: Buffer.from(allOk.serialize()), histogramKo: Buffer.from(allKo.serialize()),
          histogramKind: 'sparse-ms-v2',
        },
      });
    }
    await ctx.prisma.runStat.create({
      data: {
        runId: id, orgId: ctx.orgId, projectId: ctx.projectId, scope: 'group', name: 'Seed', family: 'group_cumulated',
        count: 0, okCount: 0, koCount: 0, errorRate: 0, minMs: 0, maxMs: 0, meanMs: 0, stddevMs: 0,
        throughputRps: 0, percentiles: {},
      },
    });
    return id;
  }

  const startedAt = (offset: number, salt: number) => okValues(offset, salt).length + koValues(offset).length;

  it('merges at the coarser width, snaps the window to it, and drops nothing', async () => {
    const id = await seedMixedRun();
    const res = await get(`/v1/runs/${id}/series?scope=request&group=Seed&family=response_time&from=2000&to=12000`);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const body = SeriesResponseSchema.parse(res.body);

    expect(body.bucketWidthMs).toBe(2000);
    expect(body.buckets.map((b) => b.startOffsetMs)).toEqual([2000, 6000, 10_000]);
    expect(body.buckets.every((b) => b.startOffsetMs % 2000 === 0)).toBe(true);
    expect(body.window).toEqual({ fromMs: 2000, toMs: 12_000, bucketWidthMs: 2000 });

    // Each merged bucket holds the a-bucket a second after it and the b-bucket at it.
    expect(body.buckets.map((b) => b.startedCount)).toEqual(
      B.map((o, i) => startedAt(o, 2) + startedAt(A[i]!, 1)),
    );
    const seeded = [...A.map((o) => startedAt(o, 1)), ...B.map((o) => startedAt(o, 2))].reduce((x, y) => x + y, 0);
    expect(body.buckets.reduce((sum, b) => sum + b.startedCount, 0), 'nothing dropped').toBe(seeded);
  });

  it('selects the same buckets for the distribution as for the series, under an unaligned window', async () => {
    const id = await seedMixedRun();
    const query = 'scope=request&group=Seed&family=response_time&from=3000&to=12000';
    const series = SeriesResponseSchema.parse((await get(`/v1/runs/${id}/series?${query}`)).body);
    const res = await get(`/v1/runs/${id}/distribution?${query}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const dist = DistributionResponseSchema.parse(res.body);

    // from=3000 falls inside the merged bucket [2000, 4000), which the series
    // leaves out (half-open, by its start) — so a's 3000 bucket is out of both.
    expect(series.buckets.map((b) => b.startOffsetMs)).toEqual([6000, 10_000]);
    expect(dist.window).toEqual(series.window);
    expect(dist.window).toEqual({ fromMs: 2000, toMs: 12_000, bucketWidthMs: 2000 });
    const counted = dist.okCount.reduce((a, b) => a + b, 0) + dist.koCount.reduce((a, b) => a + b, 0);
    expect(counted).toBe(series.buckets.reduce((sum, b) => sum + b.startedCount, 0));
  });
});
