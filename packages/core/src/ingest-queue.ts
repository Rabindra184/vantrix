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
// the provider cannot be reached, ten seconds apart and doubling.
//
// BOTH ends are removed, unlike ingest's. A finished job kept under the run's
// id makes BullMQ ignore every later `add` with that id, without saying so: a
// kept completed job would swallow the request to generate a stale analysis
// again, and a kept FAILED job the retry a reader clicks and the API's
// re-queue of a row left pending. Why an analysis failed is recorded on its
// row (`failure_reason`) and in the worker's log, so the job has nothing an
// operator needs.
//
// Here and not in the worker, because the API enqueues: BullMQ takes a job's
// attempts from the options it was ADDED with, and the worker reads them back
// (`job.opts.attempts`) to know which attempt is its last.
export const AI_ANALYSIS_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: true,
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
} as const;
