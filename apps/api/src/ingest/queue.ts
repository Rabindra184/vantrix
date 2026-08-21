import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { INGEST_JOB_OPTIONS, INGEST_QUEUE } from '@perfportal/core';
import { Queue } from 'bullmq';

export { INGEST_QUEUE };

export interface IngestJobData {
  runId: string;
}

@Injectable()
export class IngestQueue implements OnModuleDestroy {
  readonly #queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<IngestJobData>(INGEST_QUEUE, {
      connection: { url: redisUrl },
      defaultJobOptions: INGEST_JOB_OPTIONS,
    });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add('ingest', { runId }, { jobId: runId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#queue.close();
  }
}
