import { AI_ANALYSIS_QUEUE } from '@perfportal/core';
import { Worker } from 'bullmq';
import type { WorkerConfig } from '../config.js';
import { queueWillRetry } from '../consumer.js';
import type { AiAnalysisService, AiOutcome } from './ai-analysis.service.js';

export interface AiAnalysisJobData {
  runId: string;
}

/**
 * ═══ ONE ANALYSIS AT A TIME ═══
 *
 * Concurrency 1: a provider call takes tens of seconds and costs the
 * operator money, and the queue is fed by people clicking a button, not by
 * ingest — a backlog of analyses is never what a deployment needs drained
 * fast. Its own queue (`AI_ANALYSIS_QUEUE`), so it never waits behind an
 * ingest and an ingest never waits behind it; and unlike verify and
 * recompute it does not step aside while ingest has work, because a reader
 * is waiting on this one.
 *
 * The job's attempts and backoff are the ones it was queued with
 * (`AI_ANALYSIS_JOB_OPTIONS`, `@perfportal/core`). `lastAttempt` is BullMQ's
 * own arithmetic (`queueWillRetry`), read before the attempt, so the service
 * records a provider outage only when no attempt is left to recover it.
 */
export function startAiAnalysisConsumer(config: WorkerConfig, service: AiAnalysisService): Worker {
  return new Worker<AiAnalysisJobData, AiOutcome>(
    AI_ANALYSIS_QUEUE,
    (job) => service.generate(job.data.runId, { lastAttempt: !queueWillRetry(job) }),
    { connection: { url: config.redisUrl }, concurrency: 1 },
  );
}
