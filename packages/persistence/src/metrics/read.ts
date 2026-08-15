import { Histogram, Sketch } from '@perfportal/statistics';
import type pg from 'pg';
import type { ProjectScope } from '../repositories/tenant.js';
import { TRENDS_SQL, type StoredTrendRun } from './trends.js';

export interface StoredStat {
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
  percentiles: Record<string, number>;
  /** Null for runs ingested before the parity migration; the API reports those as non-configurable. */
  histogramOk: Histogram | null;
  histogramKo: Histogram | null;
  /**
   * The persisted summary sketch, for recomputing `percentiles` at the
   * project's currently configured set (spec §9.1, K-03). Null for rows
   * written before the sketch was persisted, in which case callers fall
   * back to the frozen `percentiles` column.
   */
  sketch: Sketch | null;
}

export interface StoredUserBucket {
  scenario: string;
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

export interface StoredErrorBucket {
  startOffsetMs: number;
  /**
   * `null` is the FOLDED REMAINDER — everything outside the five most frequent
   * messages — reconstructed from the `is_other` column. Not a message that
   * failed to load, and not a message literally named 'other', which is a real
   * value this column can also carry.
   */
  message: string | null;
  count: number;
  /** Constant per run; see ERROR_SERIES_SQL and the migration. */
  bucketWidthMs: number;
}

export interface StoredBucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  /**
   * The START-edge outcome split (requests/s, G-23), as opposed to
   * okCount/koCount, which are the END-edge split (responses/s). `null` — NOT
   * zero — for rows written before the migration that added the columns; the
   * caller reports absence rather than drawing two flat zero lines.
   */
  startedOkCount: number | null;
  startedKoCount: number | null;
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
  /** Status-filtered. `{}` for rows written before the per-status migration. */
  percentilesOk: Record<string, number>;
  percentilesKo: Record<string, number>;
}

export interface StatKey {
  scope: string;
  name: string;
  family: string;
}

/**
 * The series query, shared verbatim between `MetricReader.series` and the
 * "prunes partitions" integration test (see metrics.integration.test.ts). That
 * sharing is load-bearing: `run_started_on = $1` is the partition-key predicate
 * that lets Postgres prune `run_series_bucket`'s range partitions down to one.
 * A query that filters on run_id alone cannot prune and silently scans every
 * partition instead — the exact failure this design exists to prevent. Editing
 * this constant is what the "prunes partitions" test actually exercises; a
 * hand-copied EXPLAIN query in the test file would drift from this one and
 * stop catching that regression.
 */
export const SERIES_SQL = `SELECT start_offset_ms, started_count, ended_count, ok_count, ko_count,
              started_ok_count, started_ko_count,
              min_ms, max_ms, mean_ms, percentiles, percentiles_ok, percentiles_ko
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND name = $6 AND family = $7
        ORDER BY start_offset_ms`;

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL: `run_started_on = $1` is the partition-key
 * predicate that lets Postgres prune `run_user_bucket`'s range partitions down
 * to one. A hand-copied EXPLAIN query in the test would drift from this one and
 * stop catching the regression it exists to catch.
 */
export const USER_SERIES_SQL = `SELECT scenario, start_offset_ms, started, ended, max_concurrent
         FROM run_user_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
        ORDER BY scenario, start_offset_ms`;

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL and USER_SERIES_SQL: `run_started_on = $1`
 * is the partition-key predicate, and a test asserting the plan of a COPY of
 * this string would keep passing after the real one lost it.
 *
 * No `scope`/`name` predicate: this table is run scope only, by design.
 *
 * `ORDER BY start_offset_ms, count DESC, message` puts a bucket's rows in
 * global rank order — the order the engine emitted them in — so the API can
 * group by message in first-seen order and get the most frequent series first
 * without re-sorting.
 */
export const ERROR_SERIES_SQL = `SELECT start_offset_ms, message, is_other, count, bucket_width_ms
         FROM run_error_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
        ORDER BY start_offset_ms ASC, count DESC, message ASC`;

/** Existence only — the caller needs a yes/no, and a partition-pruned EXISTS is
 *  cheaper than counting rows it will not read. */
export const HAS_GROUP_SERIES_SQL = `SELECT EXISTS (
         SELECT 1 FROM run_series_bucket
          WHERE run_started_on = $1 AND run_id = $2
            AND org_id = $3 AND project_id = $4
            AND scope = 'group'
        ) AS present`;

export class MetricReader {
  constructor(private readonly pool: pg.Pool) {}

  async stats(scope: ProjectScope, runId: string): Promise<StoredStat[]> {
    const { rows } = await this.pool.query(
      `SELECT scope, name, family, count, ok_count, ko_count, error_rate,
              min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
              histogram_ok, histogram_ko, sketch
         FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
        ORDER BY scope, name, family`,
      [runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
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
      percentiles: r.percentiles as Record<string, number>,
      histogramOk: r.histogram_ok ? Histogram.deserialize(new Uint8Array(r.histogram_ok)) : null,
      histogramKo: r.histogram_ko ? Histogram.deserialize(new Uint8Array(r.histogram_ko)) : null,
      sketch: r.sketch ? Sketch.deserialize(new Uint8Array(r.sketch)) : null,
    }));
  }

  /**
   * A run's cohort — every complete run of the same simulation in the same
   * project, newest first — with the cohort's full size beside it.
   *
   * NO PARTITION KEY, unlike `series` below, and that is not an oversight:
   * `run_series_bucket` is partitioned by `run_started_on`, `run_stat` is not.
   * A cohort spans many runs and therefore many dates, so a partition key
   * would be the wrong shape for this query even if the table had one.
   *
   * ONE QUERY. `cohort_size` rides along as a window function over the inner
   * query — PostgreSQL evaluates those before `LIMIT`, and this one has no
   * LIMIT at all: the window is selected by the outer `WHERE`, so the count is
   * the whole cohort's on every row.
   *
   * `requestedRunId` is what guarantees the asked-about run appears in its own
   * trend. Without it the query returns the newest `limit` runs, which stops
   * containing that run the moment the cohort outgrows the window — see
   * `TRENDS_SQL`.
   */
  async trends(
    scope: ProjectScope,
    cohort: { simulation: string | null },
    requestedRunId: string,
    limit: number,
  ): Promise<{ runs: StoredTrendRun[]; cohortSize: number }> {
    const { rows } = await this.pool.query(TRENDS_SQL, [
      scope.orgId,
      scope.projectId,
      cohort.simulation,
      limit,
      requestedRunId,
    ]);

    return {
      runs: rows.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        toolStartedAt: r.tool_started_at,
        durationMs: r.duration_ms,
        verdict: r.verdict,
        count: r.count,
        okCount: r.ok_count,
        koCount: r.ko_count,
        errorRate: r.error_rate,
        minMs: r.min_ms,
        maxMs: r.max_ms,
        meanMs: r.mean_ms,
        throughputRps: r.throughput_rps,
        percentiles: r.percentiles as Record<string, number>,
        // Deserialised here exactly as `stats` above does it, so the two
        // endpoints answer percentile questions from the same object rather
        // than from a stored float and a sketch respectively.
        sketch: r.sketch ? Sketch.deserialize(new Uint8Array(r.sketch)) : null,
      })),
      // Identical on every row; zero only when there are no rows at all, which
      // cannot happen for a terminal run since it matches its own cohort.
      cohortSize: rows[0]?.cohort_size ?? 0,
    };
  }

  /**
   * runStartedOn is REQUIRED, not optional. It is the partition key: a query
   * filtering on run_id alone cannot prune and scans every partition. The
   * signature is what enforces that, and the "prunes partitions" integration
   * test asserts the plan of this exact query via the shared `SERIES_SQL`.
   */
  async series(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
    sel: { scope: string; name: string; family: string },
  ): Promise<StoredBucket[]> {
    const { rows } = await this.pool.query(
      SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId, sel.scope, sel.name, sel.family],
    );
    return rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      startedCount: r.started_count,
      endedCount: r.ended_count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      // Deliberately NOT `?? 0`: a pre-migration row has no split, and zero
      // would read as "no failures started here" instead of "not recorded".
      startedOkCount: r.started_ok_count,
      startedKoCount: r.started_ko_count,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      percentiles: r.percentiles as Record<string, number>,
      percentilesOk: (r.percentiles_ok ?? {}) as Record<string, number>,
      percentilesKo: (r.percentiles_ko ?? {}) as Record<string, number>,
    }));
  }

  async hasGroupSeries(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      HAS_GROUP_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows[0]?.present === true;
  }

  /** Both status histograms for one (scope, name, family). Null when the row has none. */
  async histograms(
    scope: ProjectScope,
    runId: string,
    key: StatKey,
  ): Promise<{ ok: Histogram; ko: Histogram } | null> {
    const { rows } = await this.pool.query<{ histogram_ok: Buffer | null; histogram_ko: Buffer | null }>(
      `SELECT histogram_ok, histogram_ko FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
          AND scope = $4 AND name = $5 AND family = $6`,
      [runId, scope.orgId, scope.projectId, key.scope, key.name, key.family],
    );
    const row = rows[0];
    if (!row?.histogram_ok || !row.histogram_ko) return null;
    return {
      ok: Histogram.deserialize(new Uint8Array(row.histogram_ok)),
      ko: Histogram.deserialize(new Uint8Array(row.histogram_ko)),
    };
  }

  /** runStartedOn is REQUIRED for the same partition-pruning reason as series(). */
  async users(scope: ProjectScope, runId: string, runStartedOn: Date): Promise<StoredUserBucket[]> {
    const { rows } = await this.pool.query(
      USER_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
      scenario: r.scenario,
      startOffsetMs: r.start_offset_ms,
      started: r.started,
      ended: r.ended,
      maxConcurrent: r.max_concurrent,
    }));
  }

  /**
   * Failures over time, run scope.
   *
   * runStartedOn is REQUIRED for the same partition-pruning reason as series():
   * it is the partition key, and a query filtering on run_id alone cannot prune
   * and scans every partition. The signature is what enforces that.
   */
  async errorSeries(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
  ): Promise<StoredErrorBucket[]> {
    const { rows } = await this.pool.query(
      ERROR_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      // The column pair collapses back to one nullable field here, so no
      // caller has to know that '' plus a boolean means "everything else".
      message: r.is_other ? null : r.message,
      count: r.count,
      bucketWidthMs: r.bucket_width_ms,
    }));
  }

  /**
   * `sel` defaults to RUN scope, never "no filter".
   *
   * The engine now emits one row per (scope, name) per message, so a single
   * failure produces both a run-scope row and a request-scope row. An unfiltered
   * query would return both and a caller summing counts would double every
   * error. Defaulting to run scope keeps the existing run-level endpoint's
   * numbers identical to what it returned before scoping existed.
   */
  async errors(
    scope: ProjectScope,
    runId: string,
    sel: { scope: string; name: string } = { scope: 'run', name: '' },
  ): Promise<{ message: string; count: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT message, count FROM run_error
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
          AND scope = $4 AND name = $5
        ORDER BY count DESC, message ASC`,
      [runId, scope.orgId, scope.projectId, sel.scope, sel.name],
    );
    return rows.map((r) => ({ message: r.message, count: r.count }));
  }
}
