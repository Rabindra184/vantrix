export const INGEST_QUEUE = 'ingest';

// AI run analysis has its own queue, so a slow provider call never sits in
// front of an ingest, and an ingest backlog never delays an analysis a reader
// is waiting on.
export const AI_ANALYSIS_QUEUE = 'ai-analysis';

// Deterministic failures are not retried; the worker decides by
// rethrowing an UnrecoverableError. Transient ones get three tries.
//
// A plain object, not a BullMQ `QueueOptions['defaultJobOptions']` import:
// this package stays dependency-light, and every consumer already has its
// own `Queue` construction to hand this to.
export const INGEST_JOB_OPTIONS = {
  removeOnComplete: 1000,
  removeOnFail: 5000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const;

// One job per run — the API queues it with `jobId` = the run's id, so a second
// request while one is waiting is the same job — run up to three times when
// the provider cannot be reached, ten seconds apart and doubling. Completed
// jobs are removed, because a kept one would hold the run's id and silently
// swallow the next request for that run (a stale analysis generated again).
// Failed jobs are kept a while so an operator can read why.
//
// Here and not in the worker, because the API enqueues: BullMQ takes a job's
// attempts from the options it was ADDED with, and the worker reads them back
// (`job.opts.attempts`) to know which attempt is its last.
export const AI_ANALYSIS_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
} as const;
