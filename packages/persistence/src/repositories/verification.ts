import type pg from 'pg';
import { CANDIDATE_PREDICATE_SQL, NOT_EXACT_RUN_SQL, type CandidateCursor, type CandidatePage } from './recompute.js';

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
  table:
    | 'run_stat'
    | 'run_series_bucket'
    | 'run_error'
    | 'run_error_bucket'
    | 'run_user_bucket'
    | 'run'
    | 'run_agent_duration_bucket'
    | 'run_agent_metric_bucket';
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
  /**
   * Where Gatling's own report would differ from the exact figures —
   * packages/verify's GatlingDifference rows, which persistence cannot name.
   * Empty when nothing differed OR the method did not run: gatlingReplays
   * says which.
   */
  gatlingDifferences: unknown[];
  /** How many seeded replays of Gatling's method found them; null when it did not run. */
  gatlingReplays: number | null;
  unverifiableReason: UnverifiableReason | null;
  rawLogRetainedUntil: Date | null;
}

export interface VerificationResult {
  status: 'verified' | 'mismatch';
  verifierVersion: number;
  figuresChecked: number;
  mismatches: FigureMismatch[];
  rawLogRetainedUntil: Date | null;
  /**
   * REQUIRED, with no default: a check that did not run Gatling's method says
   * so ([] and null). A default would let a caller that DID run it drop the
   * list in silence, and the run would read as agreeing with Gatling.
   */
  gatlingDifferences: unknown[];
  gatlingReplays: number | null;
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
  gatling_replays: number | null;
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
 * ═══ THE ONE DEFINITION OF A RUN THE VERIFIER STILL HAS TO CHECK ═══
 *
 * A verifiable run whose raw log is still stored, and whose verification row
 * is missing, pending, recorded by no version or by a version older than
 * `version` (a placeholder such as $1: the caller passes VERIFIER_VERSION,
 * which persistence cannot import), or — the stale case — marked
 * unverifiable/not_exact while its statistics are now exact. That last one is
 * a run a recompute made exact AFTER the verifier had refused it: nothing else
 * reliably asks for it again (verification may have been switched off while
 * the backfill ran, or the request after the recompute may have been lost),
 * and without this clause it would read "estimates" for good.
 *
 * Read by the scan (candidatePage) AND by retention (retentionDue), which
 * must never delete a log the scan is still going to read. The absent-row arm
 * stays scoped by VERIFIABLE_RUN_SQL: a failed run, or one with no
 * statistics, never gets a row, and must not look like a run waiting for one.
 *
 * Reads the run as r and its verification row as v (LEFT JOINed).
 * Parenthesised, so it can be negated. No backticks in here.
 */
export function verifyCandidateSql(version: string): string {
  return `
  (
    (${VERIFIABLE_RUN_SQL})
    AND r.raw_log_deleted_at IS NULL
    AND (
      v.run_id IS NULL
      OR v.status = 'pending'
      OR v.verifier_version IS NULL
      OR v.verifier_version < ${version}
      OR (v.status = 'unverifiable' AND v.unverifiable_reason = 'not_exact' AND NOT ${NOT_EXACT_RUN_SQL})
    )
  )`;
}

/**
 * ═══ A RAW LOG RETENTION MAY DELETE ═══
 *
 * Past retention (ingested more than `days` ago — ingested_at is the
 * retention clock: every terminal writer stamps it), still stored, carrying an
 * assembled bundle (a live run that never assembled one has the '' sentinel
 * and no object to delete) or an agent file, and needed by nothing.
 *
 * THE AGENT-FILE ARM. The on-prem runner stores a run's agent file before it
 * closes the run, so a run that then ends incomplete with no assembled log
 * ('' sentinel) still carries one. Without this arm nothing would ever delete
 * it: retention skipped the run and the orphan sweep keeps every key
 * agent_log_key names. Such a run has no statistics, so the three exclusions
 * below cannot hold it back for a reason that matters, and deleting its
 * bundle key is harmless (absent, or a chunk assembly no whole record
 * survived). A '' run with no agent file is still not selected. Needed by
 * nothing means:
 *
 *  - not a verify candidate (verifyCandidateSql): a log is deleted only once
 *    the run has been checked against it, or once it never can be;
 *  - not a recompute candidate (CANDIDATE_PREDICATE_SQL): an estimated run's
 *    log is what its exact statistics will be computed from. A run the
 *    recompute retired (recompute_error) is no candidate, and its log goes;
 *  - not a mismatch: a mismatched run's log is the evidence for the defect,
 *    and a fixed verifier, or a recompute, needs it.
 *
 * A failed run, or one with no statistics, is none of those and is deletable.
 * `days` and `version` are placeholders. Reads r and v (LEFT JOINed).
 * No backticks in here.
 */
function retentionDueSql(days: string, version: string): string {
  return `
  r.ingested_at IS NOT NULL
  AND r.ingested_at < now() - make_interval(days => ${days}::int)
  AND r.raw_log_deleted_at IS NULL
  AND (r.bundle_sha256 <> '' OR r.agent_log_key IS NOT NULL)
  AND NOT ${verifyCandidateSql(version)}
  AND NOT (${CANDIDATE_PREDICATE_SQL})
  AND v.status IS DISTINCT FROM 'mismatch'`;
}

/**
 * Where one page of retention-due runs ended: the last row's
 * (ingested_at, id). timestamptz(3), so a JS Date carries it exactly.
 */
export interface RetentionCursor {
  ingestedAt: Date;
  id: string;
}

export interface RetentionPage {
  /**
   * `agentLogKey` is the run's agent file (`runs/<runId>/agent.ndjson`), or
   * null for a run without one: retention deletes it with the raw log.
   */
  runs: { id: string; bundleKey: string; agentLogKey: string | null }[];
  /** The cursor for the next page; null when this page was the last. */
  next: RetentionCursor | null;
}

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
         gatling_differences, gatling_replays, unverifiable_reason,
         raw_log_retained_until::text AS raw_log_retained_until
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
   *
   * ═══ A RUN WHOSE RAW LOG IS GONE IS NEVER LEFT PENDING ═══
   *
   * candidatePage never selects it again, so a pending row there would sit in
   * the summary's pending count for ever. Instead it is settled the way
   * markRawLogDeleted settles it: a verifiable run with no row, or with a
   * pending one, becomes unverifiable/raw_log_deleted; a verified, mismatched
   * or already-unverifiable row is left alone, because its outcome was decided
   * while the log still existed and nothing can re-check it now. A deleted-log
   * run that was never verifiable gets no row at all, as in markRawLogDeleted.
   */
  async markPending(runId: string): Promise<void> {
    await this.pool.query(
      `WITH target AS (
         SELECT r.id, r.raw_log_deleted_at IS NOT NULL AS gone, (${VERIFIABLE_RUN_SQL}) AS verifiable
           FROM run r WHERE r.id = $1::uuid
       )
       INSERT INTO run_verification (run_id, status, checked_at, unverifiable_reason)
       SELECT id,
              CASE WHEN gone THEN 'unverifiable' ELSE 'pending' END,
              CASE WHEN gone THEN now() END,
              CASE WHEN gone THEN 'raw_log_deleted' END
         FROM target WHERE NOT gone OR verifiable
       ON CONFLICT (run_id) DO UPDATE SET
         status = EXCLUDED.status, checked_at = EXCLUDED.checked_at, verifier_version = NULL,
         figures_checked = 0, mismatches = '[]'::jsonb, gatling_differences = '[]'::jsonb,
         gatling_replays = NULL, unverifiable_reason = EXCLUDED.unverifiable_reason
        WHERE EXCLUDED.status = 'pending' OR run_verification.status = 'pending'`,
      [runId],
    );
  }

  /**
   * ═══ THE SCAN'S PENDING ROW: ADDED WHERE THERE IS NONE, NEVER OVER AN ANSWER ═══
   *
   * A run the scan selects with no verification row gets a pending one, so
   * the summary counts it from the moment it is queued. A run that HAS a row
   * keeps it, whatever it says, until its job records the new answer: what
   * makes the scan select a decided run is a newer VERIFIER_VERSION, and a
   * newer verifier is no reason to forget what the older one found. Resetting
   * here, as markPending does, turned every verified and mismatched run back
   * to "Verifying…" (its mismatch evidence included) on the deploy that bumped
   * the version, for as long as the backlog took to drain one run at a time.
   *
   * markPending stays the answer for a re-ingest or a recompute: there the
   * stored figures have changed, and the old answer really is about rows that
   * no longer exist. No gone branch: the scan selects only runs whose raw log
   * is still stored, and retention never deletes a candidate's.
   */
  async ensurePending(runId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification (run_id, status)
       SELECT r.id, 'pending' FROM run r WHERE r.id = $1::uuid
       ON CONFLICT (run_id) DO NOTHING`,
      [runId],
    );
  }

  /**
   * Whether the run is one markPending may be called for: finished, with
   * statistics to check. The same definition candidatePage selects by, so a
   * caller that queues a run outside the scan (the pipeline, a recompute) can
   * never leave a pending row no verification will ever settle — a failed run
   * has no figures, and its verify job would answer not_eligible for ever.
   */
  async isVerifiable(runId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT (${VERIFIABLE_RUN_SQL}) AS ok FROM run r WHERE r.id = $1::uuid`,
      [runId],
    );
    return rows[0]?.ok === true;
  }

  /**
   * A finished check: its outcome, and — both at once — the Gatling
   * differences and the replay count that found them, replacing whatever the
   * previous check left.
   */
  async record(runId: string, r: VerificationResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification
         (run_id, status, checked_at, verifier_version, figures_checked, mismatches,
          unverifiable_reason, raw_log_retained_until, gatling_differences, gatling_replays)
       VALUES ($1::uuid, $2, now(), $3, $4, $5::jsonb, NULL, $6::date, $7::jsonb, $8)
       ON CONFLICT (run_id) DO UPDATE SET
         status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
         verifier_version = EXCLUDED.verifier_version, figures_checked = EXCLUDED.figures_checked,
         mismatches = EXCLUDED.mismatches, unverifiable_reason = NULL,
         gatling_differences = EXCLUDED.gatling_differences, gatling_replays = EXCLUDED.gatling_replays,
         raw_log_retained_until = EXCLUDED.raw_log_retained_until`,
      [
        runId,
        r.status,
        r.verifierVersion,
        r.figuresChecked,
        JSON.stringify(r.mismatches),
        dayText(r.rawLogRetainedUntil),
        JSON.stringify(r.gatlingDifferences),
        r.gatlingReplays,
      ],
    );
  }

  async markUnverifiable(runId: string, reason: UnverifiableReason, verifierVersion: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_verification (run_id, status, checked_at, verifier_version, unverifiable_reason)
       VALUES ($1::uuid, 'unverifiable', now(), $3, $2)
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'unverifiable', checked_at = now(), verifier_version = EXCLUDED.verifier_version,
         figures_checked = 0, mismatches = '[]'::jsonb, gatling_differences = '[]'::jsonb,
         gatling_replays = NULL, unverifiable_reason = EXCLUDED.unverifiable_reason`,
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
      gatlingReplays: row.gatling_replays,
      unverifiableReason: row.unverifiable_reason as UnverifiableReason | null,
      rawLogRetainedUntil: utcDay(row.raw_log_retained_until),
    };
  }

  /**
   * ═══ ONE PAGE OF RUNS TO VERIFY, KEYSET-PAGED ON (created_at, id) ═══
   *
   * verifyCandidateSql's runs: a verifiable run whose row is missing,
   * pending, recorded by a verifier older than `version`, or a stale
   * not_exact on a run since made exact. Newest first, ties broken by id — the shape
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
    const where = [verifyCandidateSql('$1')];
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
   * ═══ ONE PAGE OF RUNS WHOSE RAW LOG RETENTION MAY DELETE ═══
   *
   * retentionDueSql's runs, oldest first, keyset-paged on (ingested_at, id):
   * a run whose delete keeps failing does not hold every run behind it, the
   * sweeper walks on past it to the next page. `days` of 0 (or less) keeps
   * raw logs for ever. `version` is the verifier's current version, which
   * decides whether a run still has to be checked against its log.
   */
  async retentionDue(
    days: number,
    version: number,
    after: RetentionCursor | null,
    limit: number,
  ): Promise<RetentionPage> {
    if (!(days > 0)) return { runs: [], next: null };
    const params: unknown[] = [days, version];
    const where = [retentionDueSql('$1', '$2')];
    if (after !== null) {
      params.push(after.ingestedAt, after.id);
      where.push(`(r.ingested_at, r.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<{
      id: string;
      bundle_key: string;
      agent_log_key: string | null;
      ingested_at: Date;
    }>(
      `SELECT r.id, r.bundle_key, r.agent_log_key, r.ingested_at
         FROM run r LEFT JOIN run_verification v ON v.run_id = r.id
        WHERE ${where.join(' AND ')}
        ORDER BY r.ingested_at, r.id
        LIMIT $${params.length}`,
      params,
    );
    const last = rows[rows.length - 1];
    return {
      runs: rows.map((r) => ({ id: r.id, bundleKey: r.bundle_key, agentLogKey: r.agent_log_key })),
      next: rows.length === limit && last ? { ingestedAt: last.ingested_at, id: last.id } : null,
    };
  }

  /**
   * Whether ONE run is still due, by the same definition retentionDue pages
   * by. The sweeper asks it again once it holds the run's lock: a page is read
   * before any lock is taken, and in between the run may have become a verify
   * candidate (a re-ingest or recompute marked it pending, or the scan first
   * gave it a row) — deleting it then would leave a run the verifier was about
   * to check settled as unverifiable/raw_log_deleted instead.
   */
  async isRetentionDue(runId: string, days: number, version: number): Promise<boolean> {
    if (!(days > 0)) return false;
    const { rows } = await this.pool.query<{ due: boolean }>(
      `SELECT (${retentionDueSql('$2', '$3')}) AS due
         FROM run r LEFT JOIN run_verification v ON v.run_id = r.id
        WHERE r.id = $1::uuid`,
      [runId, days, version],
    );
    return rows[0]?.due === true;
  }

  /**
   * Stamps the run's raw log as deleted, and — in the same statement — a run
   * that was never verified (no row, or a pending one) becomes unverifiable
   * for that reason. A run already checked keeps its outcome: whether its
   * figures agreed with the raw log was settled while the log existed.
   *
   * Only a VERIFIABLE run gets a row. retentionDue selects a failed run, or
   * one with no statistics, as readily as a verified one; giving those an
   * unverifiable row would count runs in the summary, and list them as
   * problems, that never had figures to verify. The stamp itself is
   * unconditional: the log is gone whatever the run was.
   */
  async markRawLogDeleted(runId: string): Promise<void> {
    await this.pool.query(
      `WITH stamped AS (
         UPDATE run SET raw_log_deleted_at = COALESCE(raw_log_deleted_at, now())
          WHERE id = $1::uuid
         RETURNING id
       )
       INSERT INTO run_verification (run_id, status, checked_at, unverifiable_reason)
       SELECT r.id, 'unverifiable', now(), 'raw_log_deleted'
         FROM stamped JOIN run r ON r.id = stamped.id
        WHERE ${VERIFIABLE_RUN_SQL}
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'unverifiable', checked_at = now(), unverifiable_reason = 'raw_log_deleted',
         figures_checked = 0, mismatches = '[]'::jsonb, gatling_differences = '[]'::jsonb,
         gatling_replays = NULL
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
