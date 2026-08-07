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
   * The stored summary sketch. This is what lets an SLA rule ask for p99.9 when
   * the project's stored percentile set is [50, 75, 95, 99] (spec §8.2).
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
   * signature is what enforces that, and a test asserts the plan.
   */
  async series(
    scope: TenantScope,
    runId: string,
    runStartedOn: Date,
    sel: { scope: string; name: string },
  ): Promise<StoredBucket[]> {
    const { rows } = await this.pool.query(
      `SELECT start_offset_ms, started_count, ended_count, ok_count, ko_count,
              min_ms, max_ms, mean_ms, percentiles
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND name = $6
        ORDER BY start_offset_ms`,
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
