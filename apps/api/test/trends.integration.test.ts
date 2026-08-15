import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StatsResponseSchema, TrendsResponseSchema } from '@perfportal/contracts';
import { Sketch } from '@perfportal/statistics';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * `GET /v1/runs/:id/trends` — a run in the context of its cohort.
 *
 * ═══ WHY ONE REAL RUN AND THE REST SEEDED ═══
 *
 * One case ingests through the real pipeline and asserts the endpoint reports
 * the same numbers `/stats` does for the same run, derived rather than written
 * down. That is what proves this endpoint is wired to real ingested data at
 * all.
 *
 * Every OTHER case is about the COHORT — which runs are grouped, in what
 * order, and how many there are — and that is a property of the query, not of
 * the statistics. Ingesting five reference bundles per case to test a `WHERE`
 * clause would put minutes on the suite for no extra coverage, so those cases
 * insert `run` and `run_stat` rows directly.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'trends-'));
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

async function ingested(extra: Record<string, unknown> = {}): Promise<string> {
  const q = new Queue('ingest', {
    connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' },
  });
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

/**
 * A complete run with the single run-scope stat row the endpoint joins to.
 *
 * `family: 'response_time'`, `scope: 'run'`, `name: ''` — the exact tuple
 * `run_stat`'s unique index and the query's join predicate agree on. A seed
 * that got any of them wrong would produce a run this endpoint cannot see,
 * which would look like a query bug rather than a fixture one.
 */
async function seedRun(opts: {
  simulation: string | null;
  startedAt: Date;
  toolStartedAt?: Date | null;
  status?: string;
  withStat?: boolean;
  count?: number;
}): Promise<string> {
  const id = randomUUID();
  const startedAt = opts.startedAt;

  await ctx.prisma.run.create({
    data: {
      id,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status: opts.status ?? 'complete',
      verdict: 'passed',
      tool: 'gatling',
      simulation: opts.simulation,
      startedAt,
      startedOn: startedAt,
      toolStartedAt: opts.toolStartedAt === undefined ? startedAt : opts.toolStartedAt,
      durationMs: 60_000,
      bundleKey: `k/${id}`,
      bundleSha256: 'x'.repeat(64),
      bundleBytes: BigInt(1),
      engineOptions: {},
    },
  });

  if (opts.withStat !== false) {
    const count = opts.count ?? 100;
    await ctx.pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
          error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
          sketch, sketch_kind)
       VALUES ($1,$2,$3,$4,'run','','response_time',$5,$5,0,0,1,9,5,2,1.5,$6,$7,'ddsketch')`,
      [
        randomUUID(),
        id,
        ctx.orgId,
        ctx.projectId,
        count,
        JSON.stringify({ p95: 8 }),
        // A REAL SKETCH, not a placeholder byte. The endpoint recomputes
        // percentiles from this the way /stats does, so a row carrying
        // unparseable bytes would fail deserialisation inside the reader and
        // look like a query bug.
        Buffer.from(sketchOf(count).serialize()),
      ],
    );
  }
  return id;
}

/** A sketch of `n` observations, so a seeded row can be quantiled. */
function sketchOf(n: number): Sketch {
  const s = new Sketch();
  for (let i = 0; i < n; i += 1) s.accept(i + 1);
  return s;
}

const at = (iso: string) => new Date(iso);

async function trends(runId: string, query = ''): Promise<request.Response> {
  return request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}/trends${query}`)
    .set(auth());
}

describe('GET /v1/runs/:id/trends', () => {
  it('reports the same run-scope numbers /stats does, for a really ingested run', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const statsRes = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats?scope=run&name=`)
      .set(auth());
    const stats = StatsResponseSchema.parse(statsRes.body);
    const runRow = stats.stats.find((s) => s.scope === 'run');
    expect(runRow).toBeDefined();

    const res = await trends(id);
    expect(res.status).toBe(200);
    const body = TrendsResponseSchema.parse(res.body);

    const mine = body.runs.find((r) => r.id === id);
    expect(mine).toBeDefined();
    // Derived from the other endpoint's answer, never written down: a
    // re-capture of the reference bundle must not break this.
    expect(mine!.count).toBe(runRow!.count);
    expect(mine!.okCount).toBe(runRow!.okCount);
    expect(mine!.koCount).toBe(runRow!.koCount);
    expect(mine!.percentiles).toEqual(runRow!.percentiles);
  });

  it('puts the asked-about run in its own cohort', async () => {
    ctx = await createTestApp();
    const id = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });

    const body = TrendsResponseSchema.parse((await trends(id)).body);
    expect(body.runId).toBe(id);
    expect(body.simulation).toBe('checkout');
    expect(body.runs.map((r) => r.id)).toEqual([id]);
    expect(body.cohortSize).toBe(1);
  });

  it('groups runs of the same simulation in the same project', async () => {
    ctx = await createTestApp();
    const a = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-02T10:00:00Z') });
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-03T10:00:00Z') });

    const body = TrendsResponseSchema.parse((await trends(a)).body);
    expect(body.runs).toHaveLength(3);
    expect(body.cohortSize).toBe(3);
  });

  it('treats a different simulation as a different cohort', async () => {
    ctx = await createTestApp();
    const a = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    await seedRun({ simulation: 'search', startedAt: at('2026-08-02T10:00:00Z') });

    const body = TrendsResponseSchema.parse((await trends(a)).body);
    expect(body.runs.map((r) => r.id)).toEqual([a]);
    expect(body.cohortSize).toBe(1);
  });

  it('treats NULL as its own equivalence class, not a wildcard', async () => {
    // `simulation = NULL` is NULL in SQL, so a naive `=` would return an empty
    // cohort here — not even the run being asked about. IS NOT DISTINCT FROM
    // is what makes these two find each other and exclude the named one.
    ctx = await createTestApp();
    const a = await seedRun({ simulation: null, startedAt: at('2026-08-01T10:00:00Z') });
    const b = await seedRun({ simulation: null, startedAt: at('2026-08-02T10:00:00Z') });
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-03T10:00:00Z') });

    const body = TrendsResponseSchema.parse((await trends(a)).body);
    expect(body.simulation).toBeNull();
    expect(new Set(body.runs.map((r) => r.id))).toEqual(new Set([a, b]));
    expect(body.cohortSize).toBe(2);
  });

  it('orders newest first by the effective start, not by ingest time', async () => {
    // toolStartedAt disagrees with startedAt on purpose: the effective key is
    // COALESCE(tool_started_at, started_at), the same one the run list uses.
    ctx = await createTestApp();
    const older = await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-03T10:00:00Z'),
      toolStartedAt: at('2026-08-01T10:00:00Z'),
    });
    const newer = await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-01T10:00:00Z'),
      toolStartedAt: at('2026-08-03T10:00:00Z'),
    });

    const body = TrendsResponseSchema.parse((await trends(older)).body);
    expect(body.runs.map((r) => r.id)).toEqual([newer, older]);
  });

  it('falls back to startedAt for a run the worker has not dated', async () => {
    ctx = await createTestApp();
    const withTool = await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-01T10:00:00Z'),
      toolStartedAt: at('2026-08-05T10:00:00Z'),
    });
    const withoutTool = await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-03T10:00:00Z'),
      toolStartedAt: null,
    });

    const body = TrendsResponseSchema.parse((await trends(withTool)).body);
    expect(body.runs.map((r) => r.id)).toEqual([withTool, withoutTool]);
  });

  it('caps runs with limit while cohortSize keeps counting', async () => {
    // Asked about the NEWEST run, so `limit` is a plain cap with nothing to
    // add back. cohort_size is a window function over the un-windowed inner
    // query, which is why it still reports the whole cohort.
    ctx = await createTestApp();
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    for (const day of ['02', '03', '04']) {
      await seedRun({ simulation: 'checkout', startedAt: at(`2026-08-${day}T10:00:00Z`) });
    }
    const newest = await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-05T10:00:00Z'),
    });

    const body = TrendsResponseSchema.parse((await trends(newest, '?limit=2')).body);
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r) => r.id)).toContain(newest);
    expect(body.cohortSize).toBe(5);
  });

  it('includes the asked-about run even when it is older than the window', async () => {
    // THE CONTRACT SAYS THE ASKED-ABOUT RUN IS ALWAYS IN `runs`, and a page
    // titled "this run in context" that omits the run is worse than useless.
    // Newest-first with a bare LIMIT excluded it the moment the cohort grew
    // past the window.
    ctx = await createTestApp();
    const oldest = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    for (const day of ['02', '03', '04', '05']) {
      await seedRun({ simulation: 'checkout', startedAt: at(`2026-08-${day}T10:00:00Z`) });
    }

    const body = TrendsResponseSchema.parse((await trends(oldest, '?limit=2')).body);
    expect(body.runs.map((r) => r.id)).toContain(oldest);
    expect(body.cohortSize).toBe(5);
  });

  it('adds the asked-about run to the newest window rather than replacing it', async () => {
    // The window stays the RECENT trend - the question is "is this simulation
    // getting worse", and a run three weeks old must still be able to show
    // what happened after it. So the newest `limit` are kept and the requested
    // run joins them: at most limit + 1 rows.
    ctx = await createTestApp();
    const oldest = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-02T10:00:00Z') });
    const third = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-03T10:00:00Z') });
    const fourth = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-04T10:00:00Z') });

    const body = TrendsResponseSchema.parse((await trends(oldest, '?limit=2')).body);
    // Newest first: the two newest, then the requested one appended in order.
    expect(body.runs.map((r) => r.id)).toEqual([fourth, third, oldest]);
    expect(body.runs.length).toBeLessThanOrEqual(2 + 1);
    expect(body.cohortSize).toBe(4);
  });

  it('excludes a run that has not finished parsing', async () => {
    // A gap in a trend reads as a regression, which is the one thing an
    // unparsed run must not look like.
    ctx = await createTestApp();
    const done = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    await seedRun({
      simulation: 'checkout',
      startedAt: at('2026-08-02T10:00:00Z'),
      status: 'parsing',
      withStat: false,
    });

    const body = TrendsResponseSchema.parse((await trends(done)).body);
    expect(body.runs.map((r) => r.id)).toEqual([done]);
    expect(body.cohortSize).toBe(1);
  });

  it('returns each run exactly once', async () => {
    // THE FANOUT REGRESSION. run_stat is unique on (run_id, scope, name,
    // family); a join that filtered only scope='run' would return one row per
    // family, putting the same run in the trend twice at the same timestamp
    // with different numbers.
    ctx = await createTestApp();
    const a = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });
    await seedRun({ simulation: 'checkout', startedAt: at('2026-08-02T10:00:00Z') });

    // A second run-scope row under a different family, which is exactly what
    // a latency roll-up would add.
    await ctx.pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
          error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
          sketch, sketch_kind)
       VALUES ($1,$2,$3,$4,'run','','latency',7,7,0,0,1,9,5,2,1.5,$5,$6,'ddsketch')`,
      [
        randomUUID(),
        a,
        ctx.orgId,
        ctx.projectId,
        JSON.stringify({ p95: 3 }),
        Buffer.from(sketchOf(7).serialize()),
      ],
    );

    const body = TrendsResponseSchema.parse((await trends(a)).body);
    const ids = body.runs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(body.cohortSize).toBe(2);
    // And the row it kept is the response_time one, not the latency one.
    expect(body.runs.find((r) => r.id === a)!.count).toBe(100);
  });

  it('does not read another org’s run', async () => {
    ctx = await createTestApp();
    const mine = await seedRun({ simulation: 'checkout', startedAt: at('2026-08-01T10:00:00Z') });

    const other = await ctx.prisma.org.create({
      data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' },
    });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'theirs', name: 'Theirs', settings: {} },
    });
    const theirRun = randomUUID();
    await ctx.prisma.run.create({
      data: {
        id: theirRun,
        orgId: other.id,
        projectId: otherProject.id,
        status: 'complete',
        tool: 'gatling',
        simulation: 'checkout',
        startedAt: at('2026-08-02T10:00:00Z'),
        startedOn: at('2026-08-02T10:00:00Z'),
        bundleKey: `k/${theirRun}`,
        bundleSha256: 'y'.repeat(64),
        bundleBytes: BigInt(1),
        engineOptions: {},
      },
    });

    // 404, never 403: the status must not distinguish "no such run" from
    // "not yours", which is what the sibling routes already reason about.
    expect((await trends(theirRun)).status).toBe(404);

    // And their run is not folded into my cohort despite sharing a simulation.
    const body = TrendsResponseSchema.parse((await trends(mine)).body);
    expect(body.runs.map((r) => r.id)).toEqual([mine]);
    expect(body.cohortSize).toBe(1);
  });

  it('rejects a malformed id with 400', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/not-a-uuid/trends')
      .set(auth());
    expect(res.status).toBe(400);
  });
});
