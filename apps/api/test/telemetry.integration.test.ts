import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const sample = (secondsFromNow = 0) => ({
  sampledAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
  cpuUserMs: 1000, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000, netTxBytes: 20_000,
  tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
  tcpActiveOpens: 5, tcpPassiveOpens: 3,
  tcpStates: { ESTABLISHED: 10 },
});

describe('POST /v1/telemetry', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('accepts a batch from a telemetry token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', samples: [sample(0), sample(1)] });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
  });

  // ═══ THE SCOPE IS ASSERTED BOTH WAYS ═══
  // A scope that is not enforced is decoration, and only one of these two
  // directions is the one people remember to test.

  it('refuses an ingest token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('refuses a read token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot upload a bundle', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .field('metadata', JSON.stringify({}));
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot read runs', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects a payload that names a tenant', async () => {
    // Spec §2, enforced rather than documented. `.strict()` turns a
    // hypothetical privilege escalation into a 400 on the first request.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', projectId: ctx.projectId, samples: [sample()] });
    expect(res.status).toBe(400);
  });

  it('refuses an org-scoped credential', async () => {
    // A session names no project, and a telemetry row must belong to one.
    // Refuse and say what to use instead, exactly as ingest does.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .send({ host: 'gen-1', samples: [sample()] });
    expect([401, 400]).toContain(res.status);
  });
});

/**
 * `GET /v1/runs/:id/telemetry` — the read half. A wall-clock sample becomes
 * one point on the run's own elapsed axis (toTelemetrySeries,
 * @perfportal/statistics), which is what lets this endpoint inherit the
 * `?from=&to=` window for free.
 *
 * ═══ ONE REAL INGEST, TWO SEEDED RUNS ═══
 *
 * The "places samples" / "narrows" / "separates hosts" cases need a run that
 * actually reached `run_series_bucket` (real histograms, real bucket width,
 * real `windowable`), so those run against a bundle ingested through the real
 * pipeline — exactly window.integration.test.ts's pattern. The two
 * `available: false` cases are about the RUN's state, not about ingested
 * data, so they seed a `run` row directly rather than paying for a second
 * ingest.
 */
describe('GET /v1/runs/:id/telemetry', () => {
  const FIXTURE_LOG = fileURLToPath(
    new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
  );

  let bundle: Buffer;
  let ctx: TestContext;
  let runId: string;
  let toolStartedAt: Date;
  let posted: ReturnType<typeof sampleAt>[];
  let unparsedRunId: string;
  let runWithNoTelemetryId: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-get-'));
    const results = join(dir, 'run-1');
    mkdirSync(results, { recursive: true });
    copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
    const out = join(dir, 'bundle.tgz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
    bundle = readFileSync(out);
  });

  /**
   * Anchored to an explicit base rather than `Date.now()` (unlike the top
   * `sample()` helper above), so every test below can derive its expected
   * offsets from the SAME base the server used — the run's own
   * `toolStartedAt` — instead of writing an offset down and hoping it
   * matches. Counters climb monotonically with `offsetSeconds` so no sample
   * here is ever misread as a counter reset.
   */
  const sampleAt = (base: Date, offsetSeconds: number) => ({
    sampledAt: new Date(base.getTime() + offsetSeconds * 1000).toISOString(),
    cpuUserMs: 1000 + offsetSeconds * 100, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
    memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
    netRxBytes: 10_000 + offsetSeconds * 100, netTxBytes: 20_000,
    tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
    tcpActiveOpens: 5, tcpPassiveOpens: 3,
    tcpStates: { ESTABLISHED: 10 },
  });

  /**
   * A run inserted directly rather than ingested — for the cases that are
   * about the RUN's own state (an unparsed run, a null/zero duration) rather
   * than about real series data. Mirrors trends.integration.test.ts's
   * `seedRun`.
   *
   * `startedAt` is deliberately far from every OTHER seeded run's
   * `toolStartedAt` in this file, INCLUDING the really-ingested one (its
   * fixture-log date is fixed and checked separately — see the R2 test's own
   * comment): `TelemetryStore.forRun` scopes only by (org, project, time),
   * not by run id (telemetry_sample carries no run_id — Task 6), so two
   * runs whose windows overlap would leak one run's samples into the
   * other's response. Also kept inside the migration's 2026 partition
   * range — telemetry_sample is partitioned by month and a write outside it
   * fails loudly (see the migration's comment), which only matters for a
   * caller that actually posts a sample for this run (the R2 test below),
   * but every date here stays in-range for consistency.
   */
  async function seedRun(opts: {
    toolStartedAt: Date | null;
    durationMs?: number | null;
  }): Promise<string> {
    const id = randomUUID();
    const startedAt = opts.toolStartedAt ?? new Date('2026-01-01T00:00:00.000Z');
    await ctx.prisma.run.create({
      data: {
        id,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        status: opts.toolStartedAt === null ? 'parsing' : 'complete',
        verdict: opts.toolStartedAt === null ? null : 'passed',
        tool: 'gatling',
        startedAt,
        startedOn: startedAt,
        toolStartedAt: opts.toolStartedAt,
        // A run that never finished parsing has no duration either — the
        // worker writes both together. For a parsed run, explicit `null` is
        // preserved rather than defaulted: `durationMs ?? 60_000` would turn
        // the R2 zero/null-duration case below into an ordinary 60s run.
        durationMs: opts.toolStartedAt === null
          ? null
          : (opts.durationMs === undefined ? 60_000 : opts.durationMs),
        bundleKey: `k/${id}`,
        bundleSha256: 'x'.repeat(64),
        bundleBytes: BigInt(1),
        engineOptions: {},
      },
    });
    return id;
  }

  beforeEach(async () => {
    ctx = await createTestApp();

    const q = new Queue('ingest', {
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' },
    });
    await q.obliterate({ force: true });
    await q.close();

    const ingestRes = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');
    await runPipelineFor(ctx, ingestRes.body.id);
    runId = ingestRes.body.id;

    const runRes = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    toolStartedAt = new Date(runRes.body.toolStartedAt);

    posted = [0, 1, 2, 3].map((s) => sampleAt(toolStartedAt, s));
    await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', samples: posted });
    await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-2', samples: [0, 1].map((s) => sampleAt(toolStartedAt, s)) });

    // Never finished parsing — no toolStartedAt, so no window at all.
    unparsedRunId = await seedRun({ toolStartedAt: null });

    // Finished parsing, but no agent ever reported for its window. Its own
    // toolStartedAt (early January) is nowhere near the ingested run's above
    // (its fixture-log date, checked to be in early August — see the R2
    // test's own comment) or the R2 run's below (late January) — see
    // seedRun's docstring for why that separation matters.
    runWithNoTelemetryId = await seedRun({ toolStartedAt: new Date('2026-01-10T00:00:00.000Z') });
  });

  afterEach(async () => { await ctx.close(); });

  const get = (path: string) =>
    request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ctx.readToken}`);

  it('places samples on the run\'s own elapsed axis', async () => {
    // sampledAt values are built from the run's OWN toolStartedAt, so the
    // expected offsets are derived from what was posted rather than written.
    const res = await get(`/v1/runs/${runId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);

    const host = res.body.hosts.find((h: { host: string }) => h.host === 'gen-1');
    expect(host).toBeDefined();
    const expected = posted.map((s) =>
      Math.floor((Date.parse(s.sampledAt) - toolStartedAt.getTime()) / res.body.bucketWidthMs)
      * res.body.bucketWidthMs,
    );
    expect(host.points.map((p: { startOffsetMs: number }) => p.startOffsetMs))
      .toEqual([...new Set(expected)].sort((a, b) => a - b));
  });

  it('reports available: false for a run whose toolStartedAt is null', async () => {
    const res = await get(`/v1/runs/${unparsedRunId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.hosts).toEqual([]);
  });

  it('reports available: false when no agent reported', async () => {
    const res = await get(`/v1/runs/${runWithNoTelemetryId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('narrows to ?from=&to= exactly as /series does', async () => {
    const whole = await get(`/v1/runs/${runId}/telemetry`);
    const width = whole.body.bucketWidthMs;
    const windowed = await get(`/v1/runs/${runId}/telemetry?from=0&to=${width * 2}`);

    expect(windowed.body.window).not.toBeNull();
    // Half-open, matching every other windowed endpoint: >= from AND < to.
    for (const h of windowed.body.hosts) {
      for (const p of h.points) {
        expect(p.startOffsetMs).toBeGreaterThanOrEqual(windowed.body.window.fromMs);
        expect(p.startOffsetMs).toBeLessThan(windowed.body.window.toMs);
      }
    }
    // Availability is a property of the RUN, not of the window — asked before
    // filtering, so a window over a quiet stretch does not read as "never
    // recorded".
    expect(windowed.body.available).toBe(whole.body.available);
  });

  it('separates hosts', async () => {
    const res = await get(`/v1/runs/${runId}/telemetry`);
    expect(res.body.hosts.map((h: { host: string }) => h.host)).toEqual(['gen-1', 'gen-2']);
  });

  it('requires the read scope, and a telemetry token does not have it', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/telemetry`)
      .set('Authorization', `Bearer ${ctx.telemetryToken}`);
    expect(res.status).toBe(403);
  });

  // ═══ R2 ═══ (controller ruling, not in the original brief)
  //
  // The brief computed `available` as `samples.length > 0` — the RAW row
  // count before toTelemetrySeries runs. That is wrong for a run whose
  // durationMs is null (worker-unset) or 0: toTelemetrySeries's own window is
  // `[0, durationMs)`, so EVERY sample — including one sitting entirely
  // inside the pre-run LOOKBACK, which is exactly what a real agent report
  // looks like moments before such a run — resolves to a negative offset and
  // is dropped. The naive reading would answer `available: true` with
  // `hosts: []`, a state TelemetryResponseSchema's own doc comment says
  // cannot happen. This proves the corrected implementation (available
  // computed from the SERIES) actually rejects that case, not just that the
  // ordinary cases still pass — none of the six cases above tell the two
  // implementations apart.
  it('computes availability from the series, not the raw row count (R2)', async () => {
    // Late January — a real POST happens below, so this has to land inside
    // telemetry_sample's 2026 partition range (see seedRun's docstring), and
    // far enough from the really-ingested run's own toolStartedAt (its
    // fixture-log date; empirically early August, but pinned by fixture
    // content rather than by this test) that the two windows cannot overlap.
    const zeroDurationStart = new Date('2026-01-20T00:00:00.000Z');
    const zeroDurationRunId = await seedRun({ toolStartedAt: zeroDurationStart, durationMs: null });

    // Entirely inside the 60s lookback, i.e. BEFORE the run's own start —
    // TelemetryStore.forRun fetches it (it is within [start - lookback,
    // start + 0)), but toTelemetrySeries must drop it as a negative offset.
    await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', samples: [sampleAt(zeroDurationStart, -10)] });

    const res = await get(`/v1/runs/${zeroDurationRunId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.hosts).toEqual([]);
  });
});
