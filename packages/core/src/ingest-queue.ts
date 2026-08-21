export const INGEST_QUEUE = 'ingest';

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
