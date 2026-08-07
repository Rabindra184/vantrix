import type { EngineResult } from '@perfportal/statistics';
import { SKETCH_KIND } from '@perfportal/statistics';
import type pg from 'pg';

export interface MetricContext {
  runId: string;
  orgId: string;
  projectId: string;
  /** The partition key. Must match run.started_on exactly. */
  runStartedOn: Date;
}

/** Rows per INSERT statement. Postgres caps a statement at 65535 parameters. */
const BATCH = 500;

async function insertBatched(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')}`, params);
  }
}

export class MetricWriter {
  /**
   * Writes stats, series buckets, and errors. The caller owns the transaction:
   * statistics, assertions, and the run's terminal status commit together, so a
   * run is never observable with stats but no verdict.
   *
   * Batched parameterized INSERT rather than COPY — at ~30k bucket rows that is
   * ~60 statements, and it avoids hand-rolled COPY text escaping for a
   * throughput requirement that is out of scope for this slice.
   */
  async persist(client: pg.PoolClient, ctx: MetricContext, result: EngineResult): Promise<void> {
    await insertBatched(
      client,
      'run_stat',
      [
        'id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'family',
        'count', 'ok_count', 'ko_count', 'error_rate',
        'min_ms', 'max_ms', 'mean_ms', 'stddev_ms', 'throughput_rps',
        'percentiles', 'sketch', 'sketch_kind',
      ],
      result.stats.map((s) => [
        crypto.randomUUID(),
        ctx.runId, ctx.orgId, ctx.projectId,
        s.scope, s.name, s.family,
        s.count, s.okCount, s.koCount, s.errorRate,
        s.minMs, s.maxMs, s.meanMs, s.stddevMs, s.throughputRps,
        JSON.stringify(s.percentiles),
        Buffer.from(s.sketch.serialize()),
        SKETCH_KIND,
      ]),
    );

    const bucketRows: unknown[][] = [];
    for (const entry of result.series.values()) {
      for (const b of entry.buckets) {
        bucketRows.push([
          ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scope, entry.name, b.startOffsetMs,
          b.startedCount, b.endedCount, b.okCount, b.koCount,
          b.sketch.count === 0 ? 0 : b.sketch.min,
          b.sketch.count === 0 ? 0 : b.sketch.max,
          b.sketch.count === 0 ? 0 : b.sketch.sum / b.sketch.count,
          // Only the configured percentiles are stored per bucket; per spec §9.1
          // bucket sketches are deliberately not persisted.
          JSON.stringify(percentilesOf(b.sketch, result)),
        ]);
      }
    }
    await insertBatched(
      client,
      'run_series_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'scope', 'name', 'start_offset_ms',
        'started_count', 'ended_count', 'ok_count', 'ko_count',
        'min_ms', 'max_ms', 'mean_ms', 'percentiles',
      ],
      bucketRows,
    );

    await insertBatched(
      client,
      'run_error',
      ['id', 'run_id', 'org_id', 'project_id', 'message', 'count'],
      result.errors.map((e) => [
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId, e.message, e.count,
      ]),
    );

    await insertBatched(
      client,
      'run_indicator',
      ['id', 'run_id', 'org_id', 'project_id', 'under', 'between_', 'over', 'failed'],
      [[
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId,
        result.indicators.under, result.indicators.between,
        result.indicators.over, result.indicators.failed,
      ]],
    );
  }
}

/** Percentile set is taken from any run-scope rollup, which carries the configured keys. */
function percentilesOf(
  sketch: { count: number; quantile(q: number): number },
  result: EngineResult,
): Record<string, number> {
  const keys = Object.keys(result.stats[0]?.percentiles ?? { p50: 0, p95: 0, p99: 0 });
  const out: Record<string, number> = {};
  if (sketch.count === 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  for (const k of keys) {
    const p = Number(k.slice(1));
    out[k] = sketch.quantile(p / 100);
  }
  return out;
}
