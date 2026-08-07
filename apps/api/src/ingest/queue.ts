import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const INGEST_QUEUE = 'ingest';

export interface IngestJobData {
  runId: string;
}

@Injectable()
export class IngestQueue implements OnModuleDestroy {
  readonly #queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<IngestJobData>(INGEST_QUEUE, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        // Deterministic failures are not retried; the worker decides by
        // rethrowing an UnrecoverableError. Transient ones get three tries.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add('ingest', { runId }, { jobId: runId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#queue.close();
  }
}
