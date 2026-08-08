import { Sketch } from '@perfportal/statistics';
import type pg from 'pg';
import type { TenantScope } from '../repositories/tenant.js';

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
}

export interface StoredBucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
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
              min_ms, max_ms, mean_ms, percentiles
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND name = $6
        ORDER BY start_offset_ms`;

export class MetricReader {
  constructor(private readonly pool: pg.Pool) {}

  async stats(scope: TenantScope, runId: string): Promise<StoredStat[]> {
    const { rows } = await this.pool.query(
      `SELECT scope, name, family, count, ok_count, ko_count, error_rate,
              min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles
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
    }));
  }

  /**
   * Reads a persisted summary sketch back out of `run_stat.sketch`, for
   * evaluating an SLA metric that was not asked about at ingest time — a
   * rule added or edited after the run completed, or a request for p99.9
   * next year even though the project's stored percentile set is only
   * [50, 75, 95, 99] (spec §8.2). That later-evaluation case is the entire
   * reason sketches, not just fixed percentiles, are persisted (§9.1).
   *
   * Deliberately not on the ingest path: PipelineService evaluates SLA
   * rules against the sketch `runEngineAsync` still holds in memory, in the
   * same transaction that writes this column, so there is currently no
   * production caller of this method at ingest time. It exists for the
   * re-evaluation case above.
   */
  async sketch(scope: TenantScope, runId: string, key: StatKey): Promise<Sketch | null> {
    const { rows } = await this.pool.query<{ sketch: Buffer }>(
      `SELECT sketch FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
          AND scope = $4 AND name = $5 AND family = $6`,
      [runId, scope.orgId, scope.projectId, key.scope, key.name, key.family],
    );
    const buf = rows[0]?.sketch;
    return buf ? Sketch.deserialize(new Uint8Array(buf)) : null;
  }

  /**
   * runStartedOn is REQUIRED, not optional. It is the partition key: a query
   * filtering on run_id alone cannot prune and scans every partition. The
   * signature is what enforces that, and the "prunes partitions" integration
   * test asserts the plan of this exact query via the shared `SERIES_SQL`.
   */
  async series(
    scope: TenantScope,
    runId: string,
    runStartedOn: Date,
    sel: { scope: string; name: string },
  ): Promise<StoredBucket[]> {
    const { rows } = await this.pool.query(
      SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId, sel.scope, sel.name],
    );
    return rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      startedCount: r.started_count,
      endedCount: r.ended_count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      percentiles: r.percentiles as Record<string, number>,
    }));
  }

  async errors(scope: TenantScope, runId: string): Promise<{ message: string; count: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT message, count FROM run_error
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
        ORDER BY count DESC, message ASC`,
      [runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({ message: r.message, count: r.count }));
  }
}
