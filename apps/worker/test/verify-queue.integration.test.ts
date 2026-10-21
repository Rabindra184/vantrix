import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { INGEST_QUEUE } from '@perfportal/core';
import { createPool, createPrisma, VerificationRepository } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import {
  createVerifyScan,
  enqueueVerifyCandidates,
  startVerifyConsumer,
  VERIFY_QUEUE,
} from '../src/verify/verify-queue.js';
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
const ingestQueue = new Queue(INGEST_QUEUE, connection);
const verifications = new VerificationRepository(pool);

let bundle: Buffer;
let consumer: Worker | undefined;

const TABLES = [
  'run_verification', 'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket',
  'run_series_bucket', 'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token',
  'project', 'org', 'org_member', 'session', 'account', 'verification', 'user',
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-queue-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await verifyQueue.obliterate({ force: true });
  await ingestQueue.obliterate({ force: true });
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await consumer?.close();
  consumer = undefined;
  await verifyQueue.obliterate({ force: true });
  await ingestQueue.obliterate({ force: true });
});

afterAll(async () => {
  await verifyQueue.close();
  await ingestQueue.close();
  await pool.end();
  await prisma.$disconnect();
});

/** `n` finished runs of the reference fixture, ingested by the real pipeline, never verified. */
async function seedRuns(n: number): Promise<string[]> {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const pipeline = new PipelineService(config, prisma, pool, blobs);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = `runs/test/${randomUUID()}.tgz`;
    await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
    const run = await prisma.run.create({
      data: {
        orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
        bundleKey: key, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: BigInt(bundle.length),
        startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    await pipeline.process(run.id, { queueWillRetry: false });
    ids.push(run.id);
  }
  return ids;
}

async function status(runId: string): Promise<string | undefined> {
  return (await verifications.find(runId))?.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startConsumer(opts?: Parameters<typeof startVerifyConsumer>[2]): Worker {
  consumer = startVerifyConsumer(config, new VerifyService(config, prisma, pool, blobs), opts);
  return consumer;
}

describe('enqueueVerifyCandidates', () => {
  it('queues every candidate once, keyed by run id, and marks each pending', async () => {
    const ids = await seedRuns(2);

    expect(await enqueueVerifyCandidates(verifyQueue, verifications)).toBe(2);
    expect(await enqueueVerifyCandidates(verifyQueue, verifications)).toBe(0);

    const jobs = await verifyQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs.map((j) => j.id).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await status(id)).toBe('pending');
  });

  it('pages past a newest run that stays queued, so an older candidate is still enqueued', async () => {
    const [older, newest] = await seedRuns(2);
    await pool.query(`UPDATE run SET created_at = '2026-08-07T10:00:00Z' WHERE id = $1`, [older]);
    await pool.query(`UPDATE run SET created_at = '2026-08-07T11:00:00Z' WHERE id = $1`, [newest]);
    await verifyQueue.add('verify', { runId: newest }, { jobId: newest });

    // batch = 1: the newest run fills the first page on its own.
    expect(await enqueueVerifyCandidates(verifyQueue, verifications, 1)).toBe(1);
    expect(await verifyQueue.getJob(older!)).toBeDefined();
  });

  it('a scheduled scan never overlaps itself and logs a failure rather than throwing', async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    vi.spyOn(verifications, 'candidatePage').mockRejectedValueOnce(new Error('db down'));
    const scan = createVerifyScan(verifyQueue, verifications, log);
    await scan();
    expect(log.error).toHaveBeenCalledWith('verify scan failed', expect.any(Error));
  });
});

describe('startVerifyConsumer', () => {
  it('verifies every queued run when no ingest work is waiting', async () => {
    const ids = await seedRuns(2);
    await enqueueVerifyCandidates(verifyQueue, verifications);
    startConsumer();

    for (const id of ids) await until(`run ${id} to be verified`, async () => (await status(id)) === 'verified');
  });

  it('stays pending while ingest work waits, then verifies once it is gone', async () => {
    const [id] = await seedRuns(1);
    const ingestJob = await ingestQueue.add('ingest', { runId: randomUUID() });
    await enqueueVerifyCandidates(verifyQueue, verifications);
    startConsumer({ ingestBusyDelayMs: 500 });

    await until('the verify job to yield to ingest', async () => (await verifyQueue.getJobCounts('delayed')).delayed === 1);
    await sleep(2_000);
    expect(await status(id!)).toBe('pending');

    await ingestJob.remove();
    await until(`run ${id} to be verified`, async () => (await status(id!)) === 'verified');
  });

  it('re-queues a run whose job failed every attempt, on the next scan, and then verifies it', async () => {
    const [id] = await seedRuns(1);
    const failing = vi
      .spyOn(VerifyService.prototype, 'verify')
      .mockRejectedValue(new Error('object store unreachable'));
    await enqueueVerifyCandidates(verifyQueue, verifications);
    startConsumer();

    const job = await until(
      'the verify job to fail every attempt',
      async () => {
        const j = await verifyQueue.getJob(id!);
        return j && (await j.getState()) === 'failed' ? j : null;
      },
      45_000,
    );
    expect(job.attemptsMade).toBe(3);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(await status(id!)).toBe('pending');

    failing.mockRestore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await enqueueVerifyCandidates(verifyQueue, verifications)).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id!));
    await until(`run ${id} to be verified`, async () => (await status(id!)) === 'verified');
  }, 90_000);

  it('delays a locked run rather than failing it, and verifies it once the lock is free', async () => {
    const [id] = await seedRuns(1);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, id]);
      await enqueueVerifyCandidates(verifyQueue, verifications);
      startConsumer({ lockedDelayMs: 500 });

      await until('the locked verify job to be delayed', async () => (await verifyQueue.getJobCounts('delayed')).delayed === 1);
      await sleep(1_500);
      expect(await status(id!)).toBe('pending');
      expect((await verifyQueue.getJob(id!))?.attemptsMade ?? 0).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, id]);
      holder.release();
    }
    await until(`run ${id} to be verified`, async () => (await status(id!)) === 'verified');
  });
});
