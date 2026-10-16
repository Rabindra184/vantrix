import { INGEST_QUEUE } from '@perfportal/core';
import type { CandidateCursor, RecomputeRepository } from '@perfportal/persistence';
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
 * Failed jobs are kept (up to 1000) so an operator can read why, and the
 * next scan retries a failed job whose run is still a candidate.
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
  /**
   * Asks for a run to be verified once its statistics are rewritten
   * (`enqueueVerification`). A recompute replaces every figure the last
   * verification checked, so the run is verified again; only a `recomputed`
   * outcome asks — nothing else wrote a row. Optional, for a worker with
   * verification switched off.
   */
  requestVerification?: (runId: string) => Promise<void>;
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
    if (outcome === 'recomputed' && options.requestVerification) {
      // Not thrown: the recompute committed, and a retry of this job would
      // find the run already exact. The verify scan picks up a lost request.
      //
      // ═══ THE RACE WITH A VERIFICATION ALREADY UNDER WAY ═══
      // The two share the run lock, so they never interleave — but a verify
      // job for this run can still EXIST when this request lands (waiting,
      // delayed, or active in BullMQ's bookkeeping just after it released
      // the lock). Its id is the run's, so the request marks the row pending
      // and queues nothing. A waiting job then verifies the run as it now
      // is; for one that had already run, this request's pending row is a
      // candidate the next verify scan re-queues, so the window heals within
      // one scan interval. A request lost outright leaves the `not_exact`
      // answer recorded before the recompute committed, and
      // `verifyCandidateSql`'s stale not_exact arm re-selects that one.
      await options.requestVerification(job.data.runId).catch((err: unknown) => {
        console.error(`recompute: could not queue run ${job.data.runId}'s verification; the next verify scan will pick it up:`, err);
      });
    }
    return outcome;
  });
}

/**
 * Queues every current candidate, walking ALL of them in pages of `batch`
 * (newest first, keyset-paged), keyed by run id so a run already queued is
 * not queued twice. Returns how many it added or re-queued.
 *
 * ═══ EVERY PAGE, NOT THE NEWEST ONE ═══
 *
 * A run stays a candidate until its recompute succeeds or records an error,
 * so a scan that only ever looked at the newest `batch` would be stuck behind
 * them for as long as they stayed -- and a run whose recompute keeps failing
 * transiently stays for ever. Paging is what lets an older run through.
 *
 * ═══ A FAILED JOB IS RE-QUEUED, NOT LEFT AS A TOMBSTONE ═══
 *
 * The job id IS the run id, and a job that exhausted its attempts sits in the
 * failed set (`removeOnFail`) under that id -- so `add` would silently refuse
 * the run for as long as BullMQ kept the record, after any outage long enough
 * to outlast three attempts. A failed job of a run that is STILL a candidate
 * is retried with its attempts reset, and said so in the log every time, so a
 * run that fails on every scan is visible rather than silently stranded.
 */
export async function enqueueCandidates(
  queue: Queue,
  repo: RecomputeRepository,
  batch = 500,
): Promise<number> {
  let added = 0;
  let after: CandidateCursor | undefined;
  for (;;) {
    const page = await repo.candidatePage({}, batch, after);
    added += await enqueuePage(queue, page.ids);
    if (page.next === null) break;
    after = page.next;
  }
  return added;
}

async function enqueuePage(queue: Queue, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // Asked first, because `add` with an id that exists returns the existing
  // job without saying so -- there is no other way to count what was new.
  const existing = await Promise.all(ids.map((id) => queue.getJob(id)));
  const fresh: string[] = [];
  let requeued = 0;
  for (const [i, runId] of ids.entries()) {
    const job = existing[i];
    if (job === undefined) {
      fresh.push(runId);
    } else if ((await job.getState()) === 'failed') {
      await job.retry('failed', { resetAttemptsMade: true });
      console.warn(`recompute: re-queued run ${runId}, whose last attempts all failed: ${job.failedReason}`);
      requeued += 1;
    }
  }
  if (fresh.length > 0) {
    await queue.addBulk(
      fresh.map((runId) => ({
        name: 'recompute',
        data: { runId },
        opts: { ...RECOMPUTE_JOB_OPTIONS, jobId: runId },
      })),
    );
  }
  return fresh.length + requeued;
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
