import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { INGEST_JOB_OPTIONS } from '@perfportal/core';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { Queue, type JobsOptions, type Worker } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { startConsumer } from '../src/consumer.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';

/**
 * ═══ A TRANSIENT FAILURE INSIDE THE FINALIZE IS RETRIED, NOT RECORDED ═══
 *
 * Driven through the REAL consumer and a real BullMQ worker, never by calling
 * `PipelineService.process` with an attempt of this file's own making: whether
 * the queue will run a job again is BullMQ's arithmetic over `attemptsMade`,
 * and a test that supplied the answer would prove the pipeline honours it and
 * say nothing about whether the consumer computes it.
 *
 * The injected failure is a REAL one. A harness transaction holds `run_stat`
 * in SHARE mode, which the finalize's first INSERT (`MetricWriter.persist`)
 * cannot pass, so the finalize parks INSIDE its transaction; the harness finds
 * the backend it is blocking (`pg_blocking_pids`, never a count of Lock
 * waiters in the whole database) and terminates it. That is exactly what a
 * database restart or failover does to a transaction in flight: the query
 * rejects with 57P01 and the connection is gone. A trigger raising 57P01 on a
 * live connection would have been simpler and would have hidden two of the
 * defects this file pins, because the real error arrives with a dead client —
 * whose ROLLBACK then rejects, and whose `error` event nobody was listening
 * for.
 *
 * The harness is a participant, so every wait is bounded and every `finally`
 * releases its lock: a harness that holds `run_stat` while waiting on
 * something the pipeline cannot deliver would hang the file rather than fail
 * it.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

// The same known-benign BullMQ teardown artifact pipeline.integration.test.ts
// swallows, and only that one.
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
const queue = new Queue('ingest', { connection: { url: config.redisUrl } });

let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retry-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

// Jobs other files enqueued and nobody consumed would otherwise reach this
// file's worker first, ahead of the one job each case is about.
beforeEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

async function seedRun(bundleSha256 = createHash('sha256').update(bundle).digest('hex')) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${Date.now()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256, bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

/** Enqueued exactly the way the API does (`IngestQueue.add`): the run's id as
 *  the job id, and the production job options unless a case narrows them. */
async function enqueue(runId: string, overrides: JobsOptions = {}) {
  await queue.add('ingest', { runId }, { ...INGEST_JOB_OPTIONS, ...overrides, jobId: runId });
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function settled(runId: string) {
  return until(`run ${runId} to leave pending/parsing`, async () => {
    const run = await prisma.run.findUnique({ where: { id: runId } });
    return run && run.status !== 'pending' && run.status !== 'parsing' ? run : null;
  });
}

/**
 * Holds `run_stat` so the finalize parks inside its transaction, then
 * terminates the backend it parked. With `alsoTheLockHolder`, it also
 * terminates the session holding the run's ingest advisory lock — the second
 * connection a database restart takes with it.
 *
 * TWO CONNECTIONS, AND THE SECOND IS NOT TIDINESS. `pg_stat_activity` read
 * inside a transaction is a snapshot frozen at the transaction's FIRST read of
 * it, so a holder that polled from its own open transaction kept re-reading
 * "nothing is parked yet" for ever whenever that first poll beat the finalize
 * there — measured, as a 180-second wait on a finalize parked the whole time.
 * The observer polls and kills from autocommit, where every read is fresh.
 *
 * Returns what it killed, so a case can prove the kill landed where it meant
 * to rather than on some other backend that happened to be waiting.
 */
async function killTheFinalize(runId: string, opts: { alsoTheLockHolder: boolean }) {
  const holder = new pg.Client({ connectionString: config.databaseUrl });
  const observer = new pg.Client({ connectionString: config.databaseUrl });
  await holder.connect();
  await observer.connect();
  try {
    const { rows: me } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE run_stat IN SHARE MODE');
    const parked = await until('the finalize to park behind the holder', async () => {
      const { rows } = await observer.query<{ pid: number; query: string }>(
        `SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [me[0]!.pid],
      );
      return rows[0] ?? null;
    }, 30_000).catch(async (err: Error) => {
      // A harness that gives up has to say what it saw instead: a run that
      // finished before the lock was taken and a job that never started read
      // identically as "nothing parked".
      const run = await prisma.run.findUnique({ where: { id: runId } });
      const job = await queue.getJob(runId);
      const { rows: backends } = await observer.query<Record<string, unknown>>(
        `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
                left(query, 80) AS query
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      throw new Error(
        `${err.message}: run ${run?.status ?? 'missing'}, job ${job ? await job.getState() : 'missing'}, ` +
          `backends ${JSON.stringify(backends)}`,
      );
    });
    const killed = [parked];
    if (opts.alsoTheLockHolder) {
      const { rows } = await observer.query<{ pid: number; query: string }>(
        `SELECT l.pid, a.query FROM pg_locks l JOIN pg_stat_activity a USING (pid)
          WHERE l.locktype = 'advisory' AND l.classid = $1::oid AND l.granted`,
        [RUN_INGEST_LOCK_NAMESPACE],
      );
      killed.push(...rows);
    }
    for (const k of killed) {
      const { rows } = await observer.query<{ ok: boolean }>(
        'SELECT pg_terminate_backend($1) AS ok',
        [k.pid],
      );
      expect(rows[0]!.ok, `pg_terminate_backend(${k.pid})`).toBe(true);
    }
    return killed;
  } finally {
    // Released only after the kill, so the attempt that parked can never
    // slip through and finish before it is terminated.
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
    await observer.end();
  }
}

async function withConsumer<T>(body: (worker: Worker) => Promise<T>): Promise<T> {
  const worker = startConsumer(config, new PipelineService(config, prisma, pool, blobs));
  try {
    return await body(worker);
  } finally {
    await worker.close();
  }
}

describe('a transient failure inside the finalize transaction', () => {
  it('is retried by the queue, and the next attempt completes the run', async () => {
    const runId = await seedRun();
    await withConsumer(async () => {
      await enqueue(runId);
      const [killed] = await killTheFinalize(runId, { alsoTheLockHolder: false });

      // Vacuity: the backend terminated was the finalize, mid-write. A kill
      // that landed on anything else would let the first attempt complete
      // and this case pass against the defect.
      expect(killed!.query).toMatch(/^INSERT INTO "run_stat"/);

      const run = await settled(runId);
      expect(run.status, JSON.stringify(run.error)).toBe('complete');
      expect(run.error).toBeNull();
      expect(run.durationMs).not.toBeNull();

      const stats = await pool.query('SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1', [runId]);
      expect(stats.rows[0].n).toBeGreaterThan(0);

      // One failed attempt and one that completed: BullMQ counts both.
      const job = await until('the job to complete', async () => {
        const j = await queue.getJob(runId);
        return j && (await j.getState()) === 'completed' ? j : null;
      });
      expect(job.attemptsMade).toBe(2);
    });
  });

  it('still fails the run when the queue has no attempt left to give it', async () => {
    const runId = await seedRun();
    await withConsumer(async () => {
      await enqueue(runId, { attempts: 1 });
      await killTheFinalize(runId, { alsoTheLockHolder: false });

      // Leaving it at 'parsing' here would strand it until the sweeper's
      // parsingStaleAfterMs — fifteen minutes by default — with nothing
      // left to pick it up sooner.
      const run = await settled(runId);
      expect(run.status).toBe('failed');
      expect((run.error as { code: string }).code).toBe('INTERNAL');
    });
  });

  it('survives the lock connection dying with it, as a database restart does', async () => {
    const runId = await seedRun();
    await withConsumer(async () => {
      await enqueue(runId);
      const killed = await killTheFinalize(runId, { alsoTheLockHolder: true });
      expect(killed).toHaveLength(2);

      const run = await settled(runId);
      expect(run.status, JSON.stringify(run.error)).toBe('complete');
    });
  });

  it('does not retry a deterministic failure, however many attempts remain', async () => {
    // A checksum that cannot match: BUNDLE_CHECKSUM_MISMATCH, an IngestError.
    const runId = await seedRun('0'.repeat(64));
    await withConsumer(async () => {
      await enqueue(runId);

      const run = await settled(runId);
      expect(run.status).toBe('failed');
      expect((run.error as { code: string }).code).toBe('BUNDLE_CHECKSUM_MISMATCH');

      const job = await until('the job to fail', async () => {
        const j = await queue.getJob(runId);
        return j && (await j.getState()) === 'failed' ? j : null;
      });
      expect(job.attemptsMade).toBe(1);
    });
  });
});
