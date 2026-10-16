import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  createPool,
  createPrisma,
  MetricReader,
  MetricWriter,
  RecomputeRepository,
} from '@perfportal/persistence';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { BlobStore } from '@perfportal/storage';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import { RecomputeService } from '../src/recompute/recompute.service.js';
import { loadWorkerConfig } from '../src/config.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);

let bundle: Buffer;
/** The RAW log: what a live run stores, and what the expectations are computed from. */
let log: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recompute-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  log = readFileSync(FIXTURE_LOG);
  await blobs.ensureBucket();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket', 'run_series_bucket',
  'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

async function freshOrg() {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

/** An uploaded run: its bundleKey holds a gzipped tar of the results directory. */
async function seedRun(bundleBody: Buffer) {
  const { orgId, projectId } = await freshOrg();
  const key = `runs/test/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([bundleBody]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(bundleBody).digest('hex'),
      bundleBytes: BigInt(bundleBody.length),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return { orgId, projectId, runId: run.id, bundleKey: key };
}

/** A live run: its bundleKey ends in /simulation.log and holds the raw log bytes. */
async function seedLiveRun(rawLog: Buffer) {
  const { orgId, projectId } = await freshOrg();
  const key = `runs/test/${randomUUID()}/simulation.log`;
  await blobs.putStream(key, Readable.from([rawLog]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(rawLog).digest('hex'),
      bundleBytes: BigInt(rawLog.length), streamOffset: BigInt(rawLog.length),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return { orgId, projectId, runId: run.id, bundleKey: key };
}

function pipeline(): PipelineService {
  return new PipelineService(config, prisma, pool, blobs);
}

function service(): RecomputeService {
  return new RecomputeService(config, prisma, pool, blobs);
}

/**
 * Makes a freshly ingested run look like one written before exact statistics:
 * labelled estimated, every stat row carrying a sketch and the v1 histogram
 * label, and every stored p95 nudged off its exact value — so a recompute that
 * changed nothing would be visible in each of those places.
 */
async function makeLegacy(runId: string): Promise<void> {
  await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [runId]);
  await pool.query(
    `UPDATE run_stat SET sketch = '\\x01'::bytea, histogram_kind = 'sparse-ms-v1' WHERE run_id = $1`,
    [runId],
  );
  await pool.query(
    `UPDATE run_stat
        SET percentiles = jsonb_set(percentiles, '{p95}', to_jsonb((percentiles->>'p95')::float8 + 0.46))
      WHERE run_id = $1 AND percentiles ? 'p95'`,
    [runId],
  );
}

/** Nearest rank on integers, as packages/statistics computes it: ⌈p·n/100⌉, p = 0 → min. */
function exactPercentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (p === 0) return sorted[0]!;
  return sorted[Math.ceil((p * sorted.length) / 100) - 1]!;
}

/** Every request's response time, decoded straight from the raw log. */
function allDurations(raw: Buffer): number[] {
  const out: number[] = [];
  for (const e of parseSimulationLog(raw)) {
    if (e.type === 'request') out.push(e.endMs - e.startMs);
  }
  return out;
}

interface StatRow {
  sketch: Buffer | null;
  histogram_kind: string | null;
  percentiles: Record<string, number>;
  count: number;
}

async function runStatRow(runId: string, scope: string, name: string): Promise<StatRow> {
  const { rows } = await pool.query<StatRow>(
    `SELECT sketch, histogram_kind, percentiles, count FROM run_stat
      WHERE run_id = $1 AND scope = $2 AND name = $3 AND family = 'response_time'`,
    [runId, scope, name],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function runRow(runId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(`SELECT * FROM run WHERE id = $1`, [runId]);
  return rows[0]!;
}

async function counts(runId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [
    'run_stat', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_error_bucket',
    'run_assertion', 'run_verdict_change',
  ]) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}" WHERE run_id = $1`, [runId]);
    out[t] = Number(rows[0]!.n);
  }
  return out;
}

/** Replaces the run's stored assertions with one, as an earlier ingest recorded it. */
async function storeAssertion(
  ctx: { runId: string; orgId: string; projectId: string },
  snapshot: Record<string, unknown>,
  outcome: string,
  actualValue: number,
  verdict: string,
): Promise<void> {
  await pool.query(`DELETE FROM run_assertion WHERE run_id = $1`, [ctx.runId]);
  await pool.query(
    `INSERT INTO run_assertion (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'legacy')`,
    [randomUUID(), ctx.runId, ctx.orgId, ctx.projectId, snapshot.id, JSON.stringify(snapshot), outcome, actualValue],
  );
  await pool.query(`UPDATE run SET verdict = $2 WHERE id = $1`, [ctx.runId, verdict]);
}

function p95Snapshot(threshold: number) {
  return {
    id: randomUUID(), scope: 'run', targetName: null, family: 'response_time',
    metric: 'p95', comparator: 'lte', threshold,
  };
}

async function legacyRun() {
  const ctx = await seedRun(bundle);
  await pipeline().process(ctx.runId, { queueWillRetry: false });
  await makeLegacy(ctx.runId);
  return ctx;
}

describe('RecomputeService', () => {
  it('rewrites an estimated run exactly and marks it exact-v1', async () => {
    const { runId } = await legacyRun();
    expect((await runStatRow(runId, 'run', '')).sketch).not.toBeNull();

    expect(await service().recompute(runId)).toBe('recomputed');

    const row = await runStatRow(runId, 'run', '');
    expect(row.sketch).toBeNull();
    expect(row.histogram_kind).toBe('sparse-ms-v2');
    expect(row.percentiles.p95).toBe(exactPercentile(allDurations(log), 95));
    expect(row.count).toBe(allDurations(log).length);
    const run = await runRow(runId);
    expect(run.stats_method).toBe('exact-v1');
    expect(run.recomputed_at).not.toBeNull();
  });

  it('is idempotent: a second recompute reports already_exact and writes nothing', async () => {
    const { runId } = await legacyRun();
    expect(await service().recompute(runId)).toBe('recomputed');
    const before = await runRow(runId);
    const rowsBefore = await counts(runId);

    expect(await service().recompute(runId)).toBe('already_exact');

    const after = await runRow(runId);
    expect(after.recomputed_at).toEqual(before.recomputed_at);
    expect(await counts(runId)).toEqual(rowsBefore);
  });

  it('preserves identity, number, test, note, status and timestamps', async () => {
    const { runId } = await legacyRun();
    await pool.query(
      `UPDATE run SET note = 'baseline after the cache change', note_updated_at = now() WHERE id = $1`,
      [runId],
    );
    const REWRITTEN = ['stats_method', 'verdict', 'tool_assertions', 'duration_ms', 'activity_ms', 'recomputed_at'];
    const strip = (r: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !REWRITTEN.includes(k)));
    const before = await runRow(runId);
    // The fixture actually exercises the columns this case claims to preserve.
    expect(before.run_number).not.toBeNull();
    expect(before.test_id).not.toBeNull();
    expect(before.note).toBe('baseline after the cache change');

    expect(await service().recompute(runId)).toBe('recomputed');

    const after = await runRow(runId);
    expect(strip(after)).toEqual(strip(before));
    // Re-derived from the same log by the same engine, so they come back equal.
    expect(after.duration_ms).toBe(before.duration_ms);
    expect(after.activity_ms).toBe(before.activity_ms);
    expect(after.tool_assertions).toEqual(before.tool_assertions);
  });

  it('records a verdict change when an exact value crosses a frozen threshold', async () => {
    const ctx = await legacyRun();
    const exactP95 = exactPercentile(allDurations(log), 95);
    // A rule the ESTIMATED value passed and the exact one fails.
    const snapshot = p95Snapshot(exactP95 - 0.5);
    await storeAssertion(ctx, snapshot, 'passed', exactP95 - 0.6, 'passed');

    expect(await service().recompute(ctx.runId)).toBe('recomputed');

    expect((await runRow(ctx.runId)).verdict).toBe('failed');
    const changes = await new RecomputeRepository(pool).verdictChanges(ctx.runId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      oldOutcome: 'passed', newOutcome: 'failed', oldVerdict: 'passed', newVerdict: 'failed',
      oldValue: exactP95 - 0.6, newValue: exactP95,
    });
    expect(changes[0]!.ruleSnapshot).toEqual(snapshot);
    // The re-judged assertion replaces the old one, still under the rule's id.
    const { rows } = await pool.query(
      `SELECT rule_id, rule_snapshot, outcome, actual_value FROM run_assertion WHERE run_id = $1`,
      [ctx.runId],
    );
    expect(rows).toEqual([
      { rule_id: snapshot.id, rule_snapshot: snapshot, outcome: 'failed', actual_value: exactP95 },
    ]);
  });

  it('judges with the frozen snapshot, not the current rule', async () => {
    const ctx = await legacyRun();
    const exactP95 = exactPercentile(allDurations(log), 95);
    const snapshot = p95Snapshot(exactP95 + 1000);
    await storeAssertion(ctx, snapshot, 'passed', exactP95 + 0.46, 'passed');
    // The same rule as it reads TODAY, edited to a threshold the run fails.
    await prisma.slaRule.create({
      data: {
        id: snapshot.id, orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: exactP95 - 1000,
      },
    });

    expect(await service().recompute(ctx.runId)).toBe('recomputed');

    expect((await runRow(ctx.runId)).verdict).toBe('passed');
    expect(await new RecomputeRepository(pool).verdictChanges(ctx.runId)).toEqual([]);
    const { rows } = await pool.query(`SELECT rule_snapshot FROM run_assertion WHERE run_id = $1`, [ctx.runId]);
    expect(rows.map((r) => r.rule_snapshot)).toEqual([snapshot]);
  });

  it('writes no change row when the outcome is the same', async () => {
    const ctx = await legacyRun();
    const exactP95 = exactPercentile(allDurations(log), 95);
    const snapshot = p95Snapshot(exactP95 + 1000);
    await storeAssertion(ctx, snapshot, 'passed', exactP95 + 0.46, 'passed');

    expect(await service().recompute(ctx.runId)).toBe('recomputed');

    expect((await runRow(ctx.runId)).verdict).toBe('passed');
    expect(await new RecomputeRepository(pool).verdictChanges(ctx.runId)).toEqual([]);
    // The VALUE is still rewritten to the exact one, even with no change to record.
    const { rows } = await pool.query(`SELECT actual_value FROM run_assertion WHERE run_id = $1`, [ctx.runId]);
    expect(rows).toEqual([{ actual_value: exactP95 }]);
  });

  it('marks a run with no stored log raw_log_missing, leaves it estimated, and never selects it again', async () => {
    const { runId, bundleKey } = await legacyRun();
    const rowsBefore = await counts(runId);
    await blobs.delete(bundleKey);

    expect(await service().recompute(runId)).toBe('raw_log_missing');

    const run = await runRow(runId);
    expect(run.stats_method).toBe('estimated');
    expect(run.recompute_error).toBe('raw_log_missing');
    expect(run.recomputed_at).toBeNull();
    expect((await runStatRow(runId, 'run', '')).sketch).not.toBeNull();
    expect(await counts(runId)).toEqual(rowsBefore);
    expect(await new RecomputeRepository(pool).candidates({ runId }, 1)).toEqual([]);
  });

  it('marks a live run that stored no log (sha empty) raw_log_missing', async () => {
    const { runId } = await seedLiveRun(log);
    await pipeline().process(runId, { queueWillRetry: false });
    await makeLegacy(runId);
    await pool.query(`UPDATE run SET bundle_sha256 = '' WHERE id = $1`, [runId]);

    expect(await service().recompute(runId)).toBe('raw_log_missing');
    const run = await runRow(runId);
    expect(run.recompute_error).toBe('raw_log_missing');
    expect(run.stats_method).toBe('estimated');
  });

  it('marks a run whose stored bytes no longer match their checksum checksum_mismatch', async () => {
    const { runId } = await legacyRun();
    await pool.query(`UPDATE run SET bundle_sha256 = $2 WHERE id = $1`, [runId, '0'.repeat(64)]);

    expect(await service().recompute(runId)).toBe('checksum_mismatch');
    const run = await runRow(runId);
    expect(run.recompute_error).toBe('checksum_mismatch');
    expect(run.stats_method).toBe('estimated');
  });

  it('marks a run whose stored log cannot be parsed parse_failed', async () => {
    const { runId, bundleKey } = await seedLiveRun(log);
    await pipeline().process(runId, { queueWillRetry: false });
    await makeLegacy(runId);
    // Bytes that ARE there and DO match their checksum, and are not a Gatling log.
    const garbage = Buffer.from('this is not a simulation.log\n'.repeat(64));
    await blobs.putStream(bundleKey, Readable.from([garbage]), 100_000_000);
    await pool.query(`UPDATE run SET bundle_sha256 = $2 WHERE id = $1`, [
      runId, createHash('sha256').update(garbage).digest('hex'),
    ]);

    expect(await service().recompute(runId)).toBe('parse_failed');
    const run = await runRow(runId);
    expect(run.recompute_error).toBe('parse_failed');
    expect(run.stats_method).toBe('estimated');
  });

  /**
   * ═══ A LIMIT LOWERED SINCE INGEST IS NOT A FACT ABOUT THE LOG ═══
   *
   * `maxDecompressedBundleBytes` is a project setting a person can lower after
   * the run was ingested under the old one. Opening with the project's value
   * alone would refuse an archive that parsed perfectly, and retire the run as
   * parse_failed for good. The recompute opens with whichever is larger, the
   * project's setting or the worker's own.
   */
  it('recomputes an archive a project limit lowered after ingest would now refuse', async () => {
    const { runId, projectId } = await legacyRun();
    await prisma.project.update({ where: { id: projectId }, data: { settings: { maxDecompressedBundleBytes: 10 } } });

    expect(await service().recompute(runId)).toBe('recomputed');
    expect((await runRow(runId)).recompute_error).toBeNull();
  });

  it('rethrows a size refusal instead of recording it, so the run stays selectable', async () => {
    const { runId } = await legacyRun();
    const tight = new RecomputeService({ ...config, maxDecompressedBundleBytes: 10 }, prisma, pool, blobs);

    await expect(tight.recompute(runId)).rejects.toMatchObject({ name: 'IngestError', code: 'BUNDLE_TOO_LARGE' });

    const run = await runRow(runId);
    expect(run.recompute_error).toBeNull();
    expect(run.stats_method).toBe('estimated');
    expect(await new RecomputeRepository(pool).candidates({ runId }, 1)).toEqual([runId]);
  });

  it('rethrows an object-store failure instead of recording it, so the run stays selectable', async () => {
    const { runId } = await legacyRun();
    // The shape the AWS SDK's node http handler gives a socket timeout: a
    // name and no code, which isTransient does not recognise. Reading the
    // object failing is still not a fact about the log.
    const timeout = Object.assign(new Error('socket timed out'), { name: 'TimeoutError' });
    vi.spyOn(BlobStore.prototype, 'get').mockRejectedValueOnce(timeout);

    await expect(service().recompute(runId)).rejects.toBe(timeout);

    const run = await runRow(runId);
    expect(run.recompute_error).toBeNull();
    expect(run.stats_method).toBe('estimated');
    expect(await new RecomputeRepository(pool).candidates({ runId }, 1)).toEqual([runId]);
  });

  it('reports locked while another session holds the run lock, and changes nothing', async () => {
    const { runId } = await legacyRun();
    const rowsBefore = await counts(runId);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
      expect(await service().recompute(runId)).toBe('locked');
      expect((await runRow(runId)).stats_method).toBe('estimated');
      expect((await runStatRow(runId, 'run', '')).sketch).not.toBeNull();
      expect(await counts(runId)).toEqual(rowsBefore);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
      holder.release();
    }
    // And the lock it would have taken is free again once the holder lets go.
    expect(await service().recompute(runId)).toBe('recomputed');
  });

  it('leaves the legacy rows intact when the transaction fails after the deletes', async () => {
    const { runId } = await legacyRun();
    const rowsBefore = await counts(runId);
    vi.spyOn(MetricWriter.prototype, 'persist').mockRejectedValueOnce(new Error('boom'));

    await expect(service().recompute(runId)).rejects.toThrow('boom');

    expect((await runStatRow(runId, 'run', '')).sketch).not.toBeNull();
    const run = await runRow(runId);
    expect(run.stats_method).toBe('estimated');
    expect(run.recompute_error).toBeNull();
    expect(await counts(runId)).toEqual(rowsBefore);
    // The lock was released on the way out: the next attempt goes through.
    expect(await service().recompute(runId)).toBe('recomputed');
  });

  it('recomputes a live run whose log is a raw simulation.log', async () => {
    const { runId } = await seedLiveRun(log);
    await pipeline().process(runId, { queueWillRetry: false });
    await makeLegacy(runId);

    expect(await service().recompute(runId)).toBe('recomputed');

    const row = await runStatRow(runId, 'run', '');
    expect(row.sketch).toBeNull();
    expect(row.percentiles.p95).toBe(exactPercentile(allDurations(log), 95));
    expect((await runRow(runId)).stats_method).toBe('exact-v1');
  });

  it('returns not_eligible for a run that has not finished', async () => {
    const { runId } = await legacyRun();
    await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [runId]);
    expect(await service().recompute(runId)).toBe('not_eligible');
    expect((await runRow(runId)).stats_method).toBe('estimated');
  });

  /**
   * ═══ THE PARTITION DAY IS THE RUN'S UTC DATE, WHATEVER ZONE THE WORKER RUNS IN ═══
   *
   * `run_started_on` is the run's UTC calendar date (Prisma writes
   * `started_on` that way). node-postgres renders a JS Date parameter in the
   * PROCESS's zone, so a worker west of UTC bound 2026-08-07T00:00Z as
   * 2026-08-06: the recompute's DELETE missed the legacy buckets on the 7th and
   * its INSERT wrote new ones on the 6th — two engines' rows for one run, and
   * the run labelled exact. The legacy rows are written here in this
   * process's own zone first, and the recompute runs in New York.
   */
  it('keeps every bucket row on the run\'s UTC date when the worker runs west of UTC', async () => {
    const { runId, orgId, projectId } = await legacyRun();
    const bucketDays = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of ['run_series_bucket', 'run_user_bucket', 'run_error_bucket']) {
        const { rows } = await pool.query<{ day: string; n: string }>(
          `SELECT run_started_on::text AS day, count(*) AS n FROM "${t}" WHERE run_id = $1 GROUP BY 1`,
          [runId],
        );
        for (const r of rows) out[`${t} ${r.day}`] = Number(r.n);
      }
      return out;
    };
    const before = await bucketDays();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(Object.keys(before).every((k) => k.endsWith(' 2026-08-07'))).toBe(true);

    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // The flip has to have taken, or this case passes on any host.
      expect(new Date('2026-08-07T00:00:00Z').getHours()).not.toBe(0);

      expect(await service().recompute(runId)).toBe('recomputed');

      // Same row counts, every one on the 7th, none on the 6th.
      expect(await bucketDays()).toEqual(before);

      // And a reader in the same zone finds them, through the same binding.
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      const series = await new MetricReader(pool).series({ orgId, projectId }, runId, run.startedOn, {
        scope: 'run', name: '', family: 'response_time',
      });
      expect(series.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('returns gone for a run that no longer exists', async () => {
    expect(await service().recompute(randomUUID())).toBe('gone');
  });
});
