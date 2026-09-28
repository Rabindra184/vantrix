import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { WorkerConfig } from './config.js';
import { isTransient } from './pipeline/retry.js';
import type { PipelineService } from './pipeline/pipeline.service.js';

/**
 * Whether BullMQ will run this job again if the current attempt throws an
 * error it may retry — its own arithmetic (bullmq 5.81.3, `Job#shouldRetryJob`:
 * `attemptsMade + 1 < opts.attempts`), read BEFORE the attempt so the pipeline
 * knows whether a transient failure is worth leaving unrecorded.
 * `attemptsMade` counts the attempts that have already failed, so the first
 * attempt of a three-attempt job reads 0 + 1 < 3 and the third reads 2 + 1 < 3.
 * A job carrying no `attempts` gets exactly one, as BullMQ gives it.
 */
export function queueWillRetry(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 < (job.opts.attempts ?? 1);
}

export function startConsumer(config: WorkerConfig, pipeline: PipelineService): Worker {
  return new Worker(
    'ingest',
    async (job) => {
      const runId = job.data.runId as string;
      try {
        await pipeline.process(runId, { queueWillRetry: queueWillRetry(job) });
      } catch (err) {
        // A deterministic failure is already recorded on the run. Retrying it
        // burns a worker slot to reach the identical conclusion.
        if (!isTransient(err)) {
          throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    { connection: { url: config.redisUrl }, concurrency: config.concurrency },
  );
}
