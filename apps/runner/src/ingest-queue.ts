import { INGEST_JOB_OPTIONS, INGEST_QUEUE } from '@perfportal/core';
import { Queue } from 'bullmq';

export interface IngestJobData {
  runId: string;
}

export class RunnerIngestQueue {
  readonly #queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<IngestJobData>(INGEST_QUEUE, {
      connection: { url: redisUrl },
      defaultJobOptions: INGEST_JOB_OPTIONS,
    });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add(INGEST_QUEUE, { runId }, { jobId: runId });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
