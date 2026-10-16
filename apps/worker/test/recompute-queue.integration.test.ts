import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { INGEST_QUEUE } from '@perfportal/core';
import { createPool, createPrisma, RecomputeRepository } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import {
  enqueueCandidates,
  RECOMPUTE_QUEUE,
  startRecomputeConsumer,
} from '../src/recompute/recompute-queue.js';
import { RecomputeService } from '../src/recompute/recompute.service.js';
import { until } from './backends.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const connection = { connection: { url: config.redisUrl } };
const recomputeQueue = new Queue(RECOMPUTE_QUEUE, connection);
const ingestQueue = new Queue(INGEST_QUEUE, connection);

let bundle: Buffer;
let consumer: Worker | undefined;

const TABLES = [
  'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket', 'run_series_bucket',
  'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recompute-queue-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await recomputeQueue.obliterate({ force: true });
  await ingestQueue.obliterate({ force: true });
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await consumer?.close();
  consumer = undefined;
  await recomputeQueue.obliterate({ force: true });
  await ingestQueue.obliterate({ force: true });
});

afterAll(async () => {
  await recomputeQueue.close();
  await ingestQueue.close();
  await pool.end();
  await prisma.$disconnect();
});

/** Two finished runs in one project, each made to look written before exact statistics. */
async function seedLegacyRuns(n: number): Promise<string[]> {
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
    await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [run.id]);
    await pool.query(
      `UPDATE run_stat SET sketch = '\\x01'::bytea, histogram_kind = 'sparse-ms-v1' WHERE run_id = $1`,
      [run.id],
    );
    ids.push(run.id);
  }
  return ids;
}

async function statsMethod(runId: string): Promise<string> {
  const { rows } = await pool.query<{ stats_method: string }>(
    'SELECT stats_method FROM run WHERE id = $1',
    [runId],
  );
  return rows[0]!.stats_method;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startConsumer(opts?: Parameters<typeof startRecomputeConsumer>[2]): Worker {
  consumer = startRecomputeConsumer(config, new RecomputeService(config, prisma, pool, blobs), opts);
  return consumer;
}

describe('enqueueCandidates', () => {
  it('adds every candidate once, keyed by run id, so a second scan adds nothing', async () => {
    const ids = await seedLegacyRuns(2);
    const repo = new RecomputeRepository(pool);

    expect(await enqueueCandidates(recomputeQueue, repo)).toBe(2);
    expect(await enqueueCandidates(recomputeQueue, repo)).toBe(0);

    const jobs = await recomputeQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs.map((j) => j.id).sort()).toEqual([...ids].sort());
    expect(jobs.map((j) => j.data.runId).sort()).toEqual([...ids].sort());
  });

  it('pages past a newest run that stays queued, so an older candidate is still enqueued', async () => {
    const [older, newest] = await seedLegacyRuns(2);
    await pool.query(`UPDATE run SET created_at = '2026-08-07T10:00:00Z' WHERE id = $1`, [older]);
    await pool.query(`UPDATE run SET created_at = '2026-08-07T11:00:00Z' WHERE id = $1`, [newest]);
    // The newest is already queued (a run that stays a candidate: one being
    // retried, or one whose recompute keeps failing).
    await recomputeQueue.add('recompute', { runId: newest }, { jobId: newest });

    // batch = 1: the newest run fills the first page on its own.
    expect(await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool), 1)).toBe(1);
    expect(await recomputeQueue.getJob(older!)).toBeDefined();
  });

  it('adds nothing when no run needs recomputing', async () => {
    expect(await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool))).toBe(0);
  });
});

describe('startRecomputeConsumer', () => {
  it('recomputes every queued run when no ingest work is waiting', async () => {
    const ids = await seedLegacyRuns(2);
    await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool));
    startConsumer();

    for (const id of ids) {
      await until(`run ${id} to become exact-v1`, async () => (await statsMethod(id)) === 'exact-v1');
    }
    await until('the recompute queue to drain', async () => {
      const c = await recomputeQueue.getJobCounts('waiting', 'active', 'delayed');
      return (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) === 0;
    });
  });

  it('stays estimated while ingest work waits, then completes once it is gone', async () => {
    const [id] = await seedLegacyRuns(1);
    // An ingest job nothing consumes: ingest work that is waiting.
    const ingestJob = await ingestQueue.add('ingest', { runId: randomUUID() });
    await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool));
    startConsumer({ ingestBusyDelayMs: 500 });

    await until('the recompute job to yield to ingest', async () => {
      const c = await recomputeQueue.getJobCounts('delayed');
      return c.delayed === 1;
    });
    await sleep(2_000);
    expect(await statsMethod(id!)).toBe('estimated');

    await ingestJob.remove();
    await until(`run ${id} to become exact-v1`, async () => (await statsMethod(id!)) === 'exact-v1');
  });

  it('re-queues a run whose job failed every attempt, on the next scan, and then recomputes it', async () => {
    const [id] = await seedLegacyRuns(1);
    const failing = vi
      .spyOn(RecomputeService.prototype, 'recompute')
      .mockRejectedValue(new Error('object store unreachable'));
    await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool));
    startConsumer();

    // attempts: 3 with exponential backoff from 5 s: about 15 s to exhaust.
    const job = await until(
      'the recompute job to fail every attempt',
      async () => {
        const j = await recomputeQueue.getJob(id!);
        return j && (await j.getState()) === 'failed' ? j : null;
      },
      45_000,
    );
    expect(job.attemptsMade).toBe(3);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(await statsMethod(id!)).toBe('estimated');

    failing.mockRestore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool))).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id!));
    await until(`run ${id} to become exact-v1`, async () => (await statsMethod(id!)) === 'exact-v1');
  }, 90_000);

  it('delays a locked run rather than failing it, and recomputes it once the lock is free', async () => {
    const [id] = await seedLegacyRuns(1);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, id]);
      await enqueueCandidates(recomputeQueue, new RecomputeRepository(pool));
      startConsumer({ lockedDelayMs: 500 });

      await until('the locked recompute job to be delayed', async () => {
        const c = await recomputeQueue.getJobCounts('delayed');
        return c.delayed === 1;
      });
      await sleep(1_500);
      expect(await statsMethod(id!)).toBe('estimated');
      const job = await recomputeQueue.getJob(id!);
      expect(job?.attemptsMade ?? 0).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, id]);
      holder.release();
    }
    await until(`run ${id} to become exact-v1`, async () => (await statsMethod(id!)) === 'exact-v1');
  });
});
