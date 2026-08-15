import type { EngineResult } from '@perfportal/statistics';
import { BUCKET_PERCENTILES, HISTOGRAM_KIND, SKETCH_KIND } from '@perfportal/statistics';
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
        'histogram_ok', 'histogram_ko', 'histogram_kind',
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
        Buffer.from(s.histogramOk.serialize()),
        Buffer.from(s.histogramKo.serialize()),
        HISTOGRAM_KIND,
      ]),
    );

    const bucketRows: unknown[][] = [];
    for (const entry of result.series.values()) {
      for (const b of entry.buckets) {
        bucketRows.push([
          ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scope, entry.name, entry.family,
          b.startOffsetMs,
          b.startedCount, b.endedCount, b.okCount, b.koCount,
          b.startedOkCount, b.startedKoCount,
          b.sketch.count === 0 ? 0 : b.sketch.min,
          b.sketch.count === 0 ? 0 : b.sketch.max,
          b.sketch.count === 0 ? 0 : b.sketch.sum / b.sketch.count,
          // Only the configured percentiles are stored per bucket; per spec §9.1
          // bucket sketches are deliberately not persisted.
          JSON.stringify(percentilesOf(b.sketch)),
          JSON.stringify(percentilesOf(b.sketchOk)),
          JSON.stringify(percentilesOf(b.sketchKo)),
        ]);
      }
    }
    await insertBatched(
      client,
      'run_series_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'scope', 'name', 'family', 'start_offset_ms',
        'started_count', 'ended_count', 'ok_count', 'ko_count',
        'started_ok_count', 'started_ko_count',
        'min_ms', 'max_ms', 'mean_ms', 'percentiles', 'percentiles_ok', 'percentiles_ko',
      ],
      bucketRows,
    );

    const userRows: unknown[][] = [];
    for (const entry of result.users) {
      for (const b of entry.buckets) {
        userRows.push([
          ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scenario, b.startOffsetMs, b.started, b.ended, b.maxConcurrent,
        ]);
      }
    }
    await insertBatched(
      client,
      'run_user_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'scenario', 'start_offset_ms', 'started', 'ended', 'max_concurrent',
      ],
      userRows,
    );

    await insertBatched(
      client,
      'run_error',
      ['id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'message', 'count'],
      result.errors.map((e) => [
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId,
        e.scope, e.name, e.message, e.count,
      ]),
    );

    await insertBatched(
      client,
      'run_error_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'start_offset_ms', 'message', 'is_other', 'count', 'bucket_width_ms',
      ],
      result.errorSeries.rows.map((r) => [
        ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
        r.startOffsetMs,
        // The folded remainder is carried by the COLUMN PAIR, not by a message
        // value a real error could also have. `('other', false)` and
        // `('', true)` are distinct primary keys; two rows both messaged
        // 'other' would not be.
        r.message ?? '', r.message === null,
        r.count,
        // Constant per run, repeated per row. See the migration for why it is
        // stored at all rather than inferred from the offsets.
        result.errorSeries.bucketWidthMs,
      ]),
    );
  }
}

/**
 * The per-bucket percentile bands are a FIXED set (BUCKET_PERCENTILES), not the
 * project's configured columns. A bucket stores numbers and no sketch, so a
 * configurable set would freeze whatever the project happened to be configured
 * as on ingest day. Reading the keys off result.stats[0] - the previous
 * behaviour - did exactly that.
 *
 * An empty sketch returns {}, not a band of zeros. A p95 of 0 is a fabricated
 * observation for a bucket that made none - and it is exactly what let the
 * scatter gate on a response count instead of on whether the status-filtered
 * digest exists, matching Gatling's own gate
 * (LogFileData.timeAgainstGlobalNumberOfRequestsPerSec: presence of a digest,
 * not a response count).
 */
function percentilesOf(sketch: { count: number; quantile(q: number): number }): Record<string, number> {
  if (sketch.count === 0) return {};
  const out: Record<string, number> = {};
  for (const p of BUCKET_PERCENTILES) out[`p${p}`] = sketch.quantile(p / 100);
  return out;
}
