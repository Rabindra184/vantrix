import type { EngineResult } from '@perfportal/statistics';
import { HISTOGRAM_KIND, bucketLatency } from '@perfportal/statistics';
import type pg from 'pg';
import { insertBatched } from './insert-batched.js';
import { partitionDay } from './partition-day.js';

export interface MetricContext {
  runId: string;
  orgId: string;
  projectId: string;
  /** The partition key, as UTC midnight of run.started_on (bound as `partitionDay`). */
  runStartedOn: Date;
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
    // The UTC day as text, never the Date: see `partitionDay` for the day a
    // host west of UTC lost.
    const day = partitionDay(ctx.runStartedOn);
    await insertBatched(
      client,
      'run_stat',
      [
        'id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'family',
        'count', 'ok_count', 'ko_count', 'error_rate',
        'min_ms', 'max_ms', 'mean_ms', 'stddev_ms', 'throughput_rps',
        'percentiles',
        'histogram_ok', 'histogram_ko', 'histogram_kind',
      ],
      result.stats.map((s) => [
        crypto.randomUUID(),
        ctx.runId, ctx.orgId, ctx.projectId,
        s.scope, s.name, s.family,
        s.count, s.okCount, s.koCount, s.errorRate,
        s.minMs, s.maxMs, s.meanMs, s.stddevMs, s.throughputRps,
        JSON.stringify(s.percentiles),
        // The two exact histograms are what every stored percentile is
        // recomputed from (storedPercentiles in @perfportal/statistics).
        Buffer.from(s.histogramOk.serialize()),
        Buffer.from(s.histogramKo.serialize()),
        HISTOGRAM_KIND,
      ]),
    );

    const bucketRows: unknown[][] = [];
    for (const entry of result.series.values()) {
      for (const b of entry.buckets) {
        // The one derivation, shared with the live publisher — see
        // bucketLatency's own doc comment for why it is not inlined here.
        // A bucket's exact histograms are persisted below.
        const lat = bucketLatency(b);
        bucketRows.push([
          day, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scope, entry.name, entry.family,
          b.startOffsetMs,
          b.startedCount, b.endedCount, b.okCount, b.koCount,
          b.startedOkCount, b.startedKoCount,
          lat.minMs,
          lat.maxMs,
          lat.meanMs,
          JSON.stringify(lat.percentiles),
          JSON.stringify(lat.percentilesOk),
          JSON.stringify(lat.percentilesKo),
          // Beside the frozen percentiles above, not instead of them: those
          // answer the chart's fixed bands cheaply, these are what a sub-range
          // is re-aggregated from.
          Buffer.from(b.histogramOk.serialize()),
          Buffer.from(b.histogramKo.serialize()),
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
        'histogram_ok', 'histogram_ko',
      ],
      bucketRows,
    );

    const userRows: unknown[][] = [];
    for (const entry of result.users) {
      for (const b of entry.buckets) {
        userRows.push([
          day, ctx.runId, ctx.orgId, ctx.projectId,
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
      ['id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'message', 'is_other', 'count'],
      result.errors.map((e) => [
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId,
        e.scope, e.name,
        // Same split as run_error_bucket: the remainder is carried by the
        // column pair, never by a message value a real error could also have.
        e.message ?? '', e.message === null,
        e.count,
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
        day, ctx.runId, ctx.orgId, ctx.projectId,
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

  /**
   * Every metric and assertion row of one run, for a recompute that rewrites
   * them in the same transaction. The partitioned tables are addressed by
   * (run_started_on, run_id) — their primary keys' prefix — so each DELETE
   * prunes to one partition. The six metric tables carry no foreign key to
   * run, so nothing else removes these rows.
   *
   * `runStartedOn` is bound as the same UTC day `persist` binds
   * (`partitionDay`), never as the Date itself: node-postgres renders a Date
   * in the process's local zone, and west of UTC that is the day before — the
   * DELETE then missed the rows on the right day.
   */
  async deleteForRun(client: pg.PoolClient, ctx: { runId: string; runStartedOn: Date }): Promise<void> {
    const day = partitionDay(ctx.runStartedOn);
    for (const table of ['run_series_bucket', 'run_user_bucket', 'run_error_bucket']) {
      await client.query(`DELETE FROM "${table}" WHERE run_started_on = $2::date AND run_id = $1`, [
        ctx.runId,
        day,
      ]);
    }
    for (const table of ['run_stat', 'run_error', 'run_assertion']) {
      await client.query(`DELETE FROM "${table}" WHERE run_id = $1`, [ctx.runId]);
    }
  }
}
