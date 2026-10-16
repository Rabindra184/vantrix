import type pg from 'pg';
import type { CandidateCursor, CandidatePage } from './recompute.js';

/** Held to these four words by run_verification_status_check. */
export type VerificationStatus = 'pending' | 'verified' | 'mismatch' | 'unverifiable';

/** Held to these four words by run_verification_reason_check. */
export type UnverifiableReason = 'raw_log_deleted' | 'raw_log_missing' | 'raw_log_unreadable' | 'not_exact';

/** One stored figure the verifier re-derived from the raw log and got a different answer for. */
export interface FigureMismatch {
  scope: string;
  name: string;
  family: string;
  /** null for a figure that is not a latency (a count, a run column). */
  population: 'all' | 'ok' | 'ko' | null;
  /** start_offset_ms; null for a run_stat or run_error figure. */
  bucket: number | null;
  table: 'run_stat' | 'run_series_bucket' | 'run_error' | 'run_error_bucket' | 'run_user_bucket' | 'run';
  /** e.g. 'count', 'p95', 'ok_count'; 'row' when a whole row is missing or extra. */
  figure: string;
  stored: number | string | null;
  recomputed: number | string | null;
}

export interface VerificationRecord {
  runId: string;
  status: VerificationStatus;
  checkedAt: Date | null;
  verifierVersion: number | null;
  figuresChecked: number;
  mismatches: FigureMismatch[];
  gatlingDifferences: unknown[];
  unverifiableReason: UnverifiableReason | null;
  rawLogRetainedUntil: Date | null;
}

export interface VerificationResult {
  status: 'verified' | 'mismatch';
  verifierVersion: number;
  figuresChecked: number;
  mismatches: FigureMismatch[];
  rawLogRetainedUntil: Date | null;
}

export interface VerificationSummary {
  verified: number;
  mismatch: number;
  unverifiable: number;
  pending: number;
}

export interface VerificationProblem {
  runId: string;
  projectSlug: string;
  status: 'mismatch' | 'unverifiable';
  reason: UnverifiableReason | null;
  mismatchCount: number;
  checkedAt: Date | null;
}

interface VerificationRow {
  run_id: string;
  status: string;
  checked_at: Date | null;
  verifier_version: number | null;
  figures_checked: number;
  mismatches: unknown;
  gatling_differences: unknown;
  unverifiable_reason: string | null;
  raw_log_retained_until: string | null;
}

/**
 * A finished run that has statistics to verify. The same two conditions the
 * recompute's predicate opens with: a failed or unfinished run has no stored
 * figures to check, and neither does a run with no run_stat row.
 *
 * Reads the run as r. No backticks in here: it is interpolated into template
 * literals, and one of those ends the string.
 */
const VERIFIABLE_RUN_SQL = `
  r.status IN ('complete', 'incomplete')
  AND EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)`;

/**
 * `raw_log_retained_until` is a date column, and node-postgres would parse it
 * as LOCAL midnight. Its type parser is global, so the column is selected as
 * text and read here as the UTC day it is.
 */
function utcDay(text: string | null): Date | null {
  return text === null ? null : new Date(`${text}T00:00:00.000Z`);
}

/** The UTC calendar day of a Date, as the text a date column takes. */
function dayText(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, 10);
}

function jsonArray<T>(value: unknown): T[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

const SELECT_ROW = `
  SELECT run_id, status, checked_at, verifier_version, figures_checked, mismatches,
         gatling_differences, unverifiable_reason, raw_log_retained_until::text AS raw_log_retained_until
    FROM run_verification`;

/**
 * One verification per run, and the raw-log retention that decides whether a
 * run can still be verified. Raw SQL on a pg pool, like RecomputeRepository
 * beside it: the candidate selection and the per-org counts have to read one
 * definition of a verifiable run.
 */
export class VerificationRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Upsert: a run (re)queued for verification. Everything the last check
   * recorded is cleared, except how long its raw log is retained — that is a
   * fact about the stored object, not about the check.
   */
  async markPending(runId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification (run_id, status) VALUES ($1::uuid, 'pending')
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'pending', checked_at = NULL, verifier_version = NULL,
         figures_checked = 0, mismatches = '[]'::jsonb, gatling_differences = '[]'::jsonb,
         unverifiable_reason = NULL`,
      [runId],
    );
  }

  async record(runId: string, r: VerificationResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification
         (run_id, status, checked_at, verifier_version, figures_checked, mismatches,
          unverifiable_reason, raw_log_retained_until)
       VALUES ($1::uuid, $2, now(), $3, $4, $5::jsonb, NULL, $6::date)
       ON CONFLICT (run_id) DO UPDATE SET
         status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
         verifier_version = EXCLUDED.verifier_version, figures_checked = EXCLUDED.figures_checked,
         mismatches = EXCLUDED.mismatches, unverifiable_reason = NULL,
         raw_log_retained_until = EXCLUDED.raw_log_retained_until`,
      [
        runId,
        r.status,
        r.verifierVersion,
        r.figuresChecked,
        JSON.stringify(r.mismatches),
        dayText(r.rawLogRetainedUntil),
      ],
    );
  }

  async markUnverifiable(runId: string, reason: UnverifiableReason, verifierVersion: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification (run_id, status, checked_at, verifier_version, unverifiable_reason)
       VALUES ($1::uuid, 'unverifiable', now(), $3, $2)
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'unverifiable', checked_at = now(), verifier_version = EXCLUDED.verifier_version,
         figures_checked = 0, mismatches = '[]'::jsonb, unverifiable_reason = EXCLUDED.unverifiable_reason`,
      [runId, reason, verifierVersion],
    );
  }

  async find(runId: string): Promise<VerificationRecord | null> {
    const { rows } = await this.pool.query<VerificationRow>(`${SELECT_ROW} WHERE run_id = $1::uuid`, [runId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId: row.run_id,
      // Narrowed by the two CHECK constraints, not guessed.
      status: row.status as VerificationStatus,
      checkedAt: row.checked_at,
      verifierVersion: row.verifier_version,
      figuresChecked: row.figures_checked,
      mismatches: jsonArray<FigureMismatch>(row.mismatches),
      gatlingDifferences: jsonArray<unknown>(row.gatling_differences),
      unverifiableReason: row.unverifiable_reason as UnverifiableReason | null,
      rawLogRetainedUntil: utcDay(row.raw_log_retained_until),
    };
  }

  /**
   * ═══ ONE PAGE OF RUNS TO VERIFY, KEYSET-PAGED ON (created_at, id) ═══
   *
   * A verifiable run whose row is missing, pending, or recorded by a verifier
   * older than `version`. Newest first, ties broken by id — the shape
   * RecomputeRepository.candidatePage argues for, so a run created in the
   * same millisecond as the cursor is neither skipped nor repeated.
   *
   * A run whose raw log has been deleted is never selected: there is nothing
   * left to verify it against, and markRawLogDeleted already settled its row
   * (a never-verified run becomes unverifiable; a verified one keeps what it
   * was found to be, rather than being re-checked into unverifiable).
   */
  async candidatePage(
    version: number,
    after: CandidateCursor | null,
    limit: number,
  ): Promise<CandidatePage> {
    const params: unknown[] = [version];
    const where = [
      VERIFIABLE_RUN_SQL,
      'r.raw_log_deleted_at IS NULL',
      `(v.run_id IS NULL OR v.status = 'pending' OR v.verifier_version IS NULL OR v.verifier_version < $1)`,
    ];
    if (after !== null) {
      params.push(after.createdAt, after.id);
      where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `SELECT r.id, r.created_at
         FROM run r LEFT JOIN run_verification v ON v.run_id = r.id
        WHERE ${where.join(' AND ')}
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
   * Runs whose raw log is past retention and still stored: ingested more than
   * `days` days ago, carrying an assembled bundle (a live run that never
   * assembled one has the '' sentinel and no object to delete), and not yet
   * deleted. Oldest first. `days` of 0 (or less) keeps raw logs for ever.
   *
   * ingested_at is the retention clock: every terminal writer stamps it.
   */
  async retentionDue(days: number, limit: number): Promise<{ id: string; bundleKey: string }[]> {
    if (!(days > 0)) return [];
    const { rows } = await this.pool.query<{ id: string; bundle_key: string }>(
      `SELECT id, bundle_key FROM run
        WHERE ingested_at IS NOT NULL
          AND ingested_at < now() - make_interval(days => $1::int)
          AND raw_log_deleted_at IS NULL
          AND bundle_sha256 <> ''
        ORDER BY ingested_at, id
        LIMIT $2`,
      [days, limit],
    );
    return rows.map((r) => ({ id: r.id, bundleKey: r.bundle_key }));
  }

  /**
   * Stamps the run's raw log as deleted, and — in the same statement — a run
   * that was never verified (no row, or a pending one) becomes unverifiable
   * for that reason. A run already checked keeps its outcome: whether its
   * figures agreed with the raw log was settled while the log existed.
   */
  async markRawLogDeleted(runId: string): Promise<void> {
    await this.pool.query(
      `WITH stamped AS (
         UPDATE run SET raw_log_deleted_at = COALESCE(raw_log_deleted_at, now())
          WHERE id = $1::uuid
         RETURNING id
       )
       INSERT INTO run_verification (run_id, status, checked_at, unverifiable_reason)
       SELECT id, 'unverifiable', now(), 'raw_log_deleted' FROM stamped
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'unverifiable', checked_at = now(), unverifiable_reason = 'raw_log_deleted',
         figures_checked = 0, mismatches = '[]'::jsonb
        WHERE run_verification.status = 'pending'`,
      [runId],
    );
  }

  /**
   * One org's runs by verification status. A verifiable run with no row yet
   * counts as pending — it is waiting just the same — and a run with a row is
   * counted whatever its state now.
   */
  async summary(orgId: string): Promise<VerificationSummary> {
    const { rows } = await this.pool.query<{ status: string; n: string }>(
      `SELECT COALESCE(v.status, 'pending') AS status, count(*) AS n
         FROM run r LEFT JOIN run_verification v ON v.run_id = r.id
        WHERE r.org_id = $1::uuid
          AND (v.run_id IS NOT NULL OR (${VERIFIABLE_RUN_SQL}))
        GROUP BY 1`,
      [orgId],
    );
    const out: VerificationSummary = { verified: 0, mismatch: 0, unverifiable: 0, pending: 0 };
    for (const row of rows) {
      if (row.status in out) out[row.status as keyof VerificationSummary] = Number(row.n);
    }
    return out;
  }

  /** One org's mismatched and unverifiable runs, most recently checked first. */
  async problems(orgId: string, limit: number): Promise<VerificationProblem[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      slug: string;
      status: string;
      unverifiable_reason: string | null;
      mismatch_count: number;
      checked_at: Date | null;
    }>(
      `SELECT v.run_id, p.slug, v.status, v.unverifiable_reason,
              jsonb_array_length(v.mismatches) AS mismatch_count, v.checked_at
         FROM run_verification v
         JOIN run r ON r.id = v.run_id
         JOIN project p ON p.id = r.project_id
        WHERE r.org_id = $1::uuid AND v.status IN ('mismatch', 'unverifiable')
        ORDER BY v.checked_at DESC NULLS LAST, v.run_id
        LIMIT $2`,
      [orgId, limit],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      projectSlug: r.slug,
      status: r.status as 'mismatch' | 'unverifiable',
      reason: r.unverifiable_reason as UnverifiableReason | null,
      mismatchCount: Number(r.mismatch_count),
      checkedAt: r.checked_at,
    }));
  }
}
