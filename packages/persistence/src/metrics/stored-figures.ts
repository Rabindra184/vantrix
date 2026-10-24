import { Histogram } from '@perfportal/statistics';
import type pg from 'pg';
import { partitionDay } from './partition-day.js';

/** A percentile map as stored: `p50`, `p99.9` and so on to milliseconds. */
export type StoredFigurePercentiles = Record<string, number>;

export interface StoredFigureStat {
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
  percentiles: StoredFigurePercentiles;
}

export interface StoredFigureSeriesBucket {
  scope: string;
  name: string;
  family: string;
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  startedOkCount: number | null;
  startedKoCount: number | null;
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: StoredFigurePercentiles;
  percentilesOk: StoredFigurePercentiles | null;
  percentilesKo: StoredFigurePercentiles | null;
}

export interface StoredFigureError {
  scope: string;
  name: string;
  message: string;
  isOther: boolean;
  count: number;
}

export interface StoredFigureErrorBucket {
  startOffsetMs: number;
  message: string;
  isOther: boolean;
  count: number;
  bucketWidthMs: number;
}

export interface StoredFigureUserBucket {
  scenario: string;
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

/**
 * Every stored metric row of one run, decoded, for comparison with what the
 * verifier re-derives from the raw log. Histogram BYTES are left out: they
 * are an encoding, and the figures derived from them are compared instead.
 */
export interface StoredFigures {
  stats: StoredFigureStat[];
  seriesBuckets: StoredFigureSeriesBucket[];
  errors: StoredFigureError[];
  errorBuckets: StoredFigureErrorBucket[];
  userBuckets: StoredFigureUserBucket[];
  run: { durationMs: number | null; activityMs: number | null };
}

/** jsonb arrives parsed from node-postgres; a string is decoded for safety. */
function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/**
 * Reads one run's stored figures. The three partitioned tables are addressed
 * by their partition key, bound through `partitionDay` — the UTC day, as the
 * writer and the reader bind it — so the read prunes to one partition and
 * cannot land on the wrong day on a host west of UTC.
 *
 * Every read is ordered, so two reads of the same rows compare equal.
 */
export async function readStoredFigures(
  pool: pg.Pool,
  runId: string,
  runStartedOn: Date,
): Promise<StoredFigures> {
  const day = partitionDay(runStartedOn);
  // One query after another, not Promise.all: the worker's pool is sized
  // to a budget, and one read must not take six of its clients at once.
  const stats = await pool.query<{
    scope: string;
    name: string;
    family: string;
    count: number;
    ok_count: number;
    ko_count: number;
    error_rate: number;
    min_ms: number;
    max_ms: number;
    mean_ms: number;
    stddev_ms: number;
    throughput_rps: number;
    percentiles: unknown;
  }>(
    `SELECT scope, name, family, count, ok_count, ko_count, error_rate,
            min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles
       FROM run_stat WHERE run_id = $1::uuid
      ORDER BY scope, name, family`,
    [runId],
  );
  const series = await pool.query<{
    scope: string;
    name: string;
    family: string;
    start_offset_ms: number;
    started_count: number;
    ended_count: number;
    ok_count: number;
    ko_count: number;
    started_ok_count: number | null;
    started_ko_count: number | null;
    min_ms: number;
    max_ms: number;
    mean_ms: number;
    percentiles: unknown;
    percentiles_ok: unknown;
    percentiles_ko: unknown;
  }>(
    `SELECT scope, name, family, start_offset_ms, started_count, ended_count, ok_count, ko_count,
            started_ok_count, started_ko_count, min_ms, max_ms, mean_ms,
            percentiles, percentiles_ok, percentiles_ko
       FROM run_series_bucket
      WHERE run_started_on = $1::date AND run_id = $2::uuid
      ORDER BY scope, name, family, start_offset_ms`,
    [day, runId],
  );
  const errors = await pool.query<{ scope: string; name: string; message: string; is_other: boolean; count: number }>(
    `SELECT scope, name, message, is_other, count
       FROM run_error WHERE run_id = $1::uuid
      ORDER BY scope, name, is_other DESC, message`,
    [runId],
  );
  const errorBuckets = await pool.query<{
    start_offset_ms: number;
    message: string;
    is_other: boolean;
    count: number;
    bucket_width_ms: number;
  }>(
    `SELECT start_offset_ms, message, is_other, count, bucket_width_ms
       FROM run_error_bucket
      WHERE run_started_on = $1::date AND run_id = $2::uuid
      ORDER BY start_offset_ms, is_other DESC, message`,
    [day, runId],
  );
  const users = await pool.query<{ scenario: string; start_offset_ms: number; started: number; ended: number; max_concurrent: number }>(
    `SELECT scenario, start_offset_ms, started, ended, max_concurrent
       FROM run_user_bucket
      WHERE run_started_on = $1::date AND run_id = $2::uuid
      ORDER BY scenario, start_offset_ms`,
    [day, runId],
  );
  const run = await pool.query<{ duration_ms: number | null; activity_ms: number | null }>(
    `SELECT duration_ms, activity_ms FROM run WHERE id = $1::uuid`,
    [runId],
  );

  return {
    stats: stats.rows.map((r) => ({
      scope: r.scope,
      name: r.name,
      family: r.family,
      count: r.count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      errorRate: r.error_rate,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      stddevMs: r.stddev_ms,
      throughputRps: r.throughput_rps,
      percentiles: json<StoredFigurePercentiles>(r.percentiles),
    })),
    seriesBuckets: series.rows.map((r) => ({
      scope: r.scope,
      name: r.name,
      family: r.family,
      startOffsetMs: r.start_offset_ms,
      startedCount: r.started_count,
      endedCount: r.ended_count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      startedOkCount: r.started_ok_count,
      startedKoCount: r.started_ko_count,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      percentiles: json<StoredFigurePercentiles>(r.percentiles),
      percentilesOk: r.percentiles_ok === null ? null : json<StoredFigurePercentiles>(r.percentiles_ok),
      percentilesKo: r.percentiles_ko === null ? null : json<StoredFigurePercentiles>(r.percentiles_ko),
    })),
    errors: errors.rows.map((r) => ({
      scope: r.scope,
      name: r.name,
      message: r.message,
      isOther: r.is_other,
      count: r.count,
    })),
    errorBuckets: errorBuckets.rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      message: r.message,
      isOther: r.is_other,
      count: r.count,
      bucketWidthMs: r.bucket_width_ms,
    })),
    userBuckets: users.rows.map((r) => ({
      scenario: r.scenario,
      startOffsetMs: r.start_offset_ms,
      started: r.started,
      ended: r.ended,
      maxConcurrent: r.max_concurrent,
    })),
    run: { durationMs: run.rows[0]?.duration_ms ?? null, activityMs: run.rows[0]?.activity_ms ?? null },
  };
}

/**
 * One population of a stored agent duration bucket, read off its histogram:
 * the shape `@perfportal/verify`'s `AgentPopulationFigures` names, field for
 * field (this package cannot import the verifier, nor it this one).
 */
export interface StoredAgentPopulation {
  count: number;
  min: number;
  max: number;
  sum: number;
  /** The 10 GE percentiles between Min and Max (25 … 99.99), in GE's row order. */
  percentiles: number[];
}

export interface StoredAgentDurationFigures {
  family: string;
  dim: string;
  startOffsetMs: number;
  okCount: number;
  koCount: number;
  /** Null when the stored histogram holds nothing. */
  ok: StoredAgentPopulation | null;
  ko: StoredAgentPopulation | null;
}

export interface StoredAgentMetricFigures {
  metric: string;
  dim: string;
  label: string;
  startOffsetMs: number;
  value: number;
}

/**
 * A run's `run_agent` summary (what the verifier needs to decide whether to
 * check the agent figures at all) and its two agent bucket tables, decoded.
 */
export interface StoredAgentFigures {
  status: 'collected' | 'unreadable';
  reason: string | null;
  /** The run's own series width the figures were bucketed on; null when unreadable. */
  bucketWidthMs: number | null;
  durations: StoredAgentDurationFigures[];
  metrics: StoredAgentMetricFigures[];
}

/** GE's ranks between Min and Max, in row order: the stored histogram is asked exactly these. */
const AGENT_STORED_RANKS = [25, 50, 75, 80, 85, 90, 95, 99, 99.9, 99.99] as const;

function agentPopulation(bytes: Uint8Array): StoredAgentPopulation | null {
  const h = Histogram.deserialize(bytes);
  if (h.total === 0) return null;
  return {
    count: h.total,
    min: h.min,
    max: h.max,
    sum: h.sum,
    // An agent histogram is never a legacy overflow one, so no rank is refused;
    // the fallback only keeps the type honest.
    percentiles: h.percentiles(AGENT_STORED_RANKS).map((v) => v ?? h.max),
  };
}

/**
 * Reads one run's stored agent figures, or null when the run has no `run_agent`
 * row (no agent file was ever seen). Unscoped by org, as `readStoredFigures`
 * is: the verifier is handed a run id it already resolved. Both bucket tables
 * are addressed by their partition key through `partitionDay`, and every read
 * is ordered.
 */
export async function readStoredAgentFigures(
  pool: pg.Pool,
  runId: string,
  runStartedOn: Date,
): Promise<StoredAgentFigures | null> {
  const summary = await pool.query<{ status: 'collected' | 'unreadable'; reason: string | null; bucket_width_ms: number | null }>(
    `SELECT status, reason, bucket_width_ms FROM run_agent WHERE run_id = $1::uuid`,
    [runId],
  );
  const row = summary.rows[0];
  if (row === undefined) return null;

  const day = partitionDay(runStartedOn);
  const durations = await pool.query<{
    family: string;
    dim: string;
    start_offset_ms: number;
    ok_count: number;
    ko_count: number;
    histogram_ok: Buffer;
    histogram_ko: Buffer;
  }>(
    `SELECT family, dim, start_offset_ms, ok_count, ko_count, histogram_ok, histogram_ko
       FROM run_agent_duration_bucket
      WHERE run_started_on = $1::date AND run_id = $2::uuid
      ORDER BY family, dim, start_offset_ms`,
    [day, runId],
  );
  const metrics = await pool.query<{ metric: string; dim: string; label: string; start_offset_ms: number; value: number }>(
    `SELECT metric, dim, label, start_offset_ms, value
       FROM run_agent_metric_bucket
      WHERE run_started_on = $1::date AND run_id = $2::uuid
      ORDER BY metric, dim, label, start_offset_ms`,
    [day, runId],
  );

  return {
    status: row.status,
    reason: row.reason,
    bucketWidthMs: row.bucket_width_ms,
    durations: durations.rows.map((r) => ({
      family: r.family,
      dim: r.dim,
      startOffsetMs: r.start_offset_ms,
      okCount: r.ok_count,
      koCount: r.ko_count,
      ok: agentPopulation(r.histogram_ok),
      ko: agentPopulation(r.histogram_ko),
    })),
    metrics: metrics.rows.map((r) => ({
      metric: r.metric,
      dim: r.dim,
      label: r.label,
      startOffsetMs: r.start_offset_ms,
      value: r.value,
    })),
  };
}
