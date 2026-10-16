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
  VerificationSchema,
} from '@perfportal/contracts';
import { nearestRankIndex } from '@perfportal/statistics';
import { CONFIG } from '../src/auth/auth.module.js';
import { loadConfig } from '../src/config.js';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';
// Relative cross-package import, the precedent parity.e2e.test.ts sets:
// apps/api does not depend on plugin-gatling, and a test-only decode of the
// reference log is not a reason to add one.
import { parseSimulationLog } from '../../../packages/plugin-gatling/src/records.js';

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

/**
 * POSTs the reference bundle and returns the run's id WITHOUT processing it,
 * so the run stays `pending` and is read through the 202 builder. `waitMs: 0`
 * because no worker runs in this process: a wait would only expire.
 */
async function postWithoutProcessing(extra: Record<string, unknown> = {}): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...extra }))
    .attach('bundle', bundle, 'bundle.tgz');
  return res.body.id;
}

async function ingested(extra: Record<string, unknown> = {}): Promise<string> {
  const id = await postWithoutProcessing(extra);
  await runPipelineFor(ctx, id);
  return id;
}

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

/** An authenticated GET with the read token, the way every case here reads. */
const readAs = (path: string) => request(ctx.app.getHttpServer()).get(path).set(auth());

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

  /**
   * Both identity builders, because a field sent by only one of them is
   * missing exactly while a reader watches the run (CLAUDE.md, warmupMs).
   * The pending run is read through `respondWithRun`'s hand-written 202.
   */
  it('sends statsMethod on the run in both the 202 and the finished response', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const done = await readAs(`/v1/runs/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.statsMethod).toBe('exact-v1');

    const pendingId = await postWithoutProcessing();
    const pending = await readAs(`/v1/runs/${pendingId}`);
    expect(pending.status).toBe(202);
    expect(pending.body.statsMethod).toBe('exact-v1');
  });

  /**
   * 'exact-v1' is the column's DEFAULT, so the case above passes against a
   * `lifecycleOf` that hard-codes it. A run marked 'estimated' — every run
   * ingested before 2026-10-15 — is the value only a real read can produce.
   */
  it('sends the run\'s own statsMethod, not the default, for a run the old engine produced', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [id]);
    const res = await readAs(`/v1/runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.statsMethod).toBe('estimated');
  });

  /**
   * One verdict change, written the way the recompute writes it, so the two
   * builders are read against a row only a real read can surface.
   */
  const RULE = { scope: 'run', targetName: null, family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 800 };
  async function recordChange(runId: string, ruleSnapshot: unknown = RULE, changedAt = new Date('2026-10-16T09:00:00.000Z')): Promise<void> {
    const run = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { orgId: true, projectId: true } });
    await ctx.prisma.runVerdictChange.create({
      data: {
        runId,
        orgId: run.orgId,
        projectId: run.projectId,
        ruleSnapshot: ruleSnapshot as object,
        oldOutcome: 'passed',
        newOutcome: 'failed',
        oldValue: 790.4,
        newValue: 812,
        oldVerdict: 'passed',
        newVerdict: 'failed',
        changedAt,
      },
    });
  }
  const CHANGE = {
    rule: RULE,
    oldOutcome: 'passed',
    newOutcome: 'failed',
    oldValue: 790.4,
    newValue: 812,
    oldVerdict: 'passed',
    newVerdict: 'failed',
    changedAt: '2026-10-16T09:00:00.000Z',
  };

  /**
   * Both identity builders, for the reason statsMethod's case gives: a field
   * sent by only one is missing exactly while a reader watches the run.
   */
  it('sends verdictChanges on the run in both the 202 and the finished response', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await recordChange(id);
    const done = await readAs(`/v1/runs/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.verdictChanges).toEqual([CHANGE]);

    const pendingId = await postWithoutProcessing();
    await recordChange(pendingId);
    const pending = await readAs(`/v1/runs/${pendingId}`);
    expect(pending.status).toBe(202);
    expect(pending.body.verdictChanges).toEqual([CHANGE]);
  });

  it('sends an empty verdictChanges for a run no recompute changed', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const done = await readAs(`/v1/runs/${id}`);
    expect(done.body.verdictChanges).toEqual([]);
    const pendingId = await postWithoutProcessing();
    const pending = await readAs(`/v1/runs/${pendingId}`);
    expect(pending.status).toBe(202);
    expect(pending.body.verdictChanges).toEqual([]);
  });

  /**
   * A stored snapshot is JSON nothing validated at write time. One that does
   * not read as a rule is dropped from the list — the rest of the run, and
   * the rest of the list, still answer — rather than failing the read.
   */
  it('drops a verdict change whose stored rule does not parse, and keeps the rest in the order recorded', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await recordChange(id, { scope: 'galaxy' }, new Date('2026-10-16T08:00:00.000Z'));
    await recordChange(id);
    const res = await readAs(`/v1/runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.verdictChanges).toEqual([CHANGE]);
  });
});

/**
 * A verification row, written the way the verifier writes one, so the reads
 * below meet a row only a real read can surface.
 */
async function recordVerification(
  runId: string,
  row: {
    status: 'pending' | 'verified' | 'mismatch' | 'unverifiable';
    reason?: string | null;
    checkedAt?: string | null;
    verifierVersion?: number | null;
    figuresChecked?: number;
    mismatches?: unknown[];
    retainedUntil?: string | null;
  },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO run_verification
       (run_id, status, checked_at, verifier_version, figures_checked, mismatches,
        unverifiable_reason, raw_log_retained_until)
     VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6::jsonb, $7, $8::date)
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
       verifier_version = EXCLUDED.verifier_version, figures_checked = EXCLUDED.figures_checked,
       mismatches = EXCLUDED.mismatches, unverifiable_reason = EXCLUDED.unverifiable_reason,
       raw_log_retained_until = EXCLUDED.raw_log_retained_until`,
    [
      runId,
      row.status,
      row.checkedAt ?? null,
      row.verifierVersion ?? null,
      row.figuresChecked ?? 0,
      JSON.stringify(row.mismatches ?? []),
      row.reason ?? null,
      row.retainedUntil ?? null,
    ],
  );
}

describe('GET /v1/runs/:id — verification', () => {
  /**
   * Both identity builders, for the reason statsMethod's case gives: a field
   * sent by only one is missing exactly while a reader watches the run. An
   * UNVERIFIABLE row with a reason is the value only a real read produces —
   * a builder hard-coding pending, or dropping the reason, fails it.
   */
  it('sends the verification summary on the run in both the 202 and the finished response', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await recordVerification(id, { status: 'unverifiable', reason: 'raw_log_deleted', checkedAt: '2026-10-16T09:00:00Z' });
    const done = await readAs(`/v1/runs/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.verification).toEqual({ status: 'unverifiable', reason: 'raw_log_deleted' });

    const pendingId = await postWithoutProcessing();
    await recordVerification(pendingId, { status: 'mismatch', checkedAt: '2026-10-16T09:00:00Z' });
    const pending = await readAs(`/v1/runs/${pendingId}`);
    expect(pending.status).toBe(202);
    expect(pending.body.verification).toEqual({ status: 'mismatch', reason: null });
  });

  /**
   * ═══ NO ROW: PENDING WITH STATISTICS, NULL WITHOUT ═══
   *
   * A run with statistics the verifier has not reached yet is pending; a run
   * with none is not verifiable, and the header draws no mark for null. An
   * incomplete run nothing processed is the common one: the verifier never
   * gives it a row, so "pending" there would read "Verifying…" for ever.
   * Both builders, each with and without statistics.
   */
  it('sends pending for a run with statistics and no row, and null for one with none, in both bodies', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const done = await readAs(`/v1/runs/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.verification).toEqual({ status: 'pending', reason: null });

    const pendingId = await postWithoutProcessing();
    const pending = await readAs(`/v1/runs/${pendingId}`);
    expect(pending.status).toBe(202);
    expect(pending.body).toHaveProperty('verification', null);
    // The same 202 builder, once the run carries a stat row.
    await ctx.pool.query(
      `INSERT INTO run_stat (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
                             error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles)
       SELECT gen_random_uuid(), $2, org_id, project_id, scope, name, family, count, ok_count, ko_count,
              error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles
         FROM run_stat WHERE run_id = $1 AND scope = 'run'`,
      [id, pendingId],
    );
    const withStats = await readAs(`/v1/runs/${pendingId}`);
    expect(withStats.status).toBe(202);
    expect(withStats.body.verification).toEqual({ status: 'pending', reason: null });

    // An incomplete run nothing processed: finished, no statistics, a 200.
    const swept = await postWithoutProcessing();
    await ctx.pool.query(`UPDATE run SET status = 'incomplete', ingested_at = now() WHERE id = $1`, [swept]);
    const incomplete = await readAs(`/v1/runs/${swept}`);
    expect(incomplete.status).toBe(200);
    expect(incomplete.body.status).toBe('incomplete');
    expect(incomplete.body).toHaveProperty('verification', null);
  });
});

describe('GET /v1/runs/:id/verification', () => {
  const MISMATCH = {
    scope: 'request',
    name: 'Search',
    family: 'response_time',
    population: 'all',
    bucket: null,
    table: 'run_stat',
    figure: 'p95',
    stored: 812,
    recomputed: 790,
  };

  it('answers the whole record: status, when, by which verifier, the mismatches and the retention date', async () => {
    ctx = await createTestApp(
      {}, [], [{ provide: CONFIG, useValue: loadConfig({ ...process.env, RAW_LOG_RETENTION_DAYS: '90' }) }],
    );
    const id = await ingested();
    await ctx.pool.query(`UPDATE run SET ingested_at = '2026-10-16T09:00:00Z' WHERE id = $1`, [id]);
    await recordVerification(id, {
      status: 'mismatch',
      checkedAt: '2026-10-16T09:00:00.000Z',
      verifierVersion: 1,
      figuresChecked: 4120,
      mismatches: [MISMATCH],
      retainedUntil: '2027-01-14',
    });
    const res = await readAs(`/v1/runs/${id}/verification`);
    expect(res.status).toBe(200);
    expect(VerificationSchema.parse(res.body)).toEqual({
      status: 'mismatch',
      reason: null,
      checkedAt: '2026-10-16T09:00:00.000Z',
      verifierVersion: 1,
      figuresChecked: 4120,
      mismatches: [MISMATCH],
      // The ingest's UTC day plus 90 days, on a machine in any zone.
      rawLogRetainedUntil: '2027-01-14',
      rawLogDeleted: false,
    });
  });

  /** Nothing recorded — but the retention date is the run's, not the
   *  check's: derived from its ingest, so a run not checked yet has one too. */
  it('answers pending with nothing recorded for a run with no row yet', async () => {
    ctx = await createTestApp(
      {}, [], [{ provide: CONFIG, useValue: loadConfig({ ...process.env, RAW_LOG_RETENTION_DAYS: '90' }) }],
    );
    const id = await ingested();
    await ctx.pool.query(`UPDATE run SET ingested_at = '2026-10-16T09:00:00Z' WHERE id = $1`, [id]);
    const res = await readAs(`/v1/runs/${id}/verification`);
    expect(res.status).toBe(200);
    expect(VerificationSchema.parse(res.body)).toEqual({
      status: 'pending',
      reason: null,
      checkedAt: null,
      verifierVersion: null,
      figuresChecked: 0,
      mismatches: [],
      rawLogRetainedUntil: '2027-01-14',
      rawLogDeleted: false,
    });
  });

  /**
   * `rawLogDeleted` is the RUN's stamp, not the verification's reason: a run
   * verified before retention removed its log keeps "verified" and still
   * says the log is gone.
   */
  it('says the raw log is deleted from the run\'s own stamp, whatever the verification found', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await recordVerification(id, {
      status: 'verified', checkedAt: '2026-10-16T09:00:00Z', verifierVersion: 1, figuresChecked: 10,
      // Stored at verify time, before the log went: it describes nothing now.
      retainedUntil: '2027-01-14',
    });
    await ctx.pool.query(`UPDATE run SET raw_log_deleted_at = now() WHERE id = $1`, [id]);
    const res = await readAs(`/v1/runs/${id}/verification`);
    expect(res.status).toBe(200);
    const body = VerificationSchema.parse(res.body);
    expect([body.status, body.rawLogDeleted, body.rawLogRetainedUntil]).toEqual(['verified', true, null]);
  });

  /**
   * ═══ THE RETENTION DATE FOLLOWS THE CURRENT SETTING ═══
   *
   * Derived when read, from the run's ingest and the deployment's setting,
   * never from the column the verifier stored once: an operator who changes
   * RAW_LOG_RETENTION_DAYS gets the new date, and 0 (kept for ever) gets
   * none. The ingest is at 23:30 UTC, which is the NEXT day east of UTC: the
   * answer is the UTC day's.
   */
  it.each([
    ['30', '2026-11-15'],
    ['0', null],
  ])('answers the retention date under RAW_LOG_RETENTION_DAYS=%s, whatever the stored column says', async (days, until) => {
    ctx = await createTestApp(
      {}, [], [{ provide: CONFIG, useValue: loadConfig({ ...process.env, RAW_LOG_RETENTION_DAYS: days }) }],
    );
    const id = await ingested();
    await ctx.pool.query(`UPDATE run SET ingested_at = '2026-10-16T23:30:00Z' WHERE id = $1`, [id]);
    await recordVerification(id, { status: 'verified', checkedAt: '2026-10-17T09:00:00Z', verifierVersion: 1, retainedUntil: '2099-01-01' });
    const res = await readAs(`/v1/runs/${id}/verification`);
    expect(res.status).toBe(200);
    expect(VerificationSchema.parse(res.body).rawLogRetainedUntil).toBe(until);
  });

  it('refuses a malformed id with 400 INVALID_ID', async () => {
    ctx = await createTestApp();
    const res = await readAs('/v1/runs/not-a-uuid/verification');
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_ID']);
  });

  /**
   * Another org's run answers the missing run's own 404, as every run-scoped
   * read does — and its verification row is there, so a 404 is the lookup
   * refusing it rather than the absence of anything to show.
   */
  it('answers 404 for a run in another org, and for a run that does not exist', async () => {
    ctx = await createTestApp();
    const elsewhere = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
    const project = await ctx.prisma.project.create({ data: { orgId: elsewhere.id, slug: 'aardvark', name: 'Aardvark' } });
    const run = await ctx.prisma.run.create({
      data: {
        orgId: elsewhere.id,
        projectId: project.id,
        status: 'complete',
        verdict: 'not_evaluated',
        tool: 'gatling',
        bundleKey: `runs/${project.id}/${randomUUID()}.tgz`,
        bundleSha256: 'a'.repeat(64),
        bundleBytes: 1n,
        startedAt: new Date('2026-10-07T09:00:00Z'),
        startedOn: new Date('2026-10-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    await recordVerification(run.id, { status: 'verified', checkedAt: '2026-10-16T09:00:00Z' });
    expect((await readAs(`/v1/runs/${run.id}/verification`)).status).toBe(404);
    expect((await readAs(`/v1/runs/${randomUUID()}/verification`)).status).toBe(404);
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

  /**
   * The expectation is computed from the RAW LOG, never from the engine: the
   * nearest-rank value of every request's duration. A sketch estimate (the
   * pre-2026-10-15 path) misses several of these by a fraction of a
   * millisecond, so equality is the whole claim.
   */
  it('serves a new run exactly: /stats percentiles equal nearest-rank values of the raw log', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const values = [...parseSimulationLog(readFileSync(FIXTURE_LOG))]
      .filter((e): e is Extract<typeof e, { type: 'request' }> => e.type === 'request')
      .map((e) => e.endMs - e.startMs)
      .sort((a, b) => a - b);

    const res = await readAs(`/v1/runs/${id}/stats`);
    expect(res.status).toBe(200);
    const runRow = res.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    // Vacuity guard: the same population, or equality below proves nothing.
    expect(runRow.count).toBe(values.length);
    expect(Object.keys(runRow.percentiles).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(runRow.percentiles)) {
      expect(value, key).toBe(values[nearestRankIndex(Number(key.slice(1)), values.length)]);
    }

    // At a set the frozen column does not hold: the default set above is
    // answered by the column written at ingest, which is already exact, so
    // only a RECONFIGURED set proves the endpoint recomputes from the
    // histograms rather than from a sketch these rows no longer carry.
    await ctx.pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{percentiles}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify([90, 99.9]), ctx.projectId],
    );
    try {
      const after = await readAs(`/v1/runs/${id}/stats`);
      expect(after.status).toBe(200);
      const afterRow = after.body.stats.find(
        (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
      );
      expect(Object.keys(afterRow.percentiles).sort()).toEqual(['p90', 'p99.9']);
      for (const [key, value] of Object.entries(afterRow.percentiles)) {
        expect(value, key).toBe(values[nearestRankIndex(Number(key.slice(1)), values.length)]);
      }
    } finally {
      // Settings are shared state for the rest of this file.
      await ctx.pool.query(
        `UPDATE project SET settings = jsonb_set(settings, '{percentiles}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify([50, 75, 95, 99]), ctx.projectId],
      );
    }
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

    // AND A RECOMPUTED PERCENTILE STAYS INSIDE THE RANGE THIS RESPONSE REPORTS
    // BESIDE IT. This is the one path where the two do not come from the same
    // object: `minMs`/`maxMs` are the exact values the engine wrote to the row,
    // while these percentiles are re-derived from the DESERIALIZED sketch, whose
    // own extremes are bucket-approximate and sit OUTSIDE the true range. So a
    // clamp taken against the sketch would leave this serving a percentile above
    // the maximum printed next to it — which is why `clampPercentile` is called
    // with the row here (see its docstring).
    const row = after.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    ) as { minMs: number; maxMs: number };
    for (const [key, value] of Object.entries(afterPercentiles)) {
      expect(value, `${key}=${value} inside [${row.minMs}, ${row.maxMs}]`).toBeLessThanOrEqual(row.maxMs);
      expect(value, `${key}=${value} inside [${row.minMs}, ${row.maxMs}]`).toBeGreaterThanOrEqual(row.minMs);
    }

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

  /**
   * A list row carries its run's statsMethod, so the run list can mark an
   * estimated run's p95 with ≈. Both values, because 'exact-v1' is the
   * column's DEFAULT and a mapper that hard-coded it would pass the first
   * half alone.
   */
  it('sends each row’s own statsMethod', async () => {
    ctx = await createTestApp();
    const estimated = await ingested();
    const exact = await ingested();
    await ctx.pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [estimated]);

    const res = await request(ctx.app.getHttpServer()).get('/v1/projects/checkout/runs').set(auth());
    const byId = new Map(
      RunListResponseSchema.parse(res.body).items.map((item) => [item.id, item.statsMethod]),
    );
    expect(byId.get(estimated)).toBe('estimated');
    expect(byId.get(exact)).toBe('exact-v1');
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

  /**
   * THE SEAM THE SYNTACTIC GUARD CANNOT REACH.
   * `apps/api/test/remediation-coverage.test.ts` proves no handler
   * constructs a bare `HttpException`; this proves what the caller actually
   * receives, across the throw, `ProblemFilter` and the wire.
   *
   * Measured before the fix, every 404 in the product answered:
   *
   *     remediation: Check the request against the OpenAPI description at
   *                  /v1/openapi.json.
   *
   * — for a request that document describes perfectly. Asserted as a PAIR,
   * because "carries a remediation" alone is satisfied by the generic
   * fallback, which is the before-state.
   */
  it('answers a 404 with a fix the caller can act on, not with the generic fallback', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?project=no-such-project')
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body.remediation).not.toContain('OpenAPI description');
    // And it names a surface that exists — the failure this repository has
    // already paid for is a remediation pointing at a page or route nobody
    // can reach.
    expect(res.body.remediation).toContain('GET /v1/projects');
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

/**
 * REVIEW M02 + C02 — THE TRIAGE FIELDS HAVE TO CROSS THE SEAM.
 *
 * The repository's list SQL already selected `environment`, `branch`,
 * `commit_sha`, `duration_ms` and `tool_assertions`; the CONTRACT picked nine
 * fields, so all of it was fetched and thrown away. That is why the list could
 * not be triaged on, and why "Needs attention" could read zero over a run with
 * a failing simulation check — the outcomes were never sent.
 *
 * `RunList.test.tsx` proves the UI renders these, from fixtures it writes
 * itself. That proves the consumer and nothing about whether the endpoint
 * sends them. This reads them back off a really-ingested run, which is the
 * only thing that can.
 */
describe('GET /v1/runs — the triage fields', () => {
  it('carries identity, metrics and a check tally for a really-ingested run', async () => {
    ctx = await createTestApp();
    const id = await ingested({ environment: 'staging', branch: 'main' });

    const res = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(res.status).toBe(200);

    const parsed = RunListResponseSchema.parse(res.body);
    const mine = parsed.items.find((r) => r.id === id)!;
    expect(mine).toBeDefined();

    expect(mine.environment).toBe('staging');
    expect(mine.branch).toBe('main');
    expect(mine.durationMs).toBeGreaterThan(0);

    // The reference bundle's own numbers, so this cannot pass against a
    // hard-coded fixture: 895 requests at a 2.68% error rate.
    expect(mine.metrics).not.toBeNull();
    expect(mine.metrics!.count).toBe(895);
    expect(mine.metrics!.errorRate).toBeCloseTo(24 / 895, 6);
    expect(mine.metrics!.p95Ms).toBeGreaterThan(0);


    // And the simulation's own checks, which the list never used to send at
    // all — ParitySimulation declares three, one of which fails.
    expect(mine.checks).not.toBeNull();
    expect(mine.checks!.total).toBe(3);
    expect(mine.checks!.failed).toBe(1);
  });

  /** The same numbers the run's own page reports, from the same stat row —
   *  a list column that disagreed with the run it links to would be worse
   *  than no column. */
  it('agrees with the run’s own statistics', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const list = RunListResponseSchema.parse(
      (await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth())).body,
    );
    const stats = (
      await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${id}/stats?scope=run&name=`)
        .set(auth())
    ).body;

    const row = stats.stats[0];
    const mine = list.items.find((r) => r.id === id)!;
    expect(mine.metrics!.count).toBe(row.count);
    expect(mine.metrics!.errorRate).toBeCloseTo(row.errorRate, 9);
    expect(mine.metrics!.throughputRps).toBeCloseTo(row.throughputRps, 9);
  });
});


/**
 * THE LIST WAS THE LAST SURFACE READING A RAW PERCENTILE.
 *
 * A percentile cannot lie outside the sample it came from, and `minMs`/`maxMs`
 * are exact while the sketch carries 1% relative error — so the stored value
 * sometimes does. The clamp branch installed `clampPercentile` at every
 * assembler (the rollup, the bucket split, the evaluator's fallback, `/stats`)
 * and deliberately did NOT rewrite history, so raw values keep arriving from
 * rows written earlier.
 *
 * This row reads the FROZEN percentiles column rather than re-quantiling a
 * sketch per list item — the right trade, and untouched here: the clamp is
 * `Math.min(Math.max(v, min), max)` against two columns already on the row.
 *
 * Measured on the nine real runs in the developer database: 9 stored values
 * sit above their own maximum, 3 at RUN scope, worst +12.46 ms. All three
 * happen to be p99 while this row surfaces p95, so the disagreement was not
 * yet visible — which is the argument for closing it before a reader reports
 * two different p95s for one run.
 *
 * ASSERTED AS A PAIR. "Equals the maximum" alone is satisfied by a list that
 * pins every p95 to its max, which would flatten the column for every run
 * there is; the in-range case is what rules that out.
 */
describe('GET /v1/runs — the list clamps like every other surface', () => {
  const runStat = (id: string, p95: number, maxMs: number) =>
    ctx.pool.query(
      `UPDATE run_stat SET percentiles = jsonb_set(percentiles, '{p95}', $2::jsonb),
              max_ms = $3, min_ms = 0
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [id, JSON.stringify(p95), maxMs],
    );

  const p95Of = async (id: string) => {
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    return RunListResponseSchema.parse(res.body).items.find((r) => r.id === id)!.metrics!.p95Ms;
  };

  it('projects a stored percentile back onto the run\'s own maximum', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    // The reference run's real shape: p99 2515.4601… against an exact max of
    // 2503. Written onto p95 because that is the one this row surfaces.
    await runStat(id, 2515.4601126102525, 2503);
    expect(await p95Of(id)).toBe(2503);
  });

  it('leaves a percentile inside its range exactly alone', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await runStat(id, 1234.5, 2503);
    expect(await p95Of(id)).toBe(1234.5);
  });
});

/**
 * A REPEATED QUERY PARAMETER IS A 400, NEVER A 500.
 *
 * Express parses `?q=a&q=b` into an ARRAY, and both run lists used to read
 * every filter as a string: `q.trim()` on an array is a TypeError, and a
 * repeated `project` or `test` reached Prisma as an array. Both are a request
 * the caller can only have got wrong, so each answers 400 `INVALID_QUERY`
 * naming the parameter — the refusal `GET /v1/tests` gives the same mistake.
 * `cursor` already answered 400, but as INVALID_CURSOR quoting `"a,b"`, which
 * blames the value rather than the repetition; it is the same refusal now.
 * `limit` is left alone on purpose: `parseLimit` coerces anything unreadable
 * to the default page size, which is that parameter's documented rule.
 */
describe('a repeated query parameter', () => {
  const refusesTwice = (res: request.Response, name: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('INVALID_QUERY');
    expect(res.body.detail).toContain(`"${name}"`);
    expect(res.body.remediation).toContain(name);
  };

  it.each(['q', 'status', 'verdict', 'project', 'test', 'cursor'])(
    'is refused on GET /v1/runs: %s',
    async (name) => {
      ctx = await createTestApp();
      const res = await request(ctx.app.getHttpServer())
        .get(`/v1/runs?${name}=a&${name}=b`)
        .set(auth());
      refusesTwice(res, name);
    },
  );

  it.each(['q', 'status', 'verdict', 'cursor'])(
    'is refused on GET /v1/projects/:slug/runs: %s',
    async (name) => {
      ctx = await createTestApp();
      const res = await request(ctx.app.getHttpServer())
        .get(`/v1/projects/checkout/runs?${name}=a&${name}=b`)
        .set(auth());
      refusesTwice(res, name);
    },
  );

  it('still answers a single value of each, so the refusal is about the repetition', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?q=checkout&status=complete&verdict=passed&project=checkout')
      .set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    RunListResponseSchema.parse(res.body);
  });
});
