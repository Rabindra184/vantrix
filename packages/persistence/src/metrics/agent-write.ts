import type { AgentFile } from '@perfportal/plugin-gatling';
import type { AgentFigures } from '@perfportal/statistics';
import type pg from 'pg';
import { insertBatched } from './insert-batched.js';
import { partitionDay } from './partition-day.js';
import type { MetricContext } from './write.js';

/**
 * Writes a run's agent figures: one `run_agent` row and the two partitioned
 * bucket tables. The caller owns the transaction — the pipeline's finalize —
 * so a run's agent figures commit with its statistics or not at all.
 *
 * The bucket tables carry no foreign key (see the migration), so nothing but
 * this writer's caller and infra/clean-test-residue.sql ever removes them.
 */
export class AgentMetricWriter {
  async persist(client: pg.PoolClient, ctx: MetricContext, figures: AgentFigures, file: AgentFile): Promise<void> {
    await client.query(
      `INSERT INTO run_agent
         (run_id, org_id, project_id, status, reason, header, capped, agent_error,
          malformed_lines, bucket_width_ms, remotes, hostnames)
       VALUES ($1, $2, $3, 'collected', NULL, $4::jsonb, $5, $6::jsonb, $7, $8, $9::text[], $10::text[])`,
      [
        ctx.runId, ctx.orgId, ctx.projectId,
        JSON.stringify(file.header),
        file.capped,
        file.error === null ? null : JSON.stringify(file.error),
        file.malformedLines,
        figures.bucketWidthMs,
        figures.remotes,
        figures.hostnames,
      ],
    );

    // The UTC day as text, never the Date: see `partitionDay`.
    const day = partitionDay(ctx.runStartedOn);
    await insertBatched(
      client,
      'run_agent_duration_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'family', 'dim', 'start_offset_ms', 'ok_count', 'ko_count',
        'histogram_ok', 'histogram_ko',
      ],
      figures.durations.map((d) => [
        day, ctx.runId, ctx.orgId, ctx.projectId,
        d.family, d.dim, d.startOffsetMs, d.okCount, d.koCount,
        Buffer.from(d.histogramOk.serialize()),
        Buffer.from(d.histogramKo.serialize()),
      ]),
    );
    await insertBatched(
      client,
      'run_agent_metric_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'metric', 'dim', 'label', 'start_offset_ms', 'value',
      ],
      figures.metrics.map((m) => [
        day, ctx.runId, ctx.orgId, ctx.projectId,
        m.metric, m.dim, m.label, m.startOffsetMs, m.value,
      ]),
    );
  }

  /**
   * The run had an agent file and it could not be read: missing, a checksum
   * mismatch, or not a file the decoder understands. The run's own ingest is
   * untouched; this row is how a reader learns why there are no figures.
   */
  async persistUnreadable(client: pg.PoolClient, ctx: MetricContext, reason: string): Promise<void> {
    await client.query(
      `INSERT INTO run_agent (run_id, org_id, project_id, status, reason)
       VALUES ($1, $2, $3, 'unreadable', $4)`,
      [ctx.runId, ctx.orgId, ctx.projectId, reason],
    );
  }
}
