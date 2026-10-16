import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { CanonicalEvent } from '@perfportal/core';
import { createPool, createPrisma, VerificationRepository } from '@perfportal/persistence';
import { GatlingPlugin, parseSimulationLog } from '@perfportal/plugin-gatling';
import { BlobStore } from '@perfportal/storage';
import { VERIFIER_VERSION } from '@perfportal/verify';
import type { Prisma } from '@prisma/client';
import { Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import { RECOMPUTE_QUEUE, enqueueCandidates, startRecomputeConsumer } from '../src/recompute/recompute-queue.js';
import { RecomputeService } from '../src/recompute/recompute.service.js';
import { RecomputeRepository } from '@perfportal/persistence';
import { enqueueVerification, VERIFY_QUEUE } from '../src/verify/verify-queue.js';
import { VerifyService } from '../src/verify/verify.service.js';
import { until } from './backends.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const connection = { connection: { url: config.redisUrl } };
const verifyQueue = new Queue(VERIFY_QUEUE, connection);
const recomputeQueue = new Queue(RECOMPUTE_QUEUE, connection);
const verifications = new VerificationRepository(pool);

let bundle: Buffer;
let log: Buffer;
let consumer: Worker | undefined;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  log = readFileSync(FIXTURE_LOG);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await verifyQueue.obliterate({ force: true });
  await recomputeQueue.obliterate({ force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await consumer?.close();
  consumer = undefined;
  await verifyQueue.obliterate({ force: true });
  await recomputeQueue.obliterate({ force: true });
});

afterAll(async () => {
  await verifyQueue.close();
  await recomputeQueue.close();
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_verification', 'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket',
  'run_series_bucket', 'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token',
  'project', 'org', 'org_member', 'session', 'account', 'verification', 'user',
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
async function seedRun(body: Buffer, engineOptions: Prisma.InputJsonObject = {}) {
  const { orgId, projectId } = await freshOrg();
  const key = `runs/test/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([body]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(body).digest('hex'),
      bundleBytes: BigInt(body.length),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions,
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

function pipeline(requestVerification?: (runId: string) => Promise<void>): PipelineService {
  return new PipelineService(config, prisma, pool, blobs, requestVerification);
}

function service(): VerifyService {
  return new VerifyService(config, prisma, pool, blobs);
}

/** The reference fixture, through the REAL pipeline, ready to verify. */
async function ingested(engineOptions: Prisma.InputJsonObject = {}) {
  const ctx = await seedRun(bundle, engineOptions);
  await pipeline().process(ctx.runId, { queueWillRetry: false });
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [ctx.runId]);
  expect(rows[0]!.status).toBe('complete');
  return ctx;
}

const requestVerification = (runId: string) => enqueueVerification(verifyQueue, verifications, runId).then(() => undefined);

describe('VerifyService', () => {
  /**
   * ═══ THE REFERENCE FIXTURE, THROUGH THE REAL PIPELINE, VERIFIES CLEAN ═══
   *
   * The whole point: two independent implementations (the engine that wrote
   * the rows, and packages/verify that re-derives them from the log) agree on
   * every figure of a real Gatling run — groups, standalone errors and all.
   * A mismatch here is a finding, never something to loosen.
   */
  it('verifies an uploaded run ingested by the real pipeline, with no mismatches', async () => {
    const { runId } = await ingested();

    const outcome = await service().verify(runId);

    const row = await verifications.find(runId);
    expect(row?.mismatches).toEqual([]);
    expect(outcome).toBe('verified');
    expect(row).toMatchObject({ status: 'verified', verifierVersion: VERIFIER_VERSION, unverifiableReason: null });
    expect(row!.figuresChecked).toBeGreaterThan(0);
    expect(row!.checkedAt).not.toBeNull();
  });

  it('records the raw log retention date as the ingest date plus the configured days', async () => {
    const { runId } = await ingested();
    await pool.query(`UPDATE run SET ingested_at = '2026-08-07T23:30:00Z' WHERE id = $1`, [runId]);

    expect(await new VerifyService({ ...config, rawLogRetentionDays: 30 }, prisma, pool, blobs).verify(runId)).toBe('verified');
    expect((await verifications.find(runId))!.rawLogRetainedUntil).toEqual(new Date('2026-09-06T00:00:00Z'));

    expect(await new VerifyService({ ...config, rawLogRetentionDays: 0 }, prisma, pool, blobs).verify(runId)).toBe('verified');
    expect((await verifications.find(runId))!.rawLogRetainedUntil).toBeNull();
  });

  it('verifies a live run whose stored log is a raw simulation.log', async () => {
    const { runId } = await seedLiveRun(log);
    await pipeline().process(runId, { queueWillRetry: false });

    expect(await service().verify(runId)).toBe('verified');
    expect((await verifications.find(runId))!.mismatches).toEqual([]);
  });

  it('verifies a run ingested with a warm-up window', async () => {
    const { runId } = await ingested({ warmupMs: 5_000 });

    expect(await service().verify(runId)).toBe('verified');
    expect((await verifications.find(runId))!.mismatches).toEqual([]);
  });

  /** One stored value per table, nudged: the mismatch names exactly that figure. */
  it.each([
    {
      table: 'run_stat', figure: 'count',
      corrupt: `UPDATE run_stat SET count = count + 1 WHERE run_id = $1 AND scope = 'run'`,
      read: `SELECT count AS v FROM run_stat WHERE run_id = $1 AND scope = 'run'`,
    },
    {
      table: 'run_series_bucket', figure: 'ok_count',
      corrupt: `UPDATE run_series_bucket SET ok_count = ok_count + 1
                 WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'
                   AND start_offset_ms = (SELECT min(start_offset_ms) FROM run_series_bucket
                                           WHERE run_id = $1 AND scope = 'run' AND family = 'response_time')`,
      read: `SELECT ok_count AS v FROM run_series_bucket
              WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'
              ORDER BY start_offset_ms LIMIT 1`,
    },
    {
      table: 'run_error', figure: 'count',
      corrupt: `UPDATE run_error SET count = count + 1
                 WHERE ctid = (SELECT ctid FROM run_error WHERE run_id = $1 AND scope = 'run' ORDER BY message LIMIT 1)`,
      read: `SELECT count AS v FROM run_error WHERE run_id = $1 AND scope = 'run' ORDER BY message LIMIT 1`,
    },
    {
      table: 'run_user_bucket', figure: 'max_concurrent',
      corrupt: `UPDATE run_user_bucket SET max_concurrent = max_concurrent + 1
                 WHERE ctid = (SELECT ctid FROM run_user_bucket WHERE run_id = $1 ORDER BY scenario, start_offset_ms LIMIT 1)`,
      read: `SELECT max_concurrent AS v FROM run_user_bucket WHERE run_id = $1 ORDER BY scenario, start_offset_ms LIMIT 1`,
    },
    {
      table: 'run', figure: 'activity_ms',
      corrupt: `UPDATE run SET activity_ms = activity_ms + 1 WHERE id = $1`,
      read: `SELECT activity_ms AS v FROM run WHERE id = $1`,
    },
  ])('reports a mismatch naming $table.$figure with its stored and recomputed values', async ({ table, figure, corrupt, read }) => {
    const { runId } = await ingested();
    const { rows: before } = await pool.query<{ v: number }>(read, [runId]);
    const truth = before[0]!.v;
    await pool.query(corrupt, [runId]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await service().verify(runId)).toBe('mismatch');

    const row = (await verifications.find(runId))!;
    expect(row.status).toBe('mismatch');
    expect(row.mismatches).toHaveLength(1);
    expect(row.mismatches[0]).toMatchObject({ table, figure, stored: truth + 1, recomputed: truth });
    // ONE line, naming the run and how many figures disagree — not the list.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(runId);
    expect(String(error.mock.calls[0]![0])).toMatch(/\b1 mismatch/);
  });

  it('marks an estimated run not_exact without reading its log', async () => {
    const { runId, bundleKey } = await ingested();
    await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [runId]);
    // Gone from the bucket: a verifier that read the log would report it missing.
    await blobs.delete(bundleKey);

    expect(await service().verify(runId)).toBe('not_exact');
    expect(await verifications.find(runId)).toMatchObject({
      status: 'unverifiable', unverifiableReason: 'not_exact', verifierVersion: VERIFIER_VERSION,
    });
  });

  it('marks a run carrying a legacy stat row not_exact, even if labelled exact', async () => {
    const { runId } = await ingested();
    await pool.query(`UPDATE run_stat SET histogram_kind = 'sparse-ms-v1' WHERE run_id = $1 AND scope = 'request'`, [runId]);

    expect(await service().verify(runId)).toBe('not_exact');
  });

  it('marks a run whose object is gone raw_log_missing', async () => {
    const { runId, bundleKey } = await ingested();
    await blobs.delete(bundleKey);

    expect(await service().verify(runId)).toBe('raw_log_missing');
    expect(await verifications.find(runId)).toMatchObject({ status: 'unverifiable', unverifiableReason: 'raw_log_missing' });
  });

  it('marks a run whose stored bytes no longer match their checksum raw_log_unreadable', async () => {
    const { runId } = await ingested();
    await pool.query(`UPDATE run SET bundle_sha256 = $2 WHERE id = $1`, [runId, '0'.repeat(64)]);

    expect(await service().verify(runId)).toBe('raw_log_unreadable');
  });

  it('marks a log with no run header raw_log_unreadable', async () => {
    const { runId } = await ingested();
    const events = [...parseSimulationLog(log)].filter((e) => e.type !== 'meta');
    vi.spyOn(GatlingPlugin.prototype, 'parse').mockImplementation(async function* () {
      yield* events as CanonicalEvent[];
    });

    expect(await service().verify(runId)).toBe('raw_log_unreadable');
  });

  it('marks a never-verified run whose raw log was deleted raw_log_deleted', async () => {
    const { runId } = await ingested();
    await pool.query(`UPDATE run SET raw_log_deleted_at = now() WHERE id = $1`, [runId]);

    expect(await service().verify(runId)).toBe('raw_log_deleted');
    expect(await verifications.find(runId)).toMatchObject({ status: 'unverifiable', unverifiableReason: 'raw_log_deleted' });
  });

  it('leaves a verified run verified when its raw log has since been deleted', async () => {
    const { runId } = await ingested();
    expect(await service().verify(runId)).toBe('verified');
    await pool.query(`UPDATE run SET raw_log_deleted_at = now() WHERE id = $1`, [runId]);

    expect(await service().verify(runId)).toBe('raw_log_deleted');
    expect((await verifications.find(runId))!.status).toBe('verified');
  });

  it('reports locked while another session holds the run lock, and leaves the row as it was', async () => {
    const { runId } = await ingested();
    await verifications.markPending(runId);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
      expect(await service().verify(runId)).toBe('locked');
      expect((await verifications.find(runId))!.status).toBe('pending');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
      holder.release();
    }
    expect(await service().verify(runId)).toBe('verified');
  });

  /**
   * ═══ THE READ IS UNDER THE LOCK, SO A REWRITE CANNOT TEAR IT ═══
   *
   * A writer (an ingest, a recompute) holds the same advisory lock for its
   * whole rewrite. Here a "writer" waits on that lock and then corrupts a row
   * — while the verifier is between reading the log and reading the stored
   * figures. Under the lock the corruption lands only after the verifier is
   * done, so it reports verified; a verifier that read outside the lock would
   * read the half-rewritten rows.
   */
  it('holds the run lock across the log and the stored rows, so a waiting writer cannot interleave', async () => {
    const { runId } = await ingested();
    const writer = await pool.connect();
    let writerDone: Promise<unknown> | undefined;
    const real = GatlingPlugin.prototype.parse;
    // An unspied instance to decode with, so the real parse runs unchanged.
    const delegate = new GatlingPlugin();
    vi.spyOn(GatlingPlugin.prototype, 'parse').mockImplementation((source) => {
      // The log is open and being decoded: start a writer that takes the run
      // lock (blocking) and rewrites a stored figure, then give it every
      // chance to run before the stored rows are read.
      writerDone = (async () => {
        await writer.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
        await writer.query(`UPDATE run_stat SET count = count + 1 WHERE run_id = $1 AND scope = 'run'`, [runId]);
        await writer.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
      })();
      return (async function* () {
        await new Promise((r) => setTimeout(r, 300));
        yield* real.call(delegate, source);
      })();
    });
    try {
      expect(await service().verify(runId)).toBe('verified');
      await writerDone;
    } finally {
      writer.release();
    }
    // And the writer did land, afterwards.
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await service().verify(runId)).toBe('mismatch');
  });

  it('answers gone for a run that does not exist, and not_eligible for an unfinished one', async () => {
    expect(await service().verify(randomUUID())).toBe('gone');
    const { runId } = await ingested();
    await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [runId]);
    expect(await service().verify(runId)).toBe('not_eligible');
    expect(await verifications.find(runId)).toBeNull();
  });
});

describe('verification requests', () => {
  it('a pipeline success queues a verification and marks the run pending', async () => {
    const { runId } = await seedRun(bundle);
    await pipeline(requestVerification).process(runId, { queueWillRetry: false });

    expect((await verifyQueue.getJob(runId))?.data).toEqual({ runId });
    expect((await verifications.find(runId))!.status).toBe('pending');
  });

  it('a pipeline failure queues nothing and writes no verification row', async () => {
    const garbage = Buffer.from('not a gzip archive at all');
    const { runId } = await seedRun(garbage);
    const asked = vi.fn(requestVerification);

    await expect(pipeline(asked).process(runId, { queueWillRetry: false })).rejects.toBeDefined();

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [runId]);
    expect(rows[0]!.status).toBe('failed');
    expect(asked).not.toHaveBeenCalled();
    expect(await verifyQueue.getJob(runId)).toBeUndefined();
    expect(await verifications.find(runId)).toBeNull();
  });

  it('a verification request that cannot be queued does not fail the ingest', async () => {
    const { runId } = await seedRun(bundle);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await pipeline(() => Promise.reject(new Error('redis down'))).process(runId, { queueWillRetry: false });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [runId]);
    expect(rows[0]!.status).toBe('complete');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(runId), expect.anything());
  });

  /**
   * A pending row for a run with no statistics would never be settled: its
   * job answers not_eligible and the scan never selects it. A FAILED run is
   * the case that matters — every failed ingest would otherwise sit at
   * "Verifying…" for ever.
   */
  it('refuses to mark a failed run, or one never ingested, pending', async () => {
    const { runId: failed } = await seedRun(Buffer.from('not a gzip archive at all'));
    await expect(pipeline().process(failed, { queueWillRetry: false })).rejects.toBeDefined();
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [failed]);
    expect(rows[0]!.status).toBe('failed');

    expect(await enqueueVerification(verifyQueue, verifications, failed)).toBe(false);
    expect(await verifications.find(failed)).toBeNull();
    expect(await verifyQueue.getJob(failed)).toBeUndefined();

    const { runId: unparsed } = await seedRun(bundle);
    expect(await enqueueVerification(verifyQueue, verifications, unparsed)).toBe(false);
    expect(await verifications.find(unparsed)).toBeNull();
  });

  it('a recomputed run queues a verification', async () => {
    const { runId } = await ingested();
    await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [runId]);
    await pool.query(
      `UPDATE run_stat SET sketch = '\\x01'::bytea, histogram_kind = 'sparse-ms-v1' WHERE run_id = $1`,
      [runId],
    );
    await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool));
    consumer = startRecomputeConsumer(config, new RecomputeService(config, prisma, pool, blobs), {
      requestVerification,
    });

    await until('the recomputed run to be queued for verification', async () => (await verifyQueue.getJob(runId)) ?? null);
    expect((await verifications.find(runId))!.status).toBe('pending');
  });
});
