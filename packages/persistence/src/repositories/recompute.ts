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

/**
 * Where one page of candidates ended: the last row's (created_at, id), the
 * order the selection is sorted in. `created_at` is timestamptz(3), so a JS
 * Date carries it exactly and the cursor round-trips without losing a row.
 */
export interface CandidateCursor {
  createdAt: Date;
  id: string;
}

export interface CandidatePage {
  ids: string[];
  /** The cursor to pass for the next page; null when this page was the last. */
  next: CandidateCursor | null;
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
 * ═══ A RUN WHOSE STATISTICS ARE NOT ALL EXACT ═══
 *
 * Labelled estimated, or carrying a stat row in an older format (a histogram
 * kind before sparse-ms-v2, or none). By label AND by stored format, for
 * the reason the candidate predicate below gives. ONE definition, read by the
 * recompute's selection, by the verifier (which marks such a run
 * unverifiable/not_exact rather than reporting a flood of mismatches that say
 * only "estimated") and by the verify scan (which takes such a row back once
 * a recompute has made the run exact). Parenthesised, so it can be negated.
 *
 * Reads the run as r. No backticks in here: this string is interpolated into
 * template literals, and one of those ends the string.
 */
export const NOT_EXACT_RUN_SQL = `
  (
    r.stats_method = 'estimated'
    OR EXISTS (
      SELECT 1 FROM run_stat s
       WHERE s.run_id = r.id
         AND s.histogram_kind IS DISTINCT FROM 'sparse-ms-v2'
    )
  )`;

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
  AND ${NOT_EXACT_RUN_SQL}`;

/**
 * Which runs still carry estimated statistics, and the bookkeeping a
 * recompute leaves behind. Raw SQL on a pg pool, like the metric reader and
 * writer it sits beside: the candidate predicate is one string that both the
 * selection and the progress count have to read identically.
 */
export class RecomputeRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Newest first, at most `limit` ids: the first page of `candidatePage`. */
  async candidates(filter: RecomputeFilter, limit: number): Promise<string[]> {
    return (await this.candidatePage(filter, limit)).ids;
  }

  /**
   * ═══ ONE PAGE OF CANDIDATES, KEYSET-PAGED ON (created_at, id) ═══
   *
   * Newest first. `after` is the previous page's `next`; the predicate is a
   * row comparison, so two runs created in the same millisecond are ordered by
   * id and neither is skipped nor repeated. Without a cursor, a caller that
   * can only ever see the newest `limit` candidates is stuck behind them for
   * as long as they stay candidates -- a run whose recompute keeps failing
   * transiently does, and it would hide every older run for ever.
   *
   * `next` is null when the page came back short, so a caller loops until it
   * is null and has seen every candidate that existed when it started (rows
   * that become candidates mid-walk may or may not be on a later page).
   */
  async candidatePage(
    filter: RecomputeFilter,
    limit: number,
    after?: CandidateCursor,
  ): Promise<CandidatePage> {
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
    if (after !== undefined) {
      params.push(after.createdAt, after.id);
      where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `SELECT r.id, r.created_at FROM run r WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    const last = rows[rows.length - 1];
    return {
      ids: rows.map((r) => r.id),
      next: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  /**
   * For one org's finished runs: how many carry statistics at all, how many
   * of those still need recomputing, and how many were given up on.
   *
   * FAILED IS EVERY RUN WITH STATISTICS AND A recompute_error, WHATEVER ITS
   * LABEL. An errored run is never selected again, so it keeps its legacy
   * figures for good — including an exact-v1 label over legacy rows, which a
   * label-only count would drop from both remaining and failed.
   */
  async progress(orgId: string): Promise<{ total: number; remaining: number; failed: number }> {
    const { rows } = await this.pool.query<{ total: string; remaining: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)) AS total,
         count(*) FILTER (WHERE ${CANDIDATE_PREDICATE_SQL}) AS remaining,
         count(*) FILTER (
           WHERE r.recompute_error IS NOT NULL
             AND EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)
         ) AS failed
       FROM run r WHERE r.org_id = $1::uuid AND r.status IN ('complete', 'incomplete')`,
      [orgId],
    );
    const row = rows[0]!;
    return { total: Number(row.total), remaining: Number(row.remaining), failed: Number(row.failed) };
  }

  /**
   * Takes the run out of every later selection, and labels it estimated in the
   * same statement. A run never recomputed keeps its legacy figures for good,
   * so its label has to say so — an exact-labelled run selected by its legacy
   * rows would otherwise go on reading as exact, with no ≈ anywhere.
   */
  async markFailed(runId: string, reason: RecomputeError): Promise<void> {
    await this.pool.query(
      `UPDATE run SET recompute_error = $2, stats_method = 'estimated' WHERE id = $1::uuid`,
      [runId, reason],
    );
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
