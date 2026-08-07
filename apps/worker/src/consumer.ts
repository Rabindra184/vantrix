import { UnrecoverableError, Worker } from 'bullmq';
import type { WorkerConfig } from './config.js';
import { isTransient } from './pipeline/retry.js';
import type { PipelineService } from './pipeline/pipeline.service.js';

export function startConsumer(config: WorkerConfig, pipeline: PipelineService): Worker {
  return new Worker(
    'ingest',
    async (job) => {
      const runId = job.data.runId as string;
      try {
        await pipeline.process(runId);
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
