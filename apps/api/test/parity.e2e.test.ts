import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, mintToken, type RequestEvent } from '@perfportal/core';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';
// Relative cross-package import, matching the pattern already used by
// ./support/pipeline.ts for worker/src: reads plugin-gatling's TypeScript
// source directly rather than adding a package.json dependency for a single
// test-only decode of the reference bundle's binary log.
import { parseSimulationLog } from '../../../packages/plugin-gatling/src/records.js';

const REPORT_DIR = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report', import.meta.url),
);

/**
 * Independent reimplementation of parity.controller.ts's scatter x
 * computation — deliberately NOT importing/calling the controller's own
 * helper, so a bug in that helper can't also be "correct" here. Own and
 * global series each coalesce on their own occupied-bucket count and so can
 * end up at different widths, so x for one own bucket is the rate over the
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

let bundle: Buffer;
let ctx: TestContext;

/**
 * The bundle is the WHOLE reference report directory, exactly as a CI pipeline
 * would archive target/gatling/<run>. Not a hand-picked simulation.log.
 */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const results = join(dir, 'paritysimulation-20260807123456789');
  mkdirSync(results, { recursive: true });
  for (const entry of readdirSync(REPORT_DIR)) {
    copyFileSync(join(REPORT_DIR, entry), join(results, entry));
  }
  const out = join(dir, 'bundle.tgz');
  // COPYFILE_DISABLE suppresses AppleDouble ._name sidecar entries that
  // macOS bsdtar emits for files carrying extended attributes — a no-op
  // under GNU tar, so this is safe on Linux CI too.
  execFileSync('tar', ['-czf', out, '-C', dir, 'paritysimulation-20260807123456789'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  bundle = readFileSync(out);
});

// Only a context a TEST built is this hook's to close. The Appendix A block
// below builds ONE in beforeAll, shares it across every PT-* row, and closes
// it in its own afterAll — closing that one here would dispose it after the
// first row and leave every remaining row without a database.
//
// This was invisible while close() disposed nothing that mattered: it called
// app.close() and left the pool and PrismaClient open, and supertest binds
// its own ephemeral server rather than the app's, so a "closed" app kept
// answering and every row still passed. It stopped being invisible the moment
// close() began ending the pool, which failed 18 rows here.
let ctxOwnedByTest = false;

afterEach(async () => {
  if (!ctxOwnedByTest) return;
  ctxOwnedByTest = false;
  await ctx?.close();
});

describe('end-to-end parity with the Gatling reference report', () => {
  it('reproduces every exact statistic through HTTP', async () => {
    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    await q.obliterate({ force: true });
    await q.close();

    ctx = await createTestApp();
    ctxOwnedByTest = true;

    // 1. Ingest, asking for no synchronous wait.
    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'parity-1' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(accepted.status).toBe(202);
    const runId: string = accepted.body.id;

    // 2. Run the pipeline.
    await runPipelineFor(ctx, runId);

    // 3. The run is complete, with no rules configured.
    const run = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('complete');
    expect(run.body.verdict).toBe('not_evaluated');
    expect(run.body.toolVersion).toBe('3.15.1');

    // 4. Exact statistics — every one of these appears in the Gatling report.
    const stats = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    const global = stats.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(global.count).toBe(895);
    expect(global.okCount).toBe(871);
    expect(global.koCount).toBe(24);
    expect(Math.round(global.maxMs)).toBe(2503);
    expect(Math.round(global.meanMs)).toBe(228);
    expect(Math.round(global.stddevMs)).toBe(370);

    expect(stats.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });

    // 5. The error table, with both messages and their exact counts.
    const errors = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/errors`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(errors.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('500'))).toHaveLength(1);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('503'))).toHaveLength(1);

    // 6. Groups — Gatling reports cumulated response time and duration
    //    separately, and they diverge whenever requests inside a group overlap.
    const groups = stats.body.stats.filter((s: { scope: string }) => s.scope === 'group');
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(groups.map((g: { family: string }) => g.family))).toEqual(
      new Set(['group_cumulated', 'group_duration']),
    );
    expect(groups.some((g: { name: string }) => g.name === 'Catalog/Recommendations')).toBe(true);

    // 7. The time series accounts for every request, at both edges.
    const series = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=run&name=`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    const started = series.body.buckets.reduce(
      (a: number, b: { startedCount: number }) => a + b.startedCount, 0,
    );
    const ended = series.body.buckets.reduce(
      (a: number, b: { endedCount: number }) => a + b.endedCount, 0,
    );
    expect(started).toBe(895);
    expect(ended).toBe(895);

    // 8. Percentiles are ESTIMATES and are checked against ground truth, not
    //    against Gatling — Gatling's own printed percentiles are histogram
    //    estimates and three of its four never occur in the data (spec §A.9 F-6).
    //    DDSketch guarantees 1% relative error, and 1.000% is reachable, so
    //    this bound is <=, never <.
    expect(Math.abs(global.percentiles.p95 - 654) / 654).toBeLessThanOrEqual(0.01);
  });

  it('is idempotent end to end — re-posting the same key yields one run', async () => {
    ctx = await createTestApp();
    ctxOwnedByTest = true;
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'same' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const a = await post();
    await runPipelineFor(ctx, a.body.id);
    const b = await post();

    expect(b.body.id).toBe(a.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });
});

/**
 * Appendix A row cases (PT-*): one named case per row of the reference
 * report, so a regression names the row it broke instead of surfacing as an
 * anonymous assertion. The bundle is posted and the pipeline run exactly
 * once, in beforeAll, and every row below asserts against that one run - a
 * second bootstrap or repost here would double an already slow suite.
 */
describe('Appendix A — Gatling report parity rows (PT-*)', () => {
  let ctx: TestContext;
  let runId: string;
  let simulationLogEvents: RequestEvent[];

  beforeAll(async () => {
    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    await q.obliterate({ force: true });
    await q.close();

    ctx = await createTestApp();

    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'parity-appendix-a' }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(accepted.status).toBe(202);
    runId = accepted.body.id;

    await runPipelineFor(ctx, runId);

    // Decoded straight from the fixture's binary log, independent of the
    // ingest pipeline under test, so it is a genuine ground truth rather
    // than a second read of the same derived numbers.
    const log = readFileSync(join(REPORT_DIR, 'simulation.log'));
    simulationLogEvents = [...parseSimulationLog(log)].filter(
      (e): e is RequestEvent => e.type === 'request',
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const get = (path: string) =>
    request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ctx.readToken}`);

  const setProjectIndicators = async (indicators: { lowerMs: number; higherMs: number }) => {
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(indicators), ctx.projectId],
    );
  };
  const setProjectPercentiles = async (percentiles: number[]) => {
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{percentiles}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(percentiles), ctx.projectId],
    );
  };

  /**
   * A couple of rows (PT-RQ-09's coalescing check, PT-K-03) need settings
   * baked into engineOptions BEFORE ingest, which means a fresh post - but
   * NOT a fresh app: createTestApp() TRUNCATEs every one of these tables
   * (see ./support/app.ts's TABLES list) with no org/project scoping, so
   * calling it again inside an `it` in THIS describe would silently wipe the
   * shared Appendix-A run out from under every later case (discovered the
   * hard way: doing so broke nine unrelated, later-running cases at once).
   * A sibling project in the SAME org, on the SAME already-running app, gets
   * the same "settings active at ingest" behavior via a plain Prisma insert -
   * no truncate, no second bootstrap.
   */
  const createSiblingProject = async (settings: Prisma.InputJsonObject) => {
    const project = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: `parity-sibling-${randomUUID().slice(0, 8)}`, name: 'Parity Sibling', settings },
    });
    const ing = mintToken();
    await ctx.prisma.apiToken.create({
      data: {
        orgId: ctx.orgId, projectId: project.id, name: 'ci',
        prefix: ing.prefix, tokenHash: await hashToken(ing.token.split('_')[2] ?? ''),
        scopes: ['ingest', 'read'],
      },
    });
    const rd = mintToken();
    await ctx.prisma.apiToken.create({
      data: {
        orgId: ctx.orgId, projectId: project.id, name: 'reader',
        prefix: rd.prefix, tokenHash: await hashToken(rd.token.split('_')[2] ?? ''),
        scopes: ['read'],
      },
    });
    return { projectId: project.id, ingestToken: ing.token, readToken: rd.token };
  };

  /** Posts the shared reference bundle to a sibling project and runs it to completion. */
  const ingestIntoSibling = async (sibling: { ingestToken: string }, idempotencyKey: string): Promise<string> => {
    const posted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${sibling.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(posted.status).toBe(202);
    await runPipelineFor(ctx, posted.body.id);
    return posted.body.id;
  };

  // Ground truth for percentiles is the sorted decoded event set, NEVER the
  // figure Gatling prints. Gatling reports p99 = 2369 for this fixture and 2369
  // does not occur anywhere in the data - the sorted tail jumps 2287 -> 2501.
  // Matching Gatling would mean reproducing its estimator's error (AC-PARITY-2).
  const truePercentile = (sorted: number[], p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
  };
  const withinOnePercent = (actual: number, truth: number): boolean =>
    truth === 0 ? actual === 0 : Math.abs(actual - truth) / truth <= 0.01; // <=, never <

  /** Sorted OK response times (endMs - startMs) for one request, decoded
   *  straight from the fixture - the same "response_time" definition the
   *  engine uses (packages/statistics/src/engine.ts: `e.endMs - e.startMs`).
   *  `name` is the FULL joined path (e.g. "Cart/Add To Cart"), matched the
   *  identical way engine.ts's D-10 builds a request's identity -
   *  `[...e.groups, e.name].join('/')` - not the raw record's bare `name`
   *  field, so this stays correct for both grouped and genuinely groupless
   *  requests without the caller needing to know which is which. */
  const groundTruthOkDurations = (name: string): number[] =>
    simulationLogEvents
      .filter((e) => [...e.groups, e.name].join('/') === name && e.ok)
      .map((e) => e.endMs - e.startMs)
      .sort((a, b) => a - b);

  describe('Appendix A.1 — global report page', () => {
    it('PT-G-01/02 header carries the simulation name and description', async () => {
      const r = await get(`/v1/runs/${runId}`);
      // The canonical value is the FULLY-QUALIFIED class name the binary log
      // header records. Gatling's HTML renders only the last segment, so parity
      // is that the displayed name is derivable - not that we store the short
      // form and throw the package away.
      expect(r.body.simulation).toBe('example.ParitySimulation');
      expect(r.body.simulation.split('.').pop()).toBe('ParitySimulation');
      // The fixture's header carries an empty description, which the reader
      // normalizes to undefined (packages/plugin-gatling/src/records.ts) and
      // storage records as null. Asserted by VALUE, not merely by type: a
      // regression that silently starts persisting '' instead of null must
      // fail here.
      expect(r.body.description).toBeNull();
    });

    /**
     * ═══ PT-G-05 — THE ASSERTIONS TABLE ═══
     *
     * The row this appendix carried for two verification passes with nothing
     * asserting it, while the plugin discarded the payload it needed. Ground
     * truth is `fixtures/gatling-3.15.1.2/simulation/ParitySimulation.kt`,
     * which declares exactly three:
     *
     *   global().responseTime().max().lt(10000)            expect PASS
     *   global().successfulRequests().percent().gt(80.0)   expect PASS
     *   details("Search").responseTime().percentile3().lt(100)  expect FAIL
     *
     * THE VERDICTS ARE RECOMPUTED, NOT READ. The log carries no outcome and no
     * actual value — Gatling's report derives both at render time, and so does
     * this platform, against its own statistics. That is why the third one is
     * the interesting case: `Search` is the fixture's deliberately slow
     * endpoint, so a p95 under 100ms is false, and it has to come back false
     * from OUR numbers rather than from anything the file told us.
     */
    it('PT-G-05 the tool’s own assertions are decoded, re-evaluated and reported', async () => {
      const r = await get(`/v1/runs/${runId}`);
      const assertions = r.body.toolAssertions as {
        expression: string; actualValue: number | null; outcome: string;
      }[];

      // Three, and NOT null: null would mean the run predates the decoder.
      expect(Array.isArray(assertions)).toBe(true);
      expect(assertions).toHaveLength(3);

      // The tool's own wording, which G-05's "exact" tolerance covers as much
      // as the numbers — a reader is comparing these strings to a report.
      expect(assertions.map((a) => a.expression)).toEqual([
        'Global: max of response time is less than 10000.0',
        'Global: percentage of successful events is greater than 80.0',
        'Search: 95th percentile of response time is less than 100.0',
      ]);

      expect(assertions.map((a) => a.outcome)).toEqual(['passed', 'passed', 'failed']);

      // And the actual values are this run's real ones, derived from the same
      // payload the rest of this suite asserts against rather than written
      // down: max is the decoded log's own maximum, and the success percentage
      // is its OK count over its total.
      const durations = simulationLogEvents.map((e) => e.endMs - e.startMs);
      const okCount = simulationLogEvents.filter((e) => e.ok).length;

      expect(assertions[0]!.actualValue).toBe(Math.max(...durations));
      expect(assertions[1]!.actualValue).toBeCloseTo(
        (okCount / simulationLogEvents.length) * 100, 6,
      );
      // The failing one still reports what it measured — a verdict with no
      // number is not actionable.
      expect(assertions[2]!.actualValue).toBeGreaterThan(100);
    });

    /**
     * PT-G-04 READS THE REPORT NOW, AND THAT CHANGED THE ANSWER.
     *
     * This assertion used to hard-code 63 against `durationMs` with a comment
     * claiming the report shows "1m 3s" and that the brief's "62" had been
     * "verified against the real fixture and corrected". It had not: the
     * committed report in this very directory says **1m 2s**, and the test
     * never opened it — it compared PerfPortal's number to a number derived
     * from PerfPortal's own definition, which is self-consistency wearing a
     * parity test's name. The brief was right all along.
     *
     * The gap is real and structural, not a rounding quirk: `durationMs`
     * measures the run HEADER to the last event, while Gatling anchors at the
     * FIRST event. On this fixture that lead-in is 1025ms, so the two land on
     * different whole seconds. `activityMs` is the first-event-anchored span,
     * and it is what the page now labels "Duration".
     *
     * Ground truth is PARSED OUT OF `index.html` rather than written down, so
     * a re-captured fixture moves both sides together.
     */
    it('PT-G-04 the run page\'s duration matches the report\'s own header', async () => {
      const html = readFileSync(join(REPORT_DIR, 'index.html'), 'utf8');
      const m = /Duration:\s*<\/span>\s*<span>(.*?)<\/span>/s.exec(html);
      expect(m, 'could not find the Duration line in the reference report').not.toBeNull();
      const shown = m![1]!.trim(); // e.g. "1m 2s"
      const mm = /(?:(\d+)m\s*)?(\d+)s/.exec(shown);
      expect(mm, `unparseable report duration: ${shown}`).not.toBeNull();
      const reportSeconds = Number(mm![1] ?? 0) * 60 + Number(mm![2]);

      const r = await get(`/v1/runs/${runId}`);
      // The MEASURED span is the one that has to agree with the report.
      expect(Math.floor(r.body.activityMs / 1000)).toBe(reportSeconds);
      // And the series span is deliberately NOT it — it is anchored at the
      // header, which is what the time axis needs. Pinned so the two cannot
      // silently collapse back into one field.
      expect(r.body.durationMs).toBeGreaterThan(r.body.activityMs);
    });

    /**
     * PT-G-13 THE THREE HEADLINE NUMBERS MUST RECONCILE WITH EACH OTHER.
     *
     * `throughputRps` had only a `typeof === 'number'` check anywhere in this
     * suite, so nothing noticed that it divides by the ACTIVITY span while the
     * header rendered the SERIES span: the page showed 14.32 req/s beside a
     * stated 63s and a stated 895 requests, and 14.32 x 63 is 907. A reader
     * could do that multiplication on screen and catch the product lying.
     *
     * Derived from the payload on both sides, never written down.
     */
    it('PT-G-13 throughput x the displayed duration equals the request count', async () => {
      const run = await get(`/v1/runs/${runId}`);
      const stats = await get(`/v1/runs/${runId}/stats`);
      const row = stats.body.stats.find((s: { scope: string }) => s.scope === 'run');

      const implied = row.throughputRps * (run.body.activityMs / 1000);
      // Exact to within a rounding hair — this is the same division, undone.
      expect(Math.abs(implied - row.count)).toBeLessThan(0.5);
    });

    it('PT-G-06..09 indicator bands are 848 / 0 / 23 / 24', async () => {
      const r = await get(`/v1/runs/${runId}/stats`);
      expect(r.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
    });

    it('PT-G-06..09 "under" is boundary-EXCLUSIVE (< lowerMs, not <=)', async () => {
      // The default bounds (800/1200ms) don't land on any observed value in
      // this fixture (nearest are ...ms away), so a "under" count computed
      // with <= instead of < is indistinguishable from the correct one at the
      // default bounds - verified by actually mutating countBelow's `<` to
      // `<=` (packages/statistics/src/histogram.ts) and re-running: the case
      // above stayed GREEN. This one sets lowerMs to a duration that DOES
      // occur, so the two operators provably disagree, and pins the correct
      // (exclusive) count from the decoded ground truth.
      const okDurations = simulationLogEvents.filter((e) => e.ok).map((e) => e.endMs - e.startMs);
      const boundary = okDurations[0] as number; // guaranteed to occur - it's drawn from the data itself
      const countStrictlyBelow = okDurations.filter((d) => d < boundary).length;
      const countAtOrBelow = okDurations.filter((d) => d <= boundary).length;
      expect(countAtOrBelow).toBeGreaterThan(countStrictlyBelow); // sanity: the boundary must actually recur

      await setProjectIndicators({ lowerMs: boundary, higherMs: boundary + 1000 });
      const r = await get(`/v1/runs/${runId}/stats`);
      expect(r.body.indicators.under).toBe(countStrictlyBelow);
      await setProjectIndicators({ lowerMs: 800, higherMs: 1200 }); // restore
    });

    it('PT-G-20/21 distribution has 100 midpoint bins from 28 to 2491', async () => {
      const r = await get(`/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`);
      expect(r.body.labels).toHaveLength(100);
      expect(r.body.labels[0]).toBe(28);
      expect(r.body.labels[99]).toBe(2491);
      // Percent of the COMBINED count: the two series together sum to 100.
      const total = [...r.body.okPercent, ...r.body.koPercent].reduce((a: number, b: number) => a + b, 0);
      expect(total).toBeCloseTo(100, 6);
      expect(r.body.okCount.reduce((a: number, b: number) => a + b, 0)).toBe(871);
      expect(r.body.koCount.reduce((a: number, b: number) => a + b, 0)).toBe(24);
    });

    it('PT-G-18/19 active users total equals the per-scenario sum', async () => {
      const r = await get(`/v1/runs/${runId}/users`);
      expect(r.body.scenarios.map((s: { scenario: string }) => s.scenario)).toEqual(['Browse', 'Checkout']);
      for (const t of r.body.total) {
        const sum = r.body.scenarios
          .map((s: { buckets: { startOffsetMs: number; maxConcurrent: number }[] }) =>
            s.buckets.find((b) => b.startOffsetMs === t.startOffsetMs)?.maxConcurrent ?? 0)
          .reduce((a: number, b: number) => a + b, 0);
        expect(t.maxConcurrent).toBe(sum);
      }
    });

    it('PT-G-26 user start rate is present and non-zero', async () => {
      const r = await get(`/v1/runs/${runId}/users`);
      expect(r.body.total.reduce((n: number, b: { started: number }) => n + b.started, 0)).toBeGreaterThan(0);
    });
  });

  describe('Appendix A.2 — request detail page', () => {
    it('PT-RQ-02 per-request indicator bands reconcile with the row counts', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=request`);
      // A vacuous pass over zero rows would prove nothing: fail loudly if the
      // request scope ever comes back empty instead of silently no-op-ing.
      expect(r.body.stats.length).toBeGreaterThan(0);
      for (const row of r.body.stats) {
        expect(row.indicators.under + row.indicators.between + row.indicators.over).toBe(row.okCount);
        expect(row.indicators.failed).toBe(row.koCount);
      }
    });

    it('PT-RQ-05 request-scope p95 matches ground truth from the decoded event set', async () => {
      const stats = await get(`/v1/runs/${runId}/stats?scope=request`);
      // Any row with OK samples proves the point; a hard-coded name would
      // silently stop matching once a request's identity is its full group
      // path (D-10) rather than its bare leaf name.
      const row = stats.body.stats.find((s: { okCount: number }) => s.okCount > 0);
      expect(row).toBeDefined();
      const truth = truePercentile(groundTruthOkDurations(row.name), 95);
      expect(withinOnePercent(row.percentiles.p95, truth)).toBe(true);
    });

    it('PT-RQ-09 scatter is one point per OK bucket, x a rate and y the truncated p95', async () => {
      // "Add To Cart" has KO events, and parity.controller.ts's scatter
      // handler deliberately emits TWO points for a bucket that has both an
      // OK and a KO digest - one per status-filtered series (see its "Gate
      // is presence of the status-filtered digest" comment). A KO-free
      // request keeps the point-per-bucket count 1:1, which is what this
      // case is actually testing; "Add To Cart" is covered separately by
      // PT-RQ-09b below. Derived rather than named, so this stays valid
      // regardless of which request happens to be KO-free, and regardless
      // of a request's identity being its bare name or its full group path
      // (D-10) - a hard-coded name would silently break on either change.
      const statsForKoFree = await get(`/v1/runs/${runId}/stats?scope=request`);
      const koFree = statsForKoFree.body.stats.find(
        (s: { koCount: number; okCount: number }) => s.koCount === 0 && s.okCount > 0,
      );
      expect(koFree).toBeDefined();
      const name: string = koFree.name;
      const [series, globalSeries, scatter] = await Promise.all([
        get(`/v1/runs/${runId}/series?scope=request&name=${encodeURIComponent(name)}`),
        get(`/v1/runs/${runId}/series?scope=run&name=`),
        get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent(name)}`),
      ]);
      const okBuckets = series.body.buckets.filter(
        (b: { percentilesOk: Record<string, number> }) => b.percentilesOk.p95 !== undefined,
      );
      expect(okBuckets.length).toBeGreaterThan(0);
      expect(scatter.body.ok.length).toBe(okBuckets.length);
      expect(scatter.body.ko.length).toBe(0); // no KO events for this request at all

      // RQ-09's central claim is "x = global requests per second" — pin one
      // real point rather than merely checking its type. Expectation derived
      // independently from the /series responses, not by calling the
      // controller's own rate helper: computing x via the SAME function under
      // test would stay green even if that function's formula were wrong.
      const ownWidthMs = inferWidthMs(series.body.buckets.map((b: { startOffsetMs: number }) => b.startOffsetMs));
      const pinnedBucket = okBuckets[0] as { startOffsetMs: number; percentilesOk: { p95: number } };
      const expectedX = expectedRate(pinnedBucket.startOffsetMs, ownWidthMs, globalSeries.body.buckets);
      expect(scatter.body.ok).toContainEqual([expectedX, Math.trunc(pinnedBucket.percentilesOk.p95)]);

      // y matches Math.trunc of the bucket's own OK p95 exactly - not merely
      // "is an integer". This shared run's per-request, per-second buckets
      // CANNOT exercise the trunc/round DISAGREEING case on their own:
      // response times are integer ms, and Sketch#quantile
      // (packages/statistics/src/sketch.ts) short-circuits to the exact max
      // whenever ceil(0.95*n) === n, i.e. whenever a bucket has fewer than 20
      // samples - true of every per-request, per-second bucket in this
      // ~1-3 req/s fixture. Mutating Math.trunc to Math.round and re-running
      // leaves this loop (and the pre-existing sibling check in
      // parity-endpoints.integration.test.ts) GREEN - proven by actually
      // doing it. The block below is what actually catches that mutation.
      for (const b of okBuckets as { percentilesOk: { p95: number } }[]) {
        expect(scatter.body.ok.some(([, y]: [number, number]) => y === Math.trunc(b.percentilesOk.p95))).toBe(true);
      }

      // The real distinguishing case: force heavy bucket coalescing (a real,
      // user-configurable knob - packages/statistics/src/buckets.ts's
      // BucketSeries halves resolution once bucket count exceeds
      // maxBucketsEndpoint) on a FRESH ingest of the SAME reference bundle, so
      // each request's ~63 one-second buckets collapse into one bucket with
      // ~70-160 samples. At that sample count Sketch#quantile leaves its
      // exact-boundary short-circuit and returns a genuinely interpolated,
      // frequently fractional value - which is what actually distinguishes
      // Math.trunc from Math.round. Needs its own ingest (like PT-K-03):
      // maxBucketsEndpoint is captured into engineOptions at POST /v1/runs
      // time (packages/core/src/engine-options.ts's ENGINE_KEYS), not
      // read live - via a sibling project, not a second app (see
      // createSiblingProject's comment for why).
      // The request-scope series (own p95) and the run-scope series (the
      // scatter's x-axis rate) each coalesce independently on THEIR OWN
      // occupied-bucket count (parity.controller.ts's scatter() sums the
      // global series' startedCount over each own bucket's own window, rather
      // than assuming the two share one width) — forcing both caps to 1
      // collapses both down to a single bucket each, which this also uses to
      // pin a real x instead of accepting any number.
      const sibling = await createSiblingProject({ maxBucketsEndpoint: 1, maxBucketsRun: 1 });
      const coalescedRunId = await ingestIntoSibling(sibling, 'parity-rq09-coalesced');

      const cSeries = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${coalescedRunId}/series?scope=request&name=${encodeURIComponent(name)}`)
        .set('Authorization', `Bearer ${sibling.readToken}`);
      const cGlobalSeries = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${coalescedRunId}/series?scope=run&name=`)
        .set('Authorization', `Bearer ${sibling.readToken}`);
      const cScatter = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${coalescedRunId}/scatter?name=${encodeURIComponent(name)}`)
        .set('Authorization', `Bearer ${sibling.readToken}`);

      const bigBucket = cSeries.body.buckets.find(
        (b: { percentilesOk: Record<string, number> }) => b.percentilesOk.p95 !== undefined,
      );
      expect(bigBucket).toBeDefined();
      const rawP95 = bigBucket.percentilesOk.p95;
      // If this fires, the fixture/coalescing no longer produces a
      // fractional value here and this case needs a different bucket - not
      // a reason to weaken the assertion below.
      expect(Math.trunc(rawP95)).not.toBe(Math.round(rawP95));

      const cOwnWidthMs = inferWidthMs(cSeries.body.buckets.map((b: { startOffsetMs: number }) => b.startOffsetMs));
      const cExpectedX = expectedRate(bigBucket.startOffsetMs, cOwnWidthMs, cGlobalSeries.body.buckets);
      expect(cScatter.body.ok).toContainEqual([cExpectedX, Math.trunc(rawP95)]);
      expect(cScatter.body.ok).not.toContainEqual([cExpectedX, Math.round(rawP95)]);
    });

    it('PT-RQ-09b scatter point counts pin the accepted ±1 OK-series delta', async () => {
      // Against the reference report, Gatling renders 47 OK / 15 KO points for
      // "Add To Cart" and 54 OK / 9 KO for "Place Order"; we produce 48/15 and
      // 53/9. KO is exact in both. The OK difference is a known, accepted
      // rounding artifact: Gatling assigns an observation to the NEAREST
      // bucket (StatsHelper.timeToBucketNumber uses .round), while we floor.
      // Floor was kept deliberately - nearest-rounding would break
      // AC-STAT-2's lossless-coalescing invariant - so this pins the actual
      // number rather than loosely asserting "close to Gatling's count".
      // A future change to this figure should be visible here, not silent.
      //
      // Named, not derived: this is deviation D-03, pinned against two
      // SPECIFIC requests whose exact scatter counts were measured by hand
      // against the Gatling report, so a generic "pick any request" derivation
      // would defeat the point. "Add To Cart" is under the "Cart" group, so
      // under D-10 its identity is the joined path "Cart/Add To Cart"; "Place
      // Order" is one of the fixture's two genuinely groupless requests (the
      // other being "Search"), so its identity is unchanged by D-10. The
      // counts themselves (48/15/53/9) are untouched by D-10 - only the name
      // used to look "Add To Cart" up changed.
      const [cart, order] = await Promise.all([
        get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent('Cart/Add To Cart')}`),
        get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent('Place Order')}`),
      ]);
      expect(cart.body.ok).toHaveLength(48);
      expect(cart.body.ko).toHaveLength(15);
      expect(order.body.ok).toHaveLength(53);
      expect(order.body.ko).toHaveLength(9);
    });

    it('PT-RQ-11 a request page shows only its own errors', async () => {
      const all = await get(`/v1/runs/${runId}/errors`);
      const stats = await get(`/v1/runs/${runId}/stats?scope=request`);
      const failing = stats.body.stats.find((s: { koCount: number }) => s.koCount > 0);
      const own = await get(`/v1/runs/${runId}/errors?scope=request&name=${encodeURIComponent(failing.name)}`);
      expect(own.body.errors.length).toBeGreaterThan(0);
      expect(own.body.errors.reduce((n: number, e: { count: number }) => n + e.count, 0))
        .toBeLessThan(all.body.errors.reduce((n: number, e: { count: number }) => n + e.count, 0));
    });
  });

  describe('Appendix A.3 — group detail page', () => {
    it('PT-GR-01/02 cumulated response time and duration stay distinct', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=group`);
      const families = new Set(r.body.stats.map((s: { family: string }) => s.family));
      expect(families.has('group_cumulated')).toBe(true);
      expect(families.has('group_duration')).toBe(true);
      const nested = r.body.stats.filter((s: { name: string }) => s.name === 'Catalog/Recommendations');
      expect(nested).toHaveLength(2);
      // Collapsing these two into one metric is the most common group-parity error.
      expect(nested[0].meanMs).not.toBe(nested[1].meanMs);
    });

    it('PT-GR-03/05 both group families have their own distribution', async () => {
      for (const family of ['group_cumulated', 'group_duration']) {
        const r = await get(
          `/v1/runs/${runId}/distribution?scope=group&name=${encodeURIComponent('Catalog/Recommendations')}&family=${family}`,
        );
        expect(r.body.labels.length).toBeGreaterThan(0);
      }
    });

    it('PT-GR-09 group indicator bands are present', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=group`);
      // As with PT-RQ-02: a non-empty row set is the whole point, not an
      // incidental property. An empty group scope must fail loudly here.
      expect(r.body.stats.length).toBeGreaterThan(0);
      for (const row of r.body.stats) {
        expect(row.indicators.under + row.indicators.between + row.indicators.over).toBe(row.okCount);
      }
    });
  });

  describe('Appendix A.5/A.6 — columns and configurability', () => {
    it('PT-G-12 every §A.5 column is present at every scope', async () => {
      const r = await get(`/v1/runs/${runId}/stats`);
      for (const row of r.body.stats) {
        for (const k of ['count', 'okCount', 'koCount', 'errorRate', 'throughputRps',
                         'minMs', 'maxMs', 'meanMs', 'stddevMs']) {
          expect(typeof row[k]).toBe('number');
        }
        for (const p of ['p50', 'p75', 'p95', 'p99']) {
          expect(typeof row.percentiles[p]).toBe('number');
        }
      }
    });

    it('PT-K-01/02 non-default bounds restate history without a re-ingest (AC-PARITY-4)', async () => {
      const before = await get(`/v1/runs/${runId}/stats`);
      await setProjectIndicators({ lowerMs: 100, higherMs: 300 });
      const after = await get(`/v1/runs/${runId}/stats`);
      expect(after.body.bounds).toEqual({ lowerMs: 100, higherMs: 300 });
      expect(after.body.indicators.under).not.toBe(before.body.indicators.under);
      expect(after.body.indicators.under + after.body.indicators.between + after.body.indicators.over)
        .toBe(before.body.indicators.under + before.body.indicators.between + before.body.indicators.over);
      await setProjectIndicators({ lowerMs: 800, higherMs: 1200 });
    });

    it('PT-K-03 stats-table percentile columns follow the project setting active at REQUEST time (AC-PARITY-4)', async () => {
      // packages/contracts/src/settings.ts's docstring on ProjectSettingsSchema
      // promises percentiles are "read at REQUEST time, not frozen at ingest" -
      // the same guarantee PT-K-01/02 exercises for indicators, because "with
      // an exact histogram and a stored sketch, both are display thresholds
      // applied to complete data, and recomputing them per request yields
      // exactly what a re-ingest would." Task 21 fixed MetricsController.stats()
      // to honor that: it now recomputes percentile columns from the sketch
      // persisted in run_stat.sketch at the project's currently configured
      // percentile set, rather than returning the frozen run_stat.percentiles
      // JSON captured at ingest. Proven below against the already-shared
      // Appendix-A run: changing the setting post-ingest DOES move the
      // returned percentile keys, with no re-ingest.
      const before = await get(`/v1/runs/${runId}/stats`);
      expect(Object.keys(before.body.stats[0].percentiles).sort()).toEqual(['p50', 'p75', 'p95', 'p99']);
      await setProjectPercentiles([90, 99]);
      const after = await get(`/v1/runs/${runId}/stats`);
      expect(Object.keys(after.body.stats[0].percentiles).sort()).toEqual(['p90', 'p99']);
      await setProjectPercentiles([50, 75, 95, 99]); // restore

      const sibling = await createSiblingProject({ percentiles: [90, 99] });
      const siblingRunId = await ingestIntoSibling(sibling, 'parity-k03');

      const r = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${siblingRunId}/stats`)
        .set('Authorization', `Bearer ${sibling.readToken}`);
      expect(Object.keys(r.body.stats[0].percentiles).sort()).toEqual(['p90', 'p99']);

      // p95 survives in the BUCKETS regardless, or the scatter breaks:
      // BUCKET_PERCENTILES (packages/statistics/src/engine.ts) is a fixed
      // band independent of the stats-table percentile setting. The
      // percentiles-over-time chart is OK-only (Gatling titles it "Response
      // Time Percentiles over Time (OK)"), so this reads percentilesOk, not
      // the combined percentiles field.
      const s = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${siblingRunId}/series?scope=run&name=`)
        .set('Authorization', `Bearer ${sibling.readToken}`);
      expect(s.body.buckets[0].percentilesOk.p95).toBeDefined();
    });
  });
});
