import { INGEST_QUEUE } from '@perfportal/core';
import type { RecomputeRepository } from '@perfportal/persistence';
import { DelayedError, Queue, Worker, type Job, type Processor } from 'bullmq';
import type { WorkerConfig } from '../config.js';
import type { RecomputeOutcome, RecomputeService } from './recompute.service.js';

export const RECOMPUTE_QUEUE = 'recompute';

export interface RecomputeJobData {
  runId: string;
}

/**
 * Per job, not as queue defaults, so whoever adds a recompute job states
 * them. `removeOnComplete: true` matters beyond tidiness: the job id IS the
 * run id, and a completed job left behind would make a later `add` with that
 * id a silent no-op -- harmless today, because a recomputed run is no longer
 * a candidate, but the dedupe should rest on the run's state, not on history.
 * Failed jobs are kept (up to 1000) so an operator can read why.
 */
const RECOMPUTE_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;

/** How long a recompute steps aside while ingest has work. */
const INGEST_BUSY_DELAY_MS = 5_000;
/** How long a run somebody else holds (an ingest, a live fold) is left alone. */
const LOCKED_DELAY_MS = 30_000;

export interface RecomputeConsumerOptions {
  /** Test seam; production uses the 5 s default. */
  ingestBusyDelayMs?: number;
  /** Test seam; production uses the 30 s default. */
  lockedDelayMs?: number;
}

/**
 * Closes the ingest-queue handle it reads alongside itself, so `main.ts`'s
 * shutdown list needs one entry for the consumer rather than knowing about a
 * second connection it never opened.
 */
class RecomputeWorker extends Worker<RecomputeJobData, RecomputeOutcome> {
  constructor(
    config: WorkerConfig,
    private readonly ingest: Queue,
    processor: Processor<RecomputeJobData, RecomputeOutcome>,
  ) {
    super(RECOMPUTE_QUEUE, processor, { connection: { url: config.redisUrl }, concurrency: 1 });
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
 * ═══ RECOMPUTE ONE RUN AT A TIME, AND NEVER WHILE INGEST HAS WORK ═══
 *
 * A recompute re-reads and re-parses a whole stored log; a fresh upload is
 * somebody waiting for a verdict. So the queue runs at concurrency 1 and,
 * before taking a job, asks the INGEST queue whether anything is waiting,
 * active or delayed -- delayed included, because a delayed ingest job is a
 * retry BullMQ is about to hand straight back to a worker. If so the job is
 * pushed back 5 s through `moveToDelayed` + `DelayedError`, which BullMQ does
 * NOT count as a failed attempt: yielding is not failing.
 *
 * A `locked` outcome is the same shape at 30 s: somebody else holds the run's
 * ingest lock (an ingest, or the live fold owner), and the run will be free
 * later. Every other outcome completes the job -- the three error words are
 * already recorded on the run, which takes it out of every later selection.
 * A THROWN error is transient by `RecomputeService`'s contract and uses the
 * job's own attempts and backoff.
 */
export function startRecomputeConsumer(
  config: WorkerConfig,
  service: RecomputeService,
  options: RecomputeConsumerOptions = {},
): Worker {
  const busyDelay = options.ingestBusyDelayMs ?? INGEST_BUSY_DELAY_MS;
  const lockedDelay = options.lockedDelayMs ?? LOCKED_DELAY_MS;
  const ingest = new Queue(INGEST_QUEUE, { connection: { url: config.redisUrl } });

  const later = async (job: Job<RecomputeJobData>, token: string | undefined, ms: number): Promise<never> => {
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  };

  return new RecomputeWorker(config, ingest, async (job, token) => {
    const ingestWork = await ingest.getJobCounts('waiting', 'active', 'delayed');
    if ((ingestWork.waiting ?? 0) + (ingestWork.active ?? 0) + (ingestWork.delayed ?? 0) > 0) {
      return later(job, token, busyDelay);
    }
    const outcome = await service.recompute(job.data.runId);
    if (outcome === 'locked') return later(job, token, lockedDelay);
    return outcome;
  });
}

/**
 * Queues every current candidate (up to `batch`, newest first), keyed by run
 * id so a run already queued is not queued twice. Returns how many it ADDED.
 *
 * `batch` bounds one scan, not the backlog: a recomputed run stops being a
 * candidate, so the next scan's newest `batch` are the next ones down.
 */
export async function enqueueCandidates(
  queue: Queue,
  repo: RecomputeRepository,
  batch = 500,
): Promise<number> {
  const ids = await repo.candidates({}, batch);
  if (ids.length === 0) return 0;
  // Asked first, because `add` with an id that exists returns the existing
  // job without saying so -- there is no other way to count what was new.
  const existing = await Promise.all(ids.map((id) => queue.getJob(id)));
  const fresh = ids.filter((_, i) => existing[i] === undefined);
  if (fresh.length === 0) return 0;
  await queue.addBulk(
    fresh.map((runId) => ({
      name: 'recompute',
      data: { runId },
      opts: { ...RECOMPUTE_JOB_OPTIONS, jobId: runId },
    })),
  );
  return fresh.length;
}

export interface ScanLog {
  info(message: string): void;
  error(message: string, err: unknown): void;
}

const consoleLog: ScanLog = {
  info: (message) => console.log(message),
  error: (message, err) => console.error(message, err),
};

/**
 * The scheduler's tick: `enqueueCandidates` that never overlaps itself and
 * never rejects. A scan still running when the timer fires again is skipped
 * rather than doubled (a slow database must not stack scans), and a Redis or
 * database failure is logged and left for the next tick -- a backlog that
 * waits ten minutes is fine, a worker that dies over it is not.
 */
export function createRecomputeScan(
  queue: Queue,
  repo: RecomputeRepository,
  log: ScanLog = consoleLog,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const added = await enqueueCandidates(queue, repo);
      log.info(`recompute scan: queued ${added} run${added === 1 ? '' : 's'}`);
    } catch (err) {
      log.error('recompute scan failed', err);
    } finally {
      running = false;
    }
  };
}
