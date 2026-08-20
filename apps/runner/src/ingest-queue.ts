import { Queue } from 'bullmq';

export interface IngestJobData {
  runId: string;
}

export class RunnerIngestQueue {
  readonly #queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<IngestJobData>('ingest', {
      connection: { url: redisUrl },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add('ingest', { runId }, { jobId: runId });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
