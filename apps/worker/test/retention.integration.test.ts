import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma, VerificationRepository } from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { VERIFIER_VERSION } from '@perfportal/verify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig, type WorkerConfig } from '../src/config.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import { RETENTION_LIMITS, Sweeper, type RetentionLimits } from '../src/sweeper.js';
import { VerifyService } from '../src/verify/verify.service.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);
const verifications = new VerificationRepository(pool);
const redis = new Redis(config.redisUrl);

let bundle: Buffer;

const TABLES = [
  'run_verification', 'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket',
  'run_series_bucket', 'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token',
  'project', 'org', 'org_member', 'session', 'account', 'verification', 'user',
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  scope = null;
  // A sweeper carries its retention cursor from one sweep to the next, so one
  // kept across cases would start a case's walk after a run of the case
  // before. Each case gets its own; the old ones are closed in afterAll.
  for (const s of sweepers.values()) retired.push(s);
  sweepers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const s of [...retired, ...sweepers.values()]) await s.close();
  redis.disconnect();
  await pool.end();
  await prisma.$disconnect();
});

interface Seeded {
  id: string;
  bundleKey: string;
}

let scope: { orgId: string; projectId: string } | null = null;

/** The one org and project every run in a case belongs to. */
async function project(): Promise<{ orgId: string; projectId: string }> {
  if (scope !== null) return scope;
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const p = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  scope = { orgId: org.id, projectId: p.id };
  return scope;
}

/** Finished runs ingested by the real pipeline, each `ageDays` old by its ingested_at. */
async function seedRuns(...ageDays: number[]): Promise<Seeded[]> {
  const { orgId, projectId } = await project();
  const pipeline = new PipelineService(config, prisma, pool, blobs);
  const out: Seeded[] = [];
  for (const age of ageDays) {
    const key = `runs/test/${randomUUID()}.tgz`;
    await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
    const run = await prisma.run.create({
      data: {
        orgId, projectId, status: 'pending', tool: 'gatling',
        bundleKey: key, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: BigInt(bundle.length),
        startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    await pipeline.process(run.id, { queueWillRetry: false });
    await pool.query(`UPDATE run SET ingested_at = now() - make_interval(days => $2::int) WHERE id = $1`, [run.id, age]);
    out.push({ id: run.id, bundleKey: key });
  }
  return out;
}

/**
 * What the verifier leaves on a run it checked against its log, at the
 * current version: nothing but the clock then keeps the log.
 */
async function verified(...runs: Seeded[]): Promise<void> {
  for (const run of runs) {
    await verifications.record(run.id, {
      status: 'verified',
      verifierVersion: VERIFIER_VERSION,
      figuresChecked: 1,
      mismatches: [],
      rawLogRetainedUntil: null,
    });
  }
}

/** A run that failed to ingest: no statistics, so no verification row, ever. */
async function seedFailed(ageDays: number): Promise<Seeded> {
  const { orgId, projectId } = await project();
  const key = `runs/test/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'failed', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {}, ingestedAt: new Date(Date.now() - ageDays * 86_400_000),
    },
  });
  return { id: run.id, bundleKey: key };
}

/**
 * `n` exact, verified runs past retention, written straight to the tables:
 * a stat row in the exact engine's format and a verified row each. No object
 * is stored — a missing one counts as deleted — so a hundred of these cost a
 * few statements rather than a hundred pipeline runs.
 */
async function seedVerifiedDirect(n: number, ageDays: number): Promise<Seeded[]> {
  const { orgId, projectId } = await project();
  const out: Seeded[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = `runs/test/${randomUUID()}.tgz`;
    const run = await prisma.run.create({
      data: {
        orgId, projectId, status: 'complete', tool: 'gatling',
        bundleKey: key, bundleSha256: 'a'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {}, ingestedAt: new Date(Date.now() - ageDays * 86_400_000 - i * 1000),
      },
    });
    await pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count, error_rate,
          min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles, histogram_kind)
       VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time', 1, 1, 0, 0,
               10, 10, 10, 0, 1, '{}'::jsonb, 'sparse-ms-v2')`,
      [run.id, orgId, projectId],
    );
    out.push({ id: run.id, bundleKey: key });
  }
  await verified(...out);
  return out;
}

/**
 * ONE sweeper per retention setting, for the whole file, closed in afterAll.
 * A Sweeper opens a BullMQ queue in its constructor, and one closed while its
 * connection is still being made leaves an unhandled "Connection is closed"
 * behind it — on a loaded machine, a dozen short-lived sweepers here did.
 */
const sweepers = new Map<number, Sweeper>();
const retired: Sweeper[] = [];
function sweeper(days: number): Sweeper {
  let s = sweepers.get(days);
  if (s === undefined) {
    const c: WorkerConfig = { ...config, rawLogRetentionDays: days };
    s = new Sweeper(c, pool, chunks, blobs, redis);
    sweepers.set(days, s);
  }
  return s;
}

/** A sweeper with its own retention limits, closed in afterAll like the rest. */
function limitedSweeper(days: number, limits: RetentionLimits, overrides: Partial<WorkerConfig> = {}): Sweeper {
  const s = new Sweeper({ ...config, ...overrides, rawLogRetentionDays: days }, pool, chunks, blobs, redis, limits);
  retired.push(s);
  return s;
}

async function deletedAt(runId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ raw_log_deleted_at: Date | null }>(
    'SELECT raw_log_deleted_at FROM run WHERE id = $1',
    [runId],
  );
  return rows[0]!.raw_log_deleted_at;
}

describe('raw-log retention in the sweeper', () => {
  it('deletes the raw log of a verified run past retention, and not of one inside it', async () => {
    const [old, young] = await seedRuns(31, 29);
    await verified(old!, young!);
    await sweeper(30).sweep();

    expect(await blobs.exists(old!.bundleKey)).toBe(false);
    expect(await deletedAt(old!.id)).not.toBeNull();
    expect(await blobs.exists(young!.bundleKey)).toBe(true);
    expect(await deletedAt(young!.id)).toBeNull();
  });

  it('keeps every raw log for ever at 0 days', async () => {
    const [old] = await seedRuns(4_000);
    await verified(old!);
    await sweeper(0).sweep();

    expect(await blobs.exists(old!.bundleKey)).toBe(true);
    expect(await deletedAt(old!.id)).toBeNull();
  });

  it('skips a run whose lock is held (a verify or recompute is working on it), and takes it next time', async () => {
    const [old] = await seedRuns(31);
    await verified(old!);
    const holder = await pool.connect();
    const s = sweeper(30);
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, old!.id]);
      await s.sweep();
      expect(await blobs.exists(old!.bundleKey)).toBe(true);
      expect(await deletedAt(old!.id)).toBeNull();
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, old!.id]);

      await s.sweep();
      expect(await blobs.exists(old!.bundleKey)).toBe(false);
      expect(await deletedAt(old!.id)).not.toBeNull();
    } finally {
      holder.release();
    }
  });

  it('counts an object already missing as deleted', async () => {
    const [old] = await seedRuns(31);
    await verified(old!);
    await blobs.delete(old!.bundleKey);
    await sweeper(30).sweep();
    expect(await deletedAt(old!.id)).not.toBeNull();
  });

  /**
   * The inverse of what retention used to do: a run the verifier has yet to
   * check against its log keeps that log, past retention, until it has been
   * checked. The verified one goes, and keeps its answer.
   */
  it('keeps a run waiting for verification, and deletes a verified one, which stays verified', async () => {
    const [never, checked] = await seedRuns(31, 31);
    await verifications.markPending(never!.id);
    expect(await new VerifyService(config, prisma, pool, blobs).verify(checked!.id)).toBe('verified');
    await sweepAt(30);

    expect((await verifications.find(never!.id))!.status).toBe('pending');
    expect(await blobs.exists(never!.bundleKey)).toBe(true);
    expect(await deletedAt(never!.id)).toBeNull();
    expect((await verifications.find(checked!.id))!.status).toBe('verified');
    expect(await deletedAt(checked!.id)).not.toBeNull();
    // The kept one is still what the scan reads; the deleted one is never selected again.
    expect((await verifications.candidatePage(VERIFIER_VERSION, null, 10)).ids).toEqual([never!.id]);
  });
});

/**
 * ═══ RETENTION DELETES ONLY A LOG NOTHING STILL NEEDS ═══
 *
 * One case per reason a log is kept, and per run that must still go. Every
 * seeded run here is past a 30-day retention.
 */
describe('raw-log retention keeps a log something still needs', () => {
  it('(a) keeps a verifiable run with no verification row yet', async () => {
    const [run] = await seedRuns(31);
    await sweepAt(30);
    expect(await deletedAt(run!.id)).toBeNull();
    expect(await blobs.exists(run!.bundleKey)).toBe(true);
  });

  it('(b) keeps a run whose verification is pending', async () => {
    const [run] = await seedRuns(31);
    await verifications.markPending(run!.id);
    await sweepAt(30);
    expect(await deletedAt(run!.id)).toBeNull();
  });

  /** The log of an estimated run is what its exact statistics will be computed
   *  from; one the recompute has retired is no candidate, and its log goes. */
  it('(c) keeps an estimated run the recompute has yet to make exact, and deletes one it retired', async () => {
    const [waiting, retired] = await seedRuns(31, 31);
    for (const run of [waiting!, retired!]) {
      await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [run.id]);
      await verifications.markUnverifiable(run.id, 'not_exact', VERIFIER_VERSION);
    }
    await pool.query(`UPDATE run SET recompute_error = 'parse_failed' WHERE id = $1`, [retired!.id]);
    await sweepAt(30);
    expect(await deletedAt(waiting!.id)).toBeNull();
    expect(await blobs.exists(waiting!.bundleKey)).toBe(true);
    expect(await deletedAt(retired!.id)).not.toBeNull();
    expect(await blobs.exists(retired!.bundleKey)).toBe(false);
  });

  /** No statistics, so no verification row ever: it must not look like a run waiting for one. */
  it('(d) deletes the log of a failed run, which never gets a verification row', async () => {
    const failed = await seedFailed(31);
    await sweepAt(30);
    expect(await deletedAt(failed.id)).not.toBeNull();
    expect(await blobs.exists(failed.bundleKey)).toBe(false);
    expect(await verifications.find(failed.id)).toBeNull();
  });

  /** The log is the evidence for the defect; a fixed verifier or a recompute needs it. */
  it('(e) keeps a run whose verification found a mismatch', async () => {
    const [run] = await seedRuns(31);
    await verifications.record(run!.id, {
      status: 'mismatch',
      verifierVersion: VERIFIER_VERSION,
      figuresChecked: 9,
      mismatches: [],
      rawLogRetainedUntil: null,
    });
    await sweepAt(30);
    expect(await deletedAt(run!.id)).toBeNull();
  });

  /** A run a recompute made exact after the verifier refused it: the scan takes it back. */
  it('(f) keeps an exact run still carrying a stale not_exact row', async () => {
    const [run] = await seedRuns(31);
    await verifications.markUnverifiable(run!.id, 'not_exact', VERIFIER_VERSION);
    await sweepAt(30);
    expect(await deletedAt(run!.id)).toBeNull();
  });

  /**
   * A page is read before the lock is taken; a run marked pending in between
   * must not be deleted. The page is stubbed to answer the pending run, the
   * state the race leaves, so only the re-check under the lock can keep it.
   */
  it('(g) re-checks a run under its lock, and leaves one no longer due', async () => {
    const [run] = await seedRuns(31);
    await verifications.markPending(run!.id);
    vi.spyOn(VerificationRepository.prototype, 'retentionDue').mockResolvedValueOnce({
      runs: [{ id: run!.id, bundleKey: run!.bundleKey }],
      next: null,
    });
    await sweepAt(30);
    expect(await deletedAt(run!.id)).toBeNull();
    expect(await blobs.exists(run!.bundleKey)).toBe(true);
    expect((await verifications.find(run!.id))!.status).toBe('pending');
  });

  /**
   * A hundred runs whose deletes keep failing fill the first page; the sweep
   * walks on to the next one in the same pass, so they cannot hold back the
   * run behind them. Two pages, at the production limits: inside one sweep's
   * cap, which the first assertion pins so the case cannot pass by the cap
   * having shrunk under it.
   */
  it('(h) walks on past a page of runs whose deletes fail, in the same sweep', async () => {
    expect(RETENTION_LIMITS.pageSize).toBe(100);
    expect(RETENTION_LIMITS.pagesPerSweep).toBeGreaterThanOrEqual(2);
    const runs = await seedVerifiedDirect(101, 31);
    let calls = 0;
    const real = blobs.delete.bind(blobs);
    vi.spyOn(blobs, 'delete').mockImplementation(async (key: string) => {
      calls += 1;
      if (calls <= 100) throw new Error('bucket refused');
      await real(key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await sweepAt(30);
    expect(calls).toBe(101);
    // The newest — ingested last — is the 101st, on the second page.
    const newest = runs[0]!;
    expect(await deletedAt(newest.id)).not.toBeNull();
    for (const run of runs.slice(1)) expect(await deletedAt(run.id)).toBeNull();
  });

  it('does not run two sweeps at once: a firing that finds one running does nothing', async () => {
    const due = vi.spyOn(VerificationRepository.prototype, 'retentionDue');
    const s = sweeper(30);
    await Promise.all([s.sweep(), s.sweep()]);
    expect(due).toHaveBeenCalledTimes(1);
  });
});

/**
 * ═══ A FEW PAGES A SWEEP, RESUMED FROM A CURSOR ═══
 *
 * Two runs a page and two pages a sweep, so six runs are more than one
 * sweep's worth without seeding five hundred. The two OLDEST runs' deletes
 * always fail: they stay due, so a sweep that started from the beginning again
 * would try them again, and that is what tells a resumed walk from a restarted
 * one (a deleted run is no longer due, and would vanish from either walk).
 */
describe('raw-log retention spreads a backlog across sweeps', () => {
  const LIMITS: RetentionLimits = { pageSize: 2, pagesPerSweep: 2 };

  /** Six due runs, oldest first, and a delete that fails for the two oldest. */
  async function backlog(): Promise<{ runs: Seeded[]; attempts: string[][] }> {
    // seedVerifiedDirect ages run i by i seconds more, so reversed is oldest first.
    const runs = (await seedVerifiedDirect(6, 31)).reverse();
    const failing = new Set([runs[0]!.bundleKey, runs[1]!.bundleKey]);
    const attempts: string[][] = [];
    const real = blobs.delete.bind(blobs);
    vi.spyOn(blobs, 'delete').mockImplementation(async (key: string) => {
      attempts[attempts.length - 1]!.push(key);
      if (failing.has(key)) throw new Error('bucket refused');
      await real(key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return { runs, attempts };
  }

  async function sweepRecording(s: Sweeper, attempts: string[][]): Promise<string[]> {
    attempts.push([]);
    await s.sweep();
    return attempts[attempts.length - 1]!;
  }

  it('stops one sweep at its page cap, and leaves the rest due', async () => {
    const { runs, attempts } = await backlog();
    const due = vi.spyOn(VerificationRepository.prototype, 'retentionDue');
    const tried = await sweepRecording(limitedSweeper(30, LIMITS), attempts);

    expect(due).toHaveBeenCalledTimes(2);
    expect(tried).toEqual(runs.slice(0, 4).map((r) => r.bundleKey));
    expect(await deletedAt(runs[2]!.id)).not.toBeNull();
    expect(await deletedAt(runs[3]!.id)).not.toBeNull();
    for (const run of runs.slice(4)) expect(await deletedAt(run.id)).toBeNull();
  });

  it('resumes the next sweep from where the last one stopped, not from the oldest run', async () => {
    const { runs, attempts } = await backlog();
    const s = limitedSweeper(30, LIMITS);
    await sweepRecording(s, attempts);
    const due = vi.spyOn(VerificationRepository.prototype, 'retentionDue');
    const tried = await sweepRecording(s, attempts);

    // The first page asked for starts after the fourth run, where the cap stopped.
    expect(due.mock.calls[0]![2]).toEqual({ ingestedAt: expect.any(Date), id: runs[3]!.id });
    expect(tried).toEqual([runs[4]!.bundleKey, runs[5]!.bundleKey]);
    for (const run of runs.slice(2)) expect(await deletedAt(run.id)).not.toBeNull();
    for (const run of runs.slice(0, 2)) expect(await deletedAt(run.id)).toBeNull();
  });

  it('starts from the beginning again after a short page, where the failed runs are tried again', async () => {
    const { runs, attempts } = await backlog();
    const s = limitedSweeper(30, LIMITS);
    await sweepRecording(s, attempts);
    // Two full pages; the third comes back empty, so this walk reached the end.
    await sweepRecording(s, attempts);
    const due = vi.spyOn(VerificationRepository.prototype, 'retentionDue');
    const tried = await sweepRecording(s, attempts);

    expect(due.mock.calls[0]![2]).toBeNull();
    expect(tried).toEqual([runs[0]!.bundleKey, runs[1]!.bundleKey]);
  });

  /**
   * The reason for the cap. A run abandoned at running is finalized by the
   * sweep that finds it, while the retention backlog is still there for the
   * sweeps after it.
   */
  it('recovers a stale run on every sweep while a retention backlog remains', async () => {
    const runs = (await seedVerifiedDirect(10, 31)).reverse();
    const s = limitedSweeper(30, LIMITS);

    const first = await seedAbandoned();
    await s.sweep();
    expect(await statusOf(first)).toBe('incomplete');

    const second = await seedAbandoned();
    await s.sweep();
    expect(await statusOf(second)).toBe('incomplete');

    // Eight of the ten are gone after two sweeps; the backlog is still there.
    for (const run of runs.slice(0, 8)) expect(await deletedAt(run.id)).not.toBeNull();
    for (const run of runs.slice(8)) expect(await deletedAt(run.id)).toBeNull();
  });

  /** Recovery runs first, so a retention pass that throws cannot keep it from a run. */
  it('recovers a stale run even when the retention pass fails', async () => {
    await seedVerifiedDirect(1, 31);
    const stale = await seedAbandoned();
    vi.spyOn(VerificationRepository.prototype, 'retentionDue').mockRejectedValueOnce(new Error('database refused'));

    await expect(limitedSweeper(30, LIMITS).sweep()).rejects.toThrow('database refused');
    expect(await statusOf(stale)).toBe('incomplete');
  });
});

/**
 * A live run whose producer stopped an hour ago before sending a byte: past
 * `runningStaleAfterMs`, so the sweep finalizes it `incomplete` in place.
 */
async function seedAbandoned(): Promise<string> {
  const { orgId, projectId } = await project();
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: `live/${randomUUID()}/simulation.log`, bundleSha256: '', bundleBytes: BigInt(0),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  await pool.query(
    `UPDATE run SET created_at = now() - interval '1 hour', stream_updated_at = now() - interval '1 hour' WHERE id = $1`,
    [run.id],
  );
  return run.id;
}

async function statusOf(runId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [runId]);
  return rows[0]!.status;
}

async function sweepAt(days: number): Promise<void> {
  await sweeper(days).sweep();
}
