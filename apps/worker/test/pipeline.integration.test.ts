import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma, MetricReader } from '@perfportal/persistence';
import { Redis } from 'ioredis';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import { isTransient } from '../src/pipeline/retry.js';
import { loadWorkerConfig } from '../src/config.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

// Closing a BullMQ Worker's blocking Redis connection can leave one
// in-flight ioredis command rejecting asynchronously with "Connection is
// closed." after close() has already resolved — a benign teardown artifact
// of the library pairing, not a bug in application code (there is nothing
// in this file that leaves that rejection unawaited on purpose). Only that
// exact, known-benign rejection is swallowed; anything else still surfaces.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message === 'Connection is closed.') return;
  throw reason;
});

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
// The sweeper keeps an abandoned run's data now, so it holds the same two
// stores the close path does.
const chunks = new LiveChunkStore(blobs);
// The sweeper publishes `live:closed` at its claim so the fold owner drops
// the advisory lock before the pipeline needs it.
const redisPub = new Redis(config.redisUrl);

let bundle: Buffer;
/** The RAW log, not the tarball. A live run streams simulation.log bytes
 *  directly — `LiveChunkStore` never sees an archive — so a test that seeds
 *  chunks has to seed what a producer actually sends. */
let log: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  log = readFileSync(FIXTURE_LOG);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

async function seedRun(
  bundleBody: Buffer,
  engineOptions: Record<string, unknown> = {},
  bundleSha256: string = createHash('sha256').update(bundleBody).digest('hex'),
) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${Date.now()}.tgz`;
  await blobs.putStream(key, Readable.from([bundleBody]), 100_000_000);
  const startedAt = new Date('2026-08-07T10:00:00Z');
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256, bundleBytes: BigInt(bundleBody.length),
      startedAt, startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: engineOptions as object,
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id, startedOn: new Date('2026-08-07T00:00:00Z') };
}

function pipeline(): PipelineService {
  return new PipelineService(config, prisma, pool, blobs);
}

/**
 * Mirrors seedRun, but shaped like Task 9's live path rather than an
 * upload: `bundleKey` ends in `/simulation.log` (never `.tgz`) and holds the
 * RAW log bytes directly — no tar, no gzip — exactly what
 * `LiveChunkStore.finalize` writes for a real streamed run. `status:
 * 'running'` and a non-zero `streamOffset` match what `close()` would see
 * for a run that actually received bytes, though `process()` itself never
 * reads either column.
 */
async function seedLiveRun(rawLog: Buffer) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${Date.now()}/simulation.log`;
  await blobs.putStream(key, Readable.from([rawLog]), 100_000_000);
  const startedAt = new Date('2026-08-07T10:00:00Z');
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'running', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(rawLog).digest('hex'),
      bundleBytes: BigInt(rawLog.length), streamOffset: BigInt(rawLog.length),
      startedAt, startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

describe('PipelineService', () => {
  // Task 9 (apps/api/src/ingest/live.service.ts): a live run's finalized
  // bundleKey holds simulation.log's raw bytes, never a tar.gz — before
  // pipeline.service.ts's rawLogBundleSource branch existed, this fell
  // straight into openTarGzBundle, which gunzips unconditionally and threw
  // BUNDLE_NOT_ARCHIVE on every single streamed run. This is the regression
  // guard for that branch, independent of the fuller apps/api
  // live.integration.test.ts end-to-end case, which exercises the same code
  // path through the real open/stream/close endpoints.
  it('processes a live run\'s raw simulation.log directly, with no tar.gz wrapper', async () => {
    const rawLog = readFileSync(FIXTURE_LOG);
    const ctx = await seedLiveRun(rawLog);
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');

    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    const runStat = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    expect(runStat?.count).toBeGreaterThan(0);
    expect((runStat?.okCount ?? 0) + (runStat?.koCount ?? 0)).toBe(runStat?.count);
  });

  it('reproduces the fixture statistics end to end', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.toolVersion).toBe('3.15.1');

    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    const runStat = stats.find((s) => s.scope === 'run' && s.family === 'response_time');

    expect(runStat?.count).toBe(895);
    expect(runStat?.okCount).toBe(871);
    expect(runStat?.koCount).toBe(24);
    expect(Math.round(runStat!.maxMs)).toBe(2503);
    expect(Math.round(runStat!.meanMs)).toBe(228);
    expect(Math.round(runStat!.stddevMs)).toBe(370);
  });

  it('sets tool_started_at from the bundle\'s own run header, distinct from ingest time', async () => {
    // seedRun fixes startedAt (ingest/upload time) to a constant unrelated to
    // when the fixture log itself claims the load test started. The two
    // genuinely differ in the fixture, so this proves the worker reads the
    // parsed value rather than copying startedAt or leaving the column null.
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.toolStartedAt).not.toBeNull();
    expect(run!.toolStartedAt!.getTime()).not.toBe(run!.startedAt.getTime());

    // Plausible, not hardcoded: a real epoch millisecond timestamp somewhere
    // in the recent past, and — per this fixture, captured when the tool
    // itself ran — earlier than the fixed upload time seedRun records.
    expect(run!.toolStartedAt!.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
    expect(run!.toolStartedAt!.getTime()).toBeLessThan(run!.startedAt.getTime());
  });

  it('persists the error table with the fixture counts', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const errors = await new MetricReader(pool).errors(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    expect(errors.reduce((a, e) => a + e.count, 0)).toBe(24);
    expect(errors.map((e) => e.count).sort((a, b) => b - a)).toEqual([15, 9]);
  });

  it('persists series buckets readable through the partition key', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const buckets = await new MetricReader(pool).series(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
      ctx.startedOn,
      { scope: 'run', name: '', family: 'response_time' },
    );
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.reduce((a, b) => a + b.startedCount, 0)).toBe(895);
  });

  it('evaluates SLA rules and records the verdict', async () => {
    const ctx = await seedRun(bundle);
    await prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('failed');

    const assertions = await prisma.runAssertion.findMany({ where: { runId: ctx.runId } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.outcome).toBe('failed');
    expect(assertions[0]?.ruleSnapshot).toMatchObject({ threshold: 1, metric: 'p95' });
  });

  it('reports not_evaluated when a project has no rules', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);
    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('not_evaluated');
  });

  it('records a structured failure with remediation for a corrupt bundle', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    // process() rethrows a deterministic failure after recording it, so the
    // consumer can classify it with isTransient — expected here, not a bug.
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('fails with a storage-integrity error, not a bundle error, when the fetched bytes do not match the recorded checksum', async () => {
    // The stored bundleSha256 is wrong relative to the object actually in the
    // blob store — simulating corruption that happened after upload, on the
    // storage side, not a bad upload from the caller (spec §6.2 step 2).
    const ctx = await seedRun(bundle, {}, 'f'.repeat(64));
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatchObject({
      code: 'BUNDLE_CHECKSUM_MISMATCH',
      remediation: expect.stringMatching(/.+/),
    });
    // Not blamed on the caller: the remediation must not read like a
    // malformed-upload message.
    expect((run?.error as { remediation: string }).remediation).toMatch(/storage/i);
  });

  it('writes nothing at all when the run fails — no half-persisted statistics', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  it('records the tool run header alongside the statistics', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const { rows } = await pool.query(
      `SELECT simulation, description, duration_ms FROM run WHERE id = $1`,
      [ctx.runId],
    );
    // The fixture's run header names the fully package-qualified simulation
    // class (see packages/plugin-gatling/test/records.test.ts), so the
    // stored value carries the "example." prefix rather than a bare class name.
    expect(rows[0]?.simulation).toBe('example.ParitySimulation');
    expect(rows[0]?.duration_ms).toBeGreaterThan(60_000);
    expect(rows[0]?.duration_ms).toBeLessThan(64_000);
  });

  it('does not let a losing concurrent worker clobber the winner\'s committed result', async () => {
    // Two jobs for the same run racing (BullMQ default concurrency, or a
    // stalled-job redelivery) both pass the pending guard before either
    // commits. The loser's run_stat insert then hits the unique constraint,
    // rolls back, and — if RunRepository.fail writes unconditionally —
    // overwrites the winner's already-committed complete/verdict with
    // failed/null, leaving orphaned run_stat rows behind: statistics with no
    // verdict, which this task's design forbids.
    const ctx = await seedRun(bundle);

    const results = await Promise.allSettled([
      pipeline().process(ctx.runId),
      pipeline().process(ctx.runId),
    ]);
    // At least one side may legitimately throw (unique-constraint rollback);
    // what matters is that the winner's row survives untouched.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.verdict).not.toBeNull();

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1',
      [ctx.runId],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  /**
   * Fix round 1, Important 5. `LiveService.close()` moves a run to
   * `'parsing'` and enqueues this job BEFORE the fold owner's next tick
   * releases the shared advisory lock (design part-2a §1.1). Before this
   * fix, losing the lock always returned silently — correct for two
   * `process()` calls racing each other, wrong here: the job would report
   * success while nothing had actually parsed the run, and it would sit at
   * `'parsing'` until the Sweeper's 15-minute staleness re-enqueue noticed.
   *
   * Simulated deterministically rather than via a real race: a second
   * client takes the SAME advisory lock `process()` would (the one
   * `#handleLockLost` is designed to recognise it lost to), the run is
   * moved to `'parsing'` the way `claimForClose` leaves it, and only then
   * is `process()` called.
   */
  it('retries rather than silently giving up when the live fold owner still holds the lock', async () => {
    const ctx = await seedLiveRun(readFileSync(FIXTURE_LOG));
    await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [ctx.runId]);

    const owner = await pool.connect();
    try {
      const { rows: lockRows } = await owner.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS got',
        [RUN_INGEST_LOCK_NAMESPACE, ctx.runId],
      );
      expect(lockRows[0]?.got).toBe(true);

      const rejection = await pipeline()
        .process(ctx.runId)
        .then(() => null, (err: unknown) => err);
      expect(rejection).not.toBeNull();
      expect((rejection as { code?: unknown }).code).toBe('RUN_LOCKED');
      expect(isTransient(rejection)).toBe(true);

      // Untouched: process() never reached #processHoldingLock at all.
      const stillParsing = await prisma.run.findUnique({ where: { id: ctx.runId } });
      expect(stillParsing?.status).toBe('parsing');
    } finally {
      await owner.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        RUN_INGEST_LOCK_NAMESPACE,
        ctx.runId,
      ]);
      owner.release();
    }

    // The lock is genuinely free now (mirrors what the owner's own next
    // tick would do) -- BullMQ's retry lands here, and it must succeed.
    await pipeline().process(ctx.runId);
    const finished = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(finished?.status).toBe('complete');
  });

  /**
   * The case Important 5's fix must NOT change: two `process()` calls
   * racing over the same UPLOADED run (never seen by the fold owner, which
   * only ever claims runs at `status = 'running'`). `#handleLockLost` tells
   * this apart from the live case by `bundleKey` alone -- `seedRun`'s key
   * always ends in `.tgz` -- so it must return silently here regardless of
   * the run's status at the moment of the check.
   */
  it('still gives up silently when another process() call owns an uploaded run\'s lock', async () => {
    const ctx = await seedRun(bundle);

    const other = await pool.connect();
    try {
      const { rows: lockRows } = await other.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS got',
        [RUN_INGEST_LOCK_NAMESPACE, ctx.runId],
      );
      expect(lockRows[0]?.got).toBe(true);

      await expect(pipeline().process(ctx.runId)).resolves.toBeUndefined();

      // Nothing changed -- the loser did nothing at all.
      const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
      expect(run?.status).toBe('pending');
    } finally {
      await other.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        RUN_INGEST_LOCK_NAMESPACE,
        ctx.runId,
      ]);
      other.release();
    }
  });
});

describe('Sweeper', () => {
  it('re-enqueues a run whose job never landed, and leaves fresh ones alone', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);
    const fresh = await seedRunKeepingExisting();

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);
    } finally {
      await sweeper.close();
    }
    expect(fresh).toBeDefined();
  });

  it('uses a stable, run-derived job id so two sweeps of the same stale run dedupe to one job', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const { Queue } = await import('bullmq');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);
    // A second run goes stale alongside the first, so the first sweep's
    // batch has rows.length === 2. Reproduces the reviewer's finding: the
    // old jobId (`sweep-${row.id}-${rows.length}`) baked the batch size in,
    // so the same run gets a different job id once the batch size changes.
    const other = await seedRunKeepingExisting();
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      other.id,
    ]);

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    const queue = new Queue('ingest', { connection: { url: config.redisUrl } });
    try {
      await sweeper.sweep(); // batch of 2 -> old code: jobId `sweep-${runId}-2`

      // The other run gets picked up and leaves 'pending', so the next sweep
      // finds only the target run: batch of 1 -> old code: `sweep-${runId}-1`.
      await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [other.id]);
      await sweeper.sweep(); // batch of 1, same target run still pending

      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      const forThisRun = jobs.filter((j) => j.data?.runId === ctx.runId);
      expect(forThisRun).toHaveLength(1);
    } finally {
      await sweeper.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('re-enqueues a run stuck in "parsing" past the parsing window, not just "pending" ones', async () => {
    // markParsing moves a run to 'parsing' before any real work; a worker
    // that dies right there (OOM, SIGKILL, eviction) leaves it stuck forever
    // once BullMQ's attempts are exhausted — the original sweep only ever
    // selected status = 'pending', so nothing ever revisited it.
    const { Sweeper } = await import('../src/sweeper.js');
    const { Queue } = await import('bullmq');
    const ctx = await seedRun(bundle);
    await pool.query(
      `UPDATE run SET status = 'parsing', created_at = now() - interval '20 minutes' WHERE id = $1`,
      [ctx.runId],
    );

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    const queue = new Queue('ingest', { connection: { url: config.redisUrl } });
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);

      const job = await queue.getJob(ctx.runId);
      expect(job).toBeDefined();
      const state = await job?.getState();
      expect(['waiting', 'active', 'delayed', 'prioritized']).toContain(state);
    } finally {
      await sweeper.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('does not re-select a "parsing" run that has not yet crossed the (longer) parsing window', async () => {
    // A run that only just entered 'parsing' is presumably still being
    // worked on — sweeping it immediately (the way 'pending' ages quickly)
    // would race a healthy worker's in-flight job.
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [ctx.runId]);

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(0);
    } finally {
      await sweeper.close();
    }
  });

  it('does not re-select a "parsing" run whose parsing_started_at is fresh, even though created_at is stale — the live-close race (Task 9 fix round 2)', async () => {
    // Reproduces exactly the state RunRepository.claimForClose leaves a
    // long-running live run in: opened (created_at) far longer ago than
    // parsingStaleAfterMs — the ordinary case for the soak tests live
    // streaming exists for — then close() claims it (parsing_started_at
    // set to now). Before this fix, the sweeper's 'parsing' predicate read
    // created_at alone, so this exact row was already "stale" the instant
    // it entered 'parsing' and would have been re-enqueued while close()
    // was still assembling the log — racing PipelineService against a
    // bundleSha256 close() had not finished writing yet.
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(
      `UPDATE run
          SET status = 'parsing',
              created_at = now() - interval '20 minutes',
              parsing_started_at = now()
        WHERE id = $1`,
      [ctx.runId],
    );

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(0);
    } finally {
      await sweeper.close();
    }
  });

  /**
   * ═══ AN ABANDONED RUN KEEPS WHAT IT DID MANAGE TO SEND ═══
   *
   * MEASURED BEFORE THIS EXISTED, against a real stack: a live run given
   * 18,884 bytes of a real `simulation.log` published a live delta reading
   * `count 440 / ok 428 / ko 12` — numbers a reader WATCHED — and the sweeper
   * then finalized it with ZERO stat rows, no simulation and no duration. The
   * chunks sat in the object store, unreachable.
   *
   * ═══ WHY IT COULD NOT SIMPLY BE ENQUEUED ═══
   *
   * `parseSimulationLog`, which the pipeline runs, reads a FINISHED buffer and
   * throws `TruncatedError` on the half-record a dead producer leaves —
   * measured, `needed 4 bytes at 18884, have 0`. `truncateToWholeRecords` asks
   * the STREAMING decoder where the last whole record ended (18,883 here, 882
   * events) and cuts there, which is what makes the partial log a valid one.
   *
   * This asserts the SWEEP's half: the run is claimed off `running`, marked
   * abandoned, and its bundle assembled and hashed. The pipeline's half — that
   * such a run ends `incomplete` WITH statistics rather than `complete` — is
   * the case below.
   */
  it('keeps the data an abandoned run did manage to send', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    // NOTHING AT bundleKey, WHICH IS WHAT A LIVE RUN LOOKS LIKE. `seedRun`
    // uploads a tarball there for the upload path's sake, and
    // `LiveChunkStore.finalize` SKIPS re-assembly when the key already
    // exists — so leaving it made the sweeper hand the pipeline a .tgz and
    // the decoder read gzip's magic byte as a record type ("expected Run
    // record (0) at byte 0, got 31"). A run that is still `running` has
    // never had a bundle assembled; the fixture has to say so.
    const { rows: keyRows } = await pool.query<{ bundle_key: string }>(
      'SELECT bundle_key FROM run WHERE id = $1',
      [ctx.runId],
    );
    await blobs.delete(keyRows[0]!.bundle_key);
    // Half a real log, as a real stream would have left it.
    const half = log.subarray(0, Math.floor(log.length / 2));
    await chunks.put(ctx.runId, 0, half);
    await pool.query(
      `UPDATE run
          SET status = 'running',
              stream_offset = $2,
              stream_updated_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [ctx.runId, half.length],
    );

    const sweeper = new Sweeper(
      { ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000, runningStaleAfterMs: 60_000 },
      pool,
      chunks,
      blobs,
      redisPub,
    );
    try {
      expect(await sweeper.sweep()).toBe(1);
    } finally {
      await sweeper.close();
    }

    const { rows } = await pool.query<{
      status: string;
      stream_abandoned_at: Date | null;
      bundle_bytes: string;
    }>('SELECT status, stream_abandoned_at, bundle_bytes FROM run WHERE id = $1', [ctx.runId]);
    // Claimed for work rather than finalized: `incomplete` is terminal and
    // this run still has a bundle to parse.
    expect(rows[0]?.status).toBe('parsing');
    // WITHOUT THIS the pipeline would finish it `complete`, losing the one
    // signal that says the stream stopped early.
    expect(rows[0]?.stream_abandoned_at).not.toBeNull();
    // Assembled AND cut: strictly shorter than what was streamed, because the
    // last record is half-written.
    expect(Number(rows[0]?.bundle_bytes)).toBeGreaterThan(0);
    expect(Number(rows[0]?.bundle_bytes)).toBeLessThan(half.length);
  });

  /**
   * The pipeline's half of the same journey: a run carrying
   * `stream_abandoned_at` ends `incomplete` WITH its statistics, where any
   * other run ends `complete`. One CASE in the terminal UPDATE, so the
   * statistics and the status still commit together.
   */
  it('finishes an abandoned run as incomplete, with the statistics it parsed', async () => {
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET stream_abandoned_at = now() WHERE id = $1`, [ctx.runId]);

    await pipeline().process(ctx.runId);

    const { rows } = await pool.query<{ status: string; verdict: string | null }>(
      'SELECT status, verdict FROM run WHERE id = $1',
      [ctx.runId],
    );
    expect(rows[0]?.status).toBe('incomplete');

    // THE POINT OF THE WHOLE CHANGE: terminal, and not empty.
    const stats = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM run_stat WHERE run_id = $1`,
      [ctx.runId],
    );
    expect(Number(stats.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('finalizes a "running" run whose producer vanished as incomplete — the state has no other exit', async () => {
    // `running` is entered by POST /v1/runs/live and left by
    // POST /v1/runs/:id/close, and an agent that is SIGKILLed, evicted, or
    // simply loses the network sends no close: the run then answers 202 +
    // Retry-After forever, and the only exit is an operator UPDATE.
    // markIncomplete existed for this transition with no caller anywhere
    // outside its own test.
    //
    // NOT a re-enqueue, and this run is the reason that is still true: it
    // carries `stream_offset = 0`, so nothing was ever streamed and there is
    // nothing to assemble. A run that DID receive bytes now takes the other
    // branch and keeps them — see "keeps the data an abandoned run did
    // manage to send" below.
    //
    // This asserts the ROW only. The run's live/{runId}/* objects survive the
    // sweep by design and no assertion here implies otherwise — they are left
    // for a bucket lifecycle rule (see Sweeper's docstring).
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(
      `UPDATE run
          SET status = 'running',
              stream_updated_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [ctx.runId],
    );

    const sweeper = new Sweeper(
      { ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000, runningStaleAfterMs: 60_000 },
      pool,
      chunks,
      blobs,
      redisPub,
    );
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);
    } finally {
      await sweeper.close();
    }

    const { rows } = await pool.query<{ status: string; verdict: string | null; ingested_at: Date | null }>(
      'SELECT status, verdict, ingested_at FROM run WHERE id = $1',
      [ctx.runId],
    );
    expect(rows[0]?.status).toBe('incomplete');
    // Never 'passed': design §1.2 — a partial run can satisfy every SLA
    // rule purely by having stopped before the load that would have broken
    // it, so this must never green a pipeline.
    expect(rows[0]?.verdict).toBe('not_evaluated');
    expect(rows[0]?.ingested_at).not.toBeNull();
  });

  it('leaves a "running" run alone while its cursor is still moving, however long ago it was opened', async () => {
    // The trap this exists to prove is closed: created_at is a live run's
    // OPEN time, and the soak tests live streaming exists for stream for
    // hours. Measuring 'running' staleness from created_at would kill this
    // run — healthy, mid-stream, a chunk accepted seconds ago — for the
    // sole offence of being long, which is the same defect parsing_started_at
    // was added to fix one state over.
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(
      `UPDATE run
          SET status = 'running',
              created_at = now() - interval '6 hours',
              stream_updated_at = now()
        WHERE id = $1`,
      [ctx.runId],
    );

    const sweeper = new Sweeper(
      { ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000, runningStaleAfterMs: 60_000 },
      pool,
      chunks,
      blobs,
      redisPub,
    );
    try {
      expect(await sweeper.sweep()).toBe(0);
    } finally {
      await sweeper.close();
    }

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.status).toBe('running');
  });

  it('ages a "running" run that never received a byte from its open time, since it has no cursor to measure', async () => {
    // stream_updated_at is null until the first chunk lands, so an agent
    // that opened a run and died before sending anything would otherwise
    // never age at all. COALESCE to created_at, the same fallback the
    // 'parsing' predicate makes for parsing_started_at.
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(
      `UPDATE run
          SET status = 'running',
              created_at = now() - interval '30 minutes',
              stream_updated_at = NULL
        WHERE id = $1`,
      [ctx.runId],
    );

    const sweeper = new Sweeper(
      { ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000, runningStaleAfterMs: 60_000 },
      pool,
      chunks,
      blobs,
      redisPub,
    );
    try {
      expect(await sweeper.sweep()).toBe(1);
    } finally {
      await sweeper.close();
    }

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.status).toBe('incomplete');
  });

  it('never enqueues a job for the "running" run it finalizes', async () => {
    // The routing is per-row, not per-sweep: a stale 'running' run and a
    // stale 'pending' run selected by the SAME sweep must take different
    // branches. Reading the batch's status off anything but each row would
    // hand the live run to PipelineService, which would fail it — bundleKey
    // holds nothing until close() assembles it.
    const { Sweeper } = await import('../src/sweeper.js');
    const { Queue } = await import('bullmq');
    const live = await seedRun(bundle);
    await pool.query(
      `UPDATE run SET status = 'running', stream_updated_at = now() - interval '30 minutes' WHERE id = $1`,
      [live.runId],
    );
    const queued = await seedRunKeepingExisting();
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      queued.id,
    ]);

    const sweeper = new Sweeper(
      { ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000, runningStaleAfterMs: 60_000 },
      pool,
      chunks,
      blobs,
      redisPub,
    );
    const queue = new Queue('ingest', { connection: { url: config.redisUrl } });
    try {
      expect(await sweeper.sweep()).toBe(2);
      expect(await queue.getJob(live.runId)).toBeUndefined();
      expect(await queue.getJob(queued.id)).toBeDefined();
    } finally {
      await sweeper.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('re-queues a run whose existing job is sitting in the failed set, instead of silently skipping it', async () => {
    // Queue.add with an existing jobId returns the existing job and enqueues
    // NOTHING. With removeOnFail keeping failed jobs around, a run whose job
    // already exhausted its attempts and landed in `failed` would be
    // re-selected by every sweep tick forever while zero jobs actually ever
    // get enqueued — proven here against live Redis, not mocked.
    const { Sweeper } = await import('../src/sweeper.js');
    const { Queue, Worker } = await import('bullmq');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);

    const queue = new Queue('ingest', { connection: { url: config.redisUrl } });
    // Drive a real job for this run into the `failed` state via a real
    // worker, the same way the production consumer would after attempts
    // are exhausted — not a hand-constructed job record.
    await queue.add('ingest', { runId: ctx.runId }, { jobId: ctx.runId, attempts: 1 });
    const failingWorker = new Worker(
      'ingest',
      async () => {
        throw new Error('simulated worker death mid-parse');
      },
      { connection: { url: config.redisUrl }, concurrency: 1 },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        failingWorker.on('failed', () => resolve());
        failingWorker.on('error', reject);
      });
    } finally {
      await failingWorker.close();
    }

    const beforeState = await (await queue.getJob(ctx.runId))?.getState();
    expect(beforeState).toBe('failed');

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000, parsingStaleAfterMs: 60_000 }, pool, chunks, blobs, redisPub);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);

      const afterState = await (await queue.getJob(ctx.runId))?.getState();
      expect(afterState).not.toBe('failed');
      expect(['waiting', 'active', 'delayed', 'prioritized']).toContain(afterState);
    } finally {
      await sweeper.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

/** A second pending run created without truncating, so the sweep has both. */
async function seedRunKeepingExisting() {
  const project = await prisma.project.findFirstOrThrow();
  return prisma.run.create({
    data: {
      orgId: project.orgId, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: 'runs/none.tgz', bundleSha256: 'y'.repeat(64), bundleBytes: BigInt(1),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
}
