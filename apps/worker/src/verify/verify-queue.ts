import { INGEST_QUEUE } from '@perfportal/core';
import type { CandidateCursor, VerificationRepository } from '@perfportal/persistence';
import { VERIFIER_VERSION } from '@perfportal/verify';
import { DelayedError, Queue, Worker, type Job, type Processor } from 'bullmq';
import type { WorkerConfig } from '../config.js';
import type { ScanLog } from '../recompute/recompute-queue.js';
import type { VerifyOutcome, VerifyService } from './verify.service.js';

export const VERIFY_QUEUE = 'verify';

export interface VerifyJobData {
  runId: string;
}

/**
 * The recompute queue's options, for its reasons: the job id IS the run id,
 * so a completed job must not linger and silently swallow the next request
 * for that run; failed jobs are kept so an operator can read why, and the
 * next scan re-queues them.
 */
const VERIFY_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;

/** How long a verification steps aside while ingest has work. */
const INGEST_BUSY_DELAY_MS = 5_000;
/** How long a run somebody else holds (an ingest, a recompute, a live fold) is left alone. */
const LOCKED_DELAY_MS = 30_000;

export interface VerifyConsumerOptions {
  /** Test seam; production uses the 5 s default. */
  ingestBusyDelayMs?: number;
  /** Test seam; production uses the 30 s default. */
  lockedDelayMs?: number;
}

/** Closes the ingest-queue handle it reads alongside itself (`RecomputeWorker`'s reason). */
class VerifyWorker extends Worker<VerifyJobData, VerifyOutcome> {
  constructor(
    config: WorkerConfig,
    private readonly ingest: Queue,
    processor: Processor<VerifyJobData, VerifyOutcome>,
  ) {
    super(VERIFY_QUEUE, processor, { connection: { url: config.redisUrl }, concurrency: 1 });
  }

  override async close(force?: boolean): Promise<void> {
    try {
      await super.close(force);
    } finally {
      await this.ingest.close();
    }
  }
}

/**
 * ═══ VERIFY ONE RUN AT A TIME, AND NEVER WHILE INGEST HAS WORK ═══
 *
 * The recompute consumer's shape exactly (`recompute-queue.ts`): concurrency
 * 1; ingest work waiting, active or delayed pushes the job back 5 s through
 * `moveToDelayed` + `DelayedError`, which BullMQ does not count as a failed
 * attempt; a `locked` run is pushed back 30 s. Every other outcome completes
 * the job — each is recorded on the run's verification row, or needs nothing.
 * A THROWN error is transient by `VerifyService`'s contract and uses the
 * job's own attempts and backoff.
 */
export function startVerifyConsumer(
  config: WorkerConfig,
  service: VerifyService,
  options: VerifyConsumerOptions = {},
): Worker {
  const busyDelay = options.ingestBusyDelayMs ?? INGEST_BUSY_DELAY_MS;
  const lockedDelay = options.lockedDelayMs ?? LOCKED_DELAY_MS;
  const ingest = new Queue(INGEST_QUEUE, { connection: { url: config.redisUrl } });

  const later = async (job: Job<VerifyJobData>, token: string | undefined, ms: number): Promise<never> => {
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  };

  return new VerifyWorker(config, ingest, async (job, token) => {
    const ingestWork = await ingest.getJobCounts('waiting', 'active', 'delayed');
    if ((ingestWork.waiting ?? 0) + (ingestWork.active ?? 0) + (ingestWork.delayed ?? 0) > 0) {
      return later(job, token, busyDelay);
    }
    const outcome = await service.verify(job.data.runId);
    if (outcome === 'locked') return later(job, token, lockedDelay);
    return outcome;
  });
}

/**
 * Asks for one run to be verified: marks it pending (so the run header can
 * say "Verifying…") and queues its job. Returns false, touching nothing, for
 * a run that is not verifiable — a failed run, or one with no statistics —
 * because a pending row for it would never be settled.
 *
 * ═══ PENDING FIRST, THEN THE JOB ═══
 *
 * The other order lets the job run and record its answer before the pending
 * write lands on top of it, leaving a verified run reading "Verifying…" until
 * the next scan. And if the job cannot be queued after the row is pending,
 * the scan re-queues it: a pending row is one of the things it selects.
 */
export async function enqueueVerification(
  queue: Queue,
  repo: VerificationRepository,
  runId: string,
): Promise<boolean> {
  if (!(await repo.isVerifiable(runId))) return false;
  await repo.markPending(runId);
  await enqueuePage(queue, repo, [runId], { alreadyPending: true });
  return true;
}

/**
 * Queues every current candidate — a verifiable run never verified, still
 * pending, or verified by an older `VERIFIER_VERSION` — walking ALL of them in
 * pages of `batch`, keyed by run id. Returns how many it added or re-queued.
 * Keyset-paged and failed-job-requeueing for the reasons
 * `enqueueCandidates` (`recompute-queue.ts`) gives: a scan stuck on its
 * newest page never reaches an older run, and a job that exhausted its
 * attempts sits in the failed set under the run's id, where `add` would
 * silently refuse it for as long as BullMQ kept the record.
 */
export async function enqueueVerifyCandidates(
  queue: Queue,
  repo: VerificationRepository,
  batch = 500,
): Promise<number> {
  let added = 0;
  let after: CandidateCursor | null = null;
  for (;;) {
    const page = await repo.candidatePage(VERIFIER_VERSION, after, batch);
    added += await enqueuePage(queue, repo, page.ids, { alreadyPending: false });
    if (page.next === null) break;
    after = page.next;
  }
  return added;
}

async function enqueuePage(
  queue: Queue,
  repo: VerificationRepository,
  ids: readonly string[],
  opts: { alreadyPending: boolean },
): Promise<number> {
  if (ids.length === 0) return 0;
  // Asked first, because `add` with an id that exists returns the existing
  // job without saying so.
  const existing = await Promise.all(ids.map((id) => queue.getJob(id)));
  const fresh: string[] = [];
  let requeued = 0;
  for (const [i, runId] of ids.entries()) {
    const job = existing[i];
    if (job === undefined) {
      fresh.push(runId);
    } else if ((await job.getState()) === 'failed') {
      if (!opts.alreadyPending) await repo.markPending(runId);
      await job.retry('failed', { resetAttemptsMade: true });
      console.warn(`verify: re-queued run ${runId}, whose last attempts all failed: ${job.failedReason}`);
      requeued += 1;
    }
  }
  if (fresh.length === 0) return requeued;
  // Pending before the job, as `enqueueVerification` argues. Every id here
  // came from candidatePage, which selects verifiable runs only.
  if (!opts.alreadyPending) for (const runId of fresh) await repo.markPending(runId);
  await queue.addBulk(
    fresh.map((runId) => ({
      name: 'verify',
      data: { runId },
      opts: { ...VERIFY_JOB_OPTIONS, jobId: runId },
    })),
  );
  return fresh.length + requeued;
}

const consoleLog: ScanLog = {
  info: (message) => console.log(message),
  error: (message, err) => console.error(message, err),
};

/**
 * The scheduler's tick: `enqueueVerifyCandidates` that never overlaps itself
 * and never rejects (`createRecomputeScan`'s contract and reasons).
 */
export function createVerifyScan(
  queue: Queue,
  repo: VerificationRepository,
  log: ScanLog = consoleLog,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const added = await enqueueVerifyCandidates(queue, repo);
      log.info(`verify scan: queued ${added} run${added === 1 ? '' : 's'}`);
    } catch (err) {
      log.error('verify scan failed', err);
    } finally {
      running = false;
    }
  };
}
