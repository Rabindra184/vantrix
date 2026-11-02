import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { AI_ANALYSIS_JOB_OPTIONS, AI_ANALYSIS_QUEUE } from '@perfportal/core';
import { Queue } from 'bullmq';

export interface AiAnalysisJobData {
  runId: string;
}

/**
 * The API's end of the AI analysis queue: it only ever adds. The worker's
 * consumer (`apps/worker/src/ai/ai-queue.ts`) does the work.
 *
 * ═══ ONE JOB PER RUN, AND NONE KEPT UNDER ITS ID ═══
 *
 * `jobId` is the run's id, so a second request while one is waiting is the
 * same job. `AI_ANALYSIS_JOB_OPTIONS` removes a job on BOTH completion and
 * failure, and is passed on every add rather than left to the queue's
 * defaults: BullMQ ignores an `add` whose id matches a job it still holds,
 * without saying so, so a kept failed job would swallow the re-queue of a row
 * left pending. BullMQ also takes a job's attempts from the options it was
 * ADDED with, which the worker reads back to know its last attempt.
 *
 * Closed on shutdown (`onModuleDestroy`), the way `IngestQueue` is.
 */
@Injectable()
export class AiAnalysisQueue implements OnModuleDestroy {
  readonly #queue: Queue<AiAnalysisJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<AiAnalysisJobData>(AI_ANALYSIS_QUEUE, { connection: { url: redisUrl } });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add('ai-analysis', { runId }, { ...AI_ANALYSIS_JOB_OPTIONS, jobId: runId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#queue.close();
  }
}
