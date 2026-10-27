import type { AgentHeader } from '@perfportal/plugin-gatling';
import { Histogram, type AgentDurationFamily, type AgentMetricBucket } from '@perfportal/statistics';
import type pg from 'pg';
import type { ProjectScope } from '../repositories/tenant.js';
import { partitionDay } from './partition-day.js';

export interface AgentSummaryRow {
  status: 'collected' | 'unreadable';
  /** Why an unreadable file was not read; null when collected. */
  reason: string | null;
  header: AgentHeader | null;
  capped: boolean;
  agentError: { at: number; where: string; message: string } | null;
  malformedLines: number;
  /** The run's own series width the figures were bucketed on; null when unreadable. */
  bucketWidthMs: number | null;
  remotes: string[];
  hostnames: string[];
}

export interface StoredAgentDurationBucket {
  family: AgentDurationFamily;
  dim: string;
  startOffsetMs: number;
  okCount: number;
  koCount: number;
  histogramOk: Histogram;
  histogramKo: Histogram;
}

/**
 * Reads what `AgentMetricWriter` stored. Every query is scoped by org AND
 * project — a run id alone is never enough — and every bucket query binds the
 * partition day with `partitionDay`, so it prunes to one partition and cannot
 * land on the day before west of UTC.
 */
export class AgentReader {
  constructor(private readonly pool: pg.Pool) {}

  async summary(scope: ProjectScope, runId: string): Promise<AgentSummaryRow | null> {
    const { rows } = await this.pool.query<{
      status: 'collected' | 'unreadable';
      reason: string | null;
      header: AgentHeader | null;
      capped: boolean;
      agent_error: { at: number; where: string; message: string } | null;
      malformed_lines: number;
      bucket_width_ms: number | null;
      remotes: string[];
      hostnames: string[];
    }>(
      `SELECT status, reason, header, capped, agent_error, malformed_lines,
              bucket_width_ms, remotes, hostnames
         FROM run_agent
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3`,
      [runId, scope.orgId, scope.projectId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      status: r.status,
      reason: r.reason,
      header: r.header,
      capped: r.capped,
      agentError: r.agent_error,
      malformedLines: r.malformed_lines,
      bucketWidthMs: r.bucket_width_ms,
      remotes: r.remotes,
      hostnames: r.hostnames,
    };
  }

  async durations(
    scope: ProjectScope,
    runId: string,
    startedOn: Date,
    q: { families: AgentDurationFamily[]; dim: string },
  ): Promise<StoredAgentDurationBucket[]> {
    const { rows } = await this.pool.query<{
      family: AgentDurationFamily;
      dim: string;
      start_offset_ms: number;
      ok_count: number;
      ko_count: number;
      histogram_ok: Buffer;
      histogram_ko: Buffer;
    }>(
      `SELECT family, dim, start_offset_ms, ok_count, ko_count, histogram_ok, histogram_ko
         FROM run_agent_duration_bucket
        WHERE run_started_on = $1::date AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND family = ANY($5::text[]) AND dim = $6
        ORDER BY family, start_offset_ms`,
      [partitionDay(startedOn), runId, scope.orgId, scope.projectId, q.families, q.dim],
    );
    return rows.map((r) => ({
      family: r.family,
      dim: r.dim,
      startOffsetMs: r.start_offset_ms,
      okCount: r.ok_count,
      koCount: r.ko_count,
      histogramOk: Histogram.deserialize(r.histogram_ok),
      histogramKo: Histogram.deserialize(r.histogram_ko),
    }));
  }

  async metrics(
    scope: ProjectScope,
    runId: string,
    startedOn: Date,
    q: { metrics: string[]; dim: string },
  ): Promise<AgentMetricBucket[]> {
    const { rows } = await this.pool.query<{
      metric: string;
      dim: string;
      label: string;
      start_offset_ms: number;
      value: number;
    }>(
      `SELECT metric, dim, label, start_offset_ms, value
         FROM run_agent_metric_bucket
        WHERE run_started_on = $1::date AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND metric = ANY($5::text[]) AND dim = $6
        ORDER BY metric, label, start_offset_ms`,
      [partitionDay(startedOn), runId, scope.orgId, scope.projectId, q.metrics, q.dim],
    );
    return rows.map((r) => ({
      metric: r.metric,
      dim: r.dim,
      label: r.label,
      startOffsetMs: r.start_offset_ms,
      value: r.value,
    }));
  }
}
