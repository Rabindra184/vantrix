import { bandsFrom, Histogram, HISTOGRAM_KIND, runEngine } from '@perfportal/statistics';
import type { CanonicalEvent } from '@perfportal/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, ERROR_SERIES_SQL, MetricReader, MetricWriter, SERIES_SQL, USER_SERIES_SQL } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');

function events(): CanonicalEvent[] {
  const base = STARTED_AT.getTime();
  const out: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
  ];
  for (let i = 0; i < 400; i++) {
    const startMs = base + i * 25;
    const endMs = startMs + (i % 13) * 40 + 5;
    out.push({
      type: 'request',
      name: i % 2 === 0 ? 'GET /a' : 'GET /b',
      groups: [],
      userId: String(i),
      startMs,
      endMs,
      ok: i % 17 !== 0,
      message: i % 17 === 0 ? 'status 500' : undefined,
    });
    // A user session bracketing each request, so the run also exercises
    // per-scenario arrival/concurrency buckets (run_user_bucket).
    out.push({ type: 'user', scenario: 'S', userId: String(i), kind: 'start', tsMs: startMs });
    out.push({ type: 'user', scenario: 'S', userId: String(i), kind: 'end', tsMs: endMs });
  }
  return out;
}

async function seedRun() {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const run = await prisma.run.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      status: 'parsing',
      tool: 'gatling',
      bundleKey: 'k',
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

async function persist(
  ctx: { orgId: string; projectId: string; runId: string },
  // Defaulted, so every existing caller is unchanged. The fixed `events()`
  // above produce a single distinct error message, which is enough for a round
  // trip and can never produce a folded row — the error-series cases below
  // pass their own.
  evts: CanonicalEvent[] = events(),
) {
  const result = runEngine(evts, { percentiles: [50, 95, 99] });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await new MetricWriter().persist(client, { ...ctx, runStartedOn: STARTED_ON }, result);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return result;
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('MetricWriter / MetricReader', () => {
  it('round-trips stats with the values the engine produced', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);

    const stored = await new MetricReader(pool).stats({ orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId);
    const engineRun = result.stats.find((s) => s.scope === 'run');
    const storedRun = stored.find((s) => s.scope === 'run');

    expect(storedRun).toBeDefined();
    expect(storedRun?.count).toBe(engineRun?.count);
    expect(storedRun?.koCount).toBe(engineRun?.koCount);
    expect(storedRun?.maxMs).toBeCloseTo(engineRun?.maxMs ?? -1, 6);
    expect(storedRun?.stddevMs).toBeCloseTo(engineRun?.stddevMs ?? -1, 6);
    expect(storedRun?.percentiles['p95']).toBeCloseTo(engineRun?.percentiles['p95'] ?? -1, 6);
  });

  it('answers a percentile that was never stored in the JSONB — the point of keeping the sketch', async () => {
    // Reads the sketch the same way production does now: through stats(),
    // whose `sketch` field is what MetricsController.stats() (K-03) recomputes
    // percentiles from. There is no longer a standalone MetricReader.sketch()
    // — it had no production caller (PipelineService evaluates SLA rules
    // against the in-memory sketch from the same runEngineAsync call that
    // writes this column, not by reading it back) — so this test now exercises
    // the sketch column through its one real reader instead.
    const ctx = await seedRun();
    const result = await persist(ctx);

    const stored = await new MetricReader(pool).stats({ orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId);
    expect(Object.keys(stored[0]!.percentiles)).not.toContain('p99.9');

    const storedRun = stored.find((s) => s.scope === 'run');
    const original = result.stats.find((s) => s.scope === 'run')?.sketch;

    expect(storedRun?.sketch).not.toBeNull();
    expect(storedRun!.sketch!.count).toBe(original!.count);
    for (const q of [0.5, 0.95, 0.99]) {
      expect(storedRun!.sketch!.quantile(q)).toBeCloseTo(original!.quantile(q), 6);
    }
    expect(Number.isFinite(storedRun!.sketch!.quantile(0.999))).toBe(true);
  });

  it('round-trips series buckets and error rows', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };

    const buckets = await reader.series(tenant, ctx.runId, STARTED_ON, { scope: 'run', name: '', family: 'response_time' });
    const expected = [...result.series.values()].find((v) => v.scope === 'run')?.buckets ?? [];
    expect(buckets).toHaveLength(expected.length);
    expect(buckets.reduce((a, b) => a + b.startedCount, 0)).toBe(
      expected.reduce((a, b) => a + b.startedCount, 0),
    );

    // errors() now defaults to run scope (see the "defaults to run scope" test
    // below) — result.errors carries a run-scope AND a request-scope row per
    // failure (engine.ts), so the round-trip comparison must be against the
    // run-scope subset, not the full (double-counted) list.
    const errors = await reader.errors(tenant, ctx.runId);
    expect(errors.reduce((a, e) => a + e.count, 0)).toBe(
      result.errors.filter((e) => e.scope === 'run').reduce((a, e) => a + e.count, 0),
    );
  });

  // Task 17: buckets.ts now tracks OK-only and KO-only sketches alongside the
  // combined one, because Gatling's percentiles-over-time chart is OK-only and
  // its scatter is two independent status-filtered series. This proves the
  // write/read round trip actually carries the status-filtered figures, not
  // just the combined one relabeled — comparing against the in-memory
  // engine's own sketchOk/sketchKo, not just checking the columns are present.
  it('round-trips per-status bucket percentiles, distinct from the combined figure for a mixed bucket', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };

    const stored = await reader.series(tenant, ctx.runId, STARTED_ON, { scope: 'run', name: '', family: 'response_time' });
    const engineBuckets = [...result.series.values()].find((v) => v.scope === 'run')?.buckets ?? [];

    const mixed = engineBuckets.find((b) => b.okCount > 0 && b.koCount > 0);
    expect(mixed).toBeDefined();
    const storedB = stored.find((b) => b.startOffsetMs === mixed!.startOffsetMs);
    expect(storedB).toBeDefined();

    // Round-trips against the engine's OWN sketchOk/sketchKo (all eight
    // configured bands), not just spot-checking one figure.
    for (const key of Object.keys(storedB!.percentilesOk)) {
      const p = Number(key.slice(1)) / 100;
      expect(storedB!.percentilesOk[key]).toBeCloseTo(mixed!.sketchOk.quantile(p), 6);
      expect(storedB!.percentilesKo[key]).toBeCloseTo(mixed!.sketchKo.quantile(p), 6);
    }

    // And the whole point: the OK-only figures must be their OWN thing, not
    // the combined sketch relabeled. If a bucket's OK subset and combined
    // set agreed on all eight configured bands this would be a false pass,
    // but that is not plausible here — koCount > 0 in this bucket, so the
    // combined sketch strictly contains points the OK-only one does not.
    expect(storedB!.percentilesOk).not.toEqual(storedB!.percentiles);
  });

  it('will not read another project\'s metrics', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: '00000000-0000-0000-0000-000000000000' },
      ctx.runId,
    );
    expect(stats).toEqual([]);
  });

  it('prunes partitions — the series query plan touches one partition, not twelve', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    // EXPLAIN the exact query MetricReader.series runs (same SQL, same parameter
    // order) so that breaking the implementation's partition predicate breaks this
    // test — see SERIES_SQL's docstring in src/metrics/read.ts.
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ${SERIES_SQL}`,
      [STARTED_ON, ctx.runId, ctx.orgId, ctx.projectId, 'run', '', 'response_time'],
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    // Distinct partition names, not raw substring matches: an index-scan plan names
    // the partition twice on one line (once as "<partition>_pkey", once as the bare
    // relation) — e.g. "Index Scan using run_series_bucket_2026_08_pkey on
    // run_series_bucket_2026_08 run_series_bucket" — which would otherwise double-count
    // a single pruned partition and mask a real pruning failure the same way.
    const scanned = new Set(plan.match(/run_series_bucket_2026_\d\d/g) ?? []).size;
    expect(scanned).toBe(1);
  });

  it('keeps family second-from-last in the series primary key', async () => {
    // 0001_init records that there is deliberately NO secondary index on
    // (run_started_on, run_id, scope, name), because those columns are a strict
    // prefix of this key and its btree already serves them. Reordering the key
    // silently costs every such lookup its index, once per partition, with
    // nothing erroring — and the pruning test cannot see it, because every
    // query we issue today binds all five columns with equality.
    const { rows } = await pool.query(
      `SELECT pg_get_indexdef(conindid) AS def
         FROM pg_constraint WHERE conname = 'run_series_bucket_pkey'`,
    );
    expect(rows[0]?.def).toContain(
      '(run_started_on, run_id, scope, name, family, start_offset_ms)',
    );
  });

  it('persists histograms that round-trip out of the database', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    const { rows } = await pool.query<{ histogram_ok: Buffer; histogram_kind: string }>(
      `SELECT histogram_ok, histogram_kind FROM run_stat
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [ctx.runId],
    );
    expect(rows[0]?.histogram_kind).toBe(HISTOGRAM_KIND);
    const h = Histogram.deserialize(new Uint8Array(rows[0]!.histogram_ok));
    expect(h.total).toBeGreaterThan(0);
    expect(bandsFrom(h, 0, { lowerMs: 800, higherMs: 1200 }).under).toBeGreaterThan(0);
  });

  it('persists per-scenario user buckets', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    const { rows } = await pool.query(
      `SELECT scenario, started, max_concurrent FROM run_user_bucket
        WHERE run_started_on = $1 AND run_id = $2 ORDER BY scenario, start_offset_ms`,
      [STARTED_ON, ctx.runId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('persists errors with a scope and name', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    const { rows } = await pool.query(
      `SELECT scope, name FROM run_error WHERE run_id = $1 ORDER BY scope`,
      [ctx.runId],
    );
    expect(rows.map((r) => r.scope)).toContain('request');
  });

  it('reads histograms back and folds bands at two different bounds', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const reader = new MetricReader(pool);
    const h = await reader.histograms({ orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId,
      { scope: 'run', name: '', family: 'response_time' });
    expect(h).not.toBeNull();
    const a = bandsFrom(h!.ok, 0, { lowerMs: 800, higherMs: 1200 });
    const b = bandsFrom(h!.ok, 0, { lowerMs: 50, higherMs: 100 });
    expect(a).not.toEqual(b);              // same bytes, different settings
    expect(a.under + a.between + a.over).toBe(b.under + b.between + b.over);
  });

  it('prunes partitions when reading user buckets', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${USER_SERIES_SQL}`,
      [STARTED_ON, ctx.runId, ctx.orgId, ctx.projectId],
    );
    expect(JSON.stringify(rows)).not.toMatch(/run_user_bucket_2026_(0[1-7]|09|1[0-2])/);
  });

  it('defaults to run scope so a caller cannot double-count', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };
    const defaulted = await reader.errors(tenant, ctx.runId);
    const explicit = await reader.errors(tenant, ctx.runId, { scope: 'run', name: '' });
    expect(defaulted).toEqual(explicit);
    // The same failure also has a request-scope row; totals must not be summed
    // across scopes. Run-scope total must equal the run's KO count, not twice it.
    const { rows } = await pool.query<{ ko: string }>(
      `SELECT ko_count::text AS ko FROM run_stat
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [ctx.runId],
    );
    const runKo = Number(rows[0]?.ko ?? 0);
    expect(defaulted.reduce((n, e) => n + e.count, 0)).toBe(runKo);
  });

  it('filters errors by scope and name', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };
    const runScoped = await reader.errors(tenant, ctx.runId, { scope: 'run', name: '' });
    const { rows } = await pool.query<{ name: string }>(
      `SELECT DISTINCT name FROM run_error WHERE run_id = $1 AND scope = 'request' LIMIT 1`,
      [ctx.runId],
    );
    const reqName = rows[0]?.name;
    expect(reqName).toBeDefined();
    const reqScoped = await reader.errors(tenant, ctx.runId, { scope: 'request', name: reqName as string });
    expect(reqScoped.length).toBeGreaterThan(0);
    expect(reqScoped.reduce((n, e) => n + e.count, 0))
      .toBeLessThan(runScoped.reduce((n, e) => n + e.count, 0));
  });

  it('round-trips a series through its family', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };

    // Everything the engine emits today is response_time; groups add a second
    // family in the next task. What this pins is that family survives the write
    // and is required on the read — a reader ignoring it would return every
    // family's rows interleaved once groups exist.
    const stored = await reader.series(tenant, ctx.runId, STARTED_ON, {
      scope: 'run', name: '', family: 'response_time',
    });
    const engineBuckets = [...result.series.values()].find((v) => v.scope === 'run')?.buckets ?? [];

    expect(stored).toHaveLength(engineBuckets.length);
    expect(stored.length).toBeGreaterThan(0);

    // A family that was never written returns nothing rather than everything.
    const wrong = await reader.series(tenant, ctx.runId, STARTED_ON, {
      scope: 'run', name: '', family: 'group_cumulated',
    });
    expect(wrong).toEqual([]);
  });
});

describe('error series', () => {
  const BASE = STARTED_AT.getTime();
  const start: CanonicalEvent = {
    type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: BASE,
  };
  const fail = (i: number, message: string): CanonicalEvent => ({
    type: 'request', name: 'GET /a', groups: [], userId: String(i),
    startMs: BASE + i * 100, endMs: BASE + i * 100 + 20, ok: false, message,
  });

  it('round-trips rows, mapping the folded remainder to null', async () => {
    const ctx = await seedRun();
    // Seven distinct messages at descending frequency: five are kept by name
    // and two fold, so both row kinds are exercised.
    const evts: CanonicalEvent[] = [start];
    for (let rank = 0; rank < 7; rank += 1) {
      for (let n = 0; n < 10 - rank; n += 1) evts.push(fail(rank * 10 + n, `m${rank}`));
    }
    const result = await persist(ctx, evts);

    const rows = await new MetricReader(pool).errorSeries(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON,
    );

    // Derived from what the engine produced, never written down.
    expect(rows).toHaveLength(result.errorSeries.rows.length);
    expect(rows.some((r) => r.message === null)).toBe(true);
    expect(rows.every((r) => r.bucketWidthMs === result.errorSeries.bucketWidthMs)).toBe(true);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(
      result.errorSeries.rows.reduce((n, r) => n + r.count, 0),
    );
  });

  it('does not collide when a real message is literally "other"', async () => {
    // The failure `is_other` exists to prevent. With a magic message value the
    // folded row and this real one share a primary key, and the INSERT fails
    // the whole ingest rather than merely drawing something wrong.
    const ctx = await seedRun();
    // Named once and used for both the input and the expectation, so the two
    // cannot drift — and so the test says which literal is load-bearing.
    const COLLIDING = 'other';
    const evts: CanonicalEvent[] = [start];
    // Frequent enough to be kept BY NAME (20), plus six rarer messages so that
    // something really does fold as well.
    for (let n = 0; n < 20; n += 1) evts.push(fail(n, COLLIDING));
    for (let rank = 0; rank < 6; rank += 1) {
      for (let n = 0; n < 6 - rank; n += 1) evts.push(fail(100 + rank * 10 + n, `m${rank}`));
    }
    await persist(ctx, evts);

    const rows = await new MetricReader(pool).errorSeries(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON,
    );
    expect(rows.some((r) => r.message === COLLIDING)).toBe(true);
    expect(rows.some((r) => r.message === null)).toBe(true);
  });

  it('prunes partitions when reading error buckets', async () => {
    // Mirrors the run_user_bucket pruning test, and EXPLAINs the exported
    // constant rather than a copy of it — a test against a copy keeps passing
    // after the real query loses its partition predicate.
    const ctx = await seedRun();
    await persist(ctx);
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${ERROR_SERIES_SQL}`,
      [STARTED_ON, ctx.runId, ctx.orgId, ctx.projectId],
    );
    expect(JSON.stringify(rows)).not.toMatch(/run_error_bucket_2026_(0[1-7]|09|1[0-2])/);
  });
});
