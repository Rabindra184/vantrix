import type { ExpectedAgent } from './agent.js';

/**
 * The verifier's own vocabulary. It mirrors persistence's `FigureMismatch`
 * field for field (packages/persistence/src/repositories/verification.ts) so
 * the worker can pass a result straight through — but it is declared HERE,
 * because this package may not import persistence (eslint.config.js).
 */

/**
 * 2: Gatling's own method runs beside the check (gatling-method.ts), so the
 * scan re-checks every run verified by 1 whose raw log still exists and fills
 * in where Gatling's report differs.
 *
 * 3: a run whose agent file was collected has every stored agent figure
 * re-derived from that file (agent.ts) into the same ledger, so the scan
 * re-checks every run verified by 2. A run with no `run_agent` row, or one
 * whose agent file was unreadable at ingest, verifies on `simulation.log`
 * alone, exactly as under 2.
 */
export const VERIFIER_VERSION = 3;

/**
 * The finest bucket width the engine writes, before any coalescing: one
 * second. Both bucketed series start from it — the response-time series
 * halves its bucket count by doubling it, the users series multiplies it by
 * a power of two — so it is ONE constant, not two copies that could disagree.
 */
export const BASE_WIDTH_MS = 1000;

/** One stored figure the verifier re-derived from the raw log and got a different answer for. */
export interface FigureMismatch {
  scope: string;
  name: string;
  family: string;
  /** null for a figure that is not a latency (a count, a run column). */
  population: 'all' | 'ok' | 'ko' | null;
  /** start_offset_ms; null for a run_stat or run_error figure. */
  bucket: number | null;
  table:
    | 'run_stat'
    | 'run_series_bucket'
    | 'run_error'
    | 'run_error_bucket'
    | 'run_user_bucket'
    | 'run'
    | 'run_agent_duration_bucket'
    | 'run_agent_metric_bucket';
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

/**
 * One `run_series_bucket` row, figures named by their camel-cased columns.
 * The three percentile maps carry the FIXED bucket set (`p25` … `p99`), over
 * the bucket's start-edge observations: all of them, the ok ones, the ko ones.
 */
export interface ExpectedSeriesBucket {
  scope: string;
  name: string;
  family: string;
  /** The bucket's index times the series' width; negative before the run start. */
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  startedOkCount: number;
  startedKoCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
  percentilesOk: Record<string, number>;
  percentilesKo: Record<string, number>;
}

/**
 * One `run_error` row. A real row's `message` is its label — the message, or
 * `'(no message)'` for an absent or empty one, so a real label is never `''`.
 * The remainder past the 200 kept messages is ONE row with `isOther` set and
 * `message` `''`.
 */
export interface ExpectedError {
  scope: string;
  name: string;
  message: string;
  isOther: boolean;
  count: number;
}

/**
 * One `run_error_bucket` row (run scope only). A top message keeps its own
 * row; everything else in the bucket is the `isOther` row, `message` `''`.
 * `bucketWidthMs` is the run series' width, stored on every row.
 */
export interface ExpectedErrorBucket {
  startOffsetMs: number;
  message: string;
  isOther: boolean;
  count: number;
  bucketWidthMs: number;
}

/** One `run_user_bucket` row: a scenario's users over one bucket. */
export interface ExpectedUserBucket {
  scenario: string;
  /** The bucket's index times the scenario's (coalesced) width; negative before the run start. */
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

/** The two `run` columns derived from the log. */
export interface RunSpans {
  durationMs: number;
  activityMs: number;
}

/**
 * Everything the raw log says the stored figures should be: one list per
 * metric table, each with a comparator of its own in compare.ts, and the run's
 * two spans.
 */
export interface Expected {
  stats: ExpectedStat[];
  series: ExpectedSeriesBucket[];
  errors: ExpectedError[];
  errorBuckets: ExpectedErrorBucket[];
  users: ExpectedUserBucket[];
  run: RunSpans;
  /**
   * What the run's agent file says its two agent tables should hold; absent
   * when the run has no collected agent file, and then neither agent table is
   * compared at all.
   */
  agent?: ExpectedAgent;
}

/** The stored row has the expected row's shape: same columns, read back. */
export type StoredStat = ExpectedStat;

/**
 * A stored series bucket. Four columns are nullable in the table (rows written
 * before the exact-statistics work have none), so the mirror lets them be
 * null; a null is compared against the figure it should hold, never skipped.
 */
export type StoredSeriesBucket = Omit<ExpectedSeriesBucket, 'startedOkCount' | 'startedKoCount' | 'percentilesOk' | 'percentilesKo'> & {
  startedOkCount: number | null;
  startedKoCount: number | null;
  percentilesOk: Record<string, number> | null;
  percentilesKo: Record<string, number> | null;
};

/** The error and user tables have no nullable column: a stored row is the expected shape, read back. */
export type StoredError = ExpectedError;
export type StoredErrorBucket = ExpectedErrorBucket;
export type StoredUserBucket = ExpectedUserBucket;

/**
 * What the database holds for one run, mapped by the worker into this shape.
 * Persistence names two of these lists differently (`seriesBuckets`,
 * `userBuckets`); the rows' field names match.
 */
export interface Stored {
  stats: StoredStat[];
  series: StoredSeriesBucket[];
  errors: StoredError[];
  errorBuckets: StoredErrorBucket[];
  users: StoredUserBucket[];
  run: RunSpans;
  /** The two agent tables, histograms decoded into figures; absent when not compared. */
  agent?: StoredAgent;
}

/**
 * A stored agent row is the expected shape, read back: an empty population is
 * null on either side, and a null against a population is compared figure by
 * figure, never skipped.
 */
export type StoredAgent = ExpectedAgent;

export interface Comparison {
  figuresChecked: number;
  mismatches: FigureMismatch[];
}
