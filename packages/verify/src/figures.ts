/**
 * The verifier's own vocabulary. It mirrors persistence's `FigureMismatch`
 * field for field (packages/persistence/src/repositories/verification.ts) so
 * the worker can pass a result straight through — but it is declared HERE,
 * because this package may not import persistence (eslint.config.js).
 */

export const VERIFIER_VERSION = 1;

/** One stored figure the verifier re-derived from the raw log and got a different answer for. */
export interface FigureMismatch {
  scope: string;
  name: string;
  family: string;
  /** null for a figure that is not a latency (a count, a run column). */
  population: 'all' | 'ok' | 'ko' | null;
  /** start_offset_ms; null for a run_stat or run_error figure. */
  bucket: number | null;
  table: 'run_stat' | 'run_series_bucket' | 'run_error' | 'run_error_bucket' | 'run_user_bucket' | 'run';
  /** e.g. 'count', 'p95', 'ok_count'; 'row' when a whole row is missing or extra. */
  figure: string;
  stored: number | string | null;
  recomputed: number | string | null;
}

/** The run's frozen engine knobs, with every default filled in (Appendix A). */
export interface VerifyOptions {
  runStartMs: number;
  warmupMs: number;
  percentiles: readonly number[];
  maxBucketsRun: number;
  maxBucketsEndpoint: number;
}

/** One `run_stat` row, figures named by their camel-cased columns. */
export interface ExpectedStat {
  scope: string;
  name: string;
  family: string;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  /** Keyed `p${String(p)}` — `p50`, `p99.9` — exactly as the engine stores them. */
  percentiles: Record<string, number>;
}

/** The two `run` columns derived from the log. */
export interface RunSpans {
  durationMs: number;
  activityMs: number;
}

/**
 * Everything the raw log says the stored figures should be. Tasks 3 and 4
 * add `series`, `errors`, `errorBuckets` and `users` beside these, each with
 * a comparator of its own in compare.ts.
 */
export interface Expected {
  stats: ExpectedStat[];
  run: RunSpans;
}

/** The stored row has the expected row's shape: same columns, read back. */
export type StoredStat = ExpectedStat;

/** What the database holds for one run, mapped by the worker into this shape. */
export interface Stored {
  stats: StoredStat[];
  run: RunSpans;
}

export interface Comparison {
  figuresChecked: number;
  mismatches: FigureMismatch[];
}
