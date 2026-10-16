import type pg from 'pg';

/**
 * Why a run's statistics could not be recomputed exactly. The column's CHECK
 * constraint (run_recompute_error_check) holds it to these three words.
 */
export type RecomputeError = 'raw_log_missing' | 'checksum_mismatch' | 'parse_failed';

export interface RecomputeFilter {
  orgId?: string;
  projectSlug?: string;
  runId?: string;
}

export interface VerdictChangeRecord {
  ruleSnapshot: unknown;
  oldOutcome: string;
  newOutcome: string;
  oldValue: number | null;
  newValue: number | null;
  oldVerdict: string;
  newVerdict: string;
  changedAt: Date;
}

/**
 * The ONE definition of a run that still needs recomputing. Both by label and
 * by stored format: stats_method is written at INSERT, so a run an older
 * worker parsed during a rolling deploy carries exact-v1 over legacy rows.
 * A run with no stat rows has nothing to recompute; a run marked with a
 * recompute_error is never retried.
 *
 * Reads the run as r. No backticks in here: this string is interpolated into
 * template literals, and one of those ends the string.
 */
export const CANDIDATE_PREDICATE_SQL = `
  r.status IN ('complete', 'incomplete')
  AND r.recompute_error IS NULL
  AND EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)
  AND (
    r.stats_method = 'estimated'
    OR EXISTS (
      SELECT 1 FROM run_stat s
       WHERE s.run_id = r.id
         AND (s.sketch IS NOT NULL OR s.histogram_kind IS DISTINCT FROM 'sparse-ms-v2')
    )
  )`;

/**
 * Which runs still carry estimated statistics, and the bookkeeping a
 * recompute leaves behind. Raw SQL on a pg pool, like the metric reader and
 * writer it sits beside: the candidate predicate is one string that both the
 * selection and the progress count have to read identically.
 */
export class RecomputeRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Newest first, at most `limit` ids. */
  async candidates(filter: RecomputeFilter, limit: number): Promise<string[]> {
    const where: string[] = [CANDIDATE_PREDICATE_SQL];
    const params: unknown[] = [];
    if (filter.orgId !== undefined) {
      params.push(filter.orgId);
      where.push(`r.org_id = $${params.length}::uuid`);
    }
    if (filter.runId !== undefined) {
      params.push(filter.runId);
      where.push(`r.id = $${params.length}::uuid`);
    }
    if (filter.projectSlug !== undefined) {
      params.push(filter.projectSlug);
      where.push(`r.project_id IN (SELECT p.id FROM project p WHERE p.slug = $${params.length})`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM run r WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => r.id);
  }

  /**
   * For one org's finished runs: how many carry statistics at all, how many
   * of those still need recomputing, and how many were given up on.
   */
  async progress(orgId: string): Promise<{ total: number; remaining: number; failed: number }> {
    const { rows } = await this.pool.query<{ total: string; remaining: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)) AS total,
         count(*) FILTER (WHERE ${CANDIDATE_PREDICATE_SQL}) AS remaining,
         count(*) FILTER (WHERE r.recompute_error IS NOT NULL AND r.stats_method = 'estimated') AS failed
       FROM run r WHERE r.org_id = $1::uuid AND r.status IN ('complete', 'incomplete')`,
      [orgId],
    );
    const row = rows[0]!;
    return { total: Number(row.total), remaining: Number(row.remaining), failed: Number(row.failed) };
  }

  /** Takes the run out of every later selection. */
  async markFailed(runId: string, reason: RecomputeError): Promise<void> {
    await this.pool.query(`UPDATE run SET recompute_error = $2 WHERE id = $1::uuid`, [runId, reason]);
  }

  /** In the order they were recorded. */
  async verdictChanges(runId: string): Promise<VerdictChangeRecord[]> {
    const { rows } = await this.pool.query<{
      rule_snapshot: unknown;
      old_outcome: string;
      new_outcome: string;
      old_value: number | null;
      new_value: number | null;
      old_verdict: string;
      new_verdict: string;
      changed_at: Date;
    }>(
      `SELECT rule_snapshot, old_outcome, new_outcome, old_value, new_value,
              old_verdict, new_verdict, changed_at
         FROM run_verdict_change WHERE run_id = $1::uuid ORDER BY changed_at, id`,
      [runId],
    );
    return rows.map((r) => ({
      ruleSnapshot: r.rule_snapshot,
      oldOutcome: r.old_outcome,
      newOutcome: r.new_outcome,
      oldValue: r.old_value,
      newValue: r.new_value,
      oldVerdict: r.old_verdict,
      newVerdict: r.new_verdict,
      changedAt: r.changed_at,
    }));
  }
}
