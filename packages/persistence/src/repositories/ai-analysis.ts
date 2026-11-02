import {
  AssertionRuleSchema,
  describeSlaRule,
  formatSlaMeasured,
  type AiUnavailableReason,
} from '@perfportal/contracts';
import type pg from 'pg';
import { readStoredFigures, type StoredFigures } from '../metrics/stored-figures.js';
import { NOT_EXACT_RUN_SQL } from './recompute.js';

/** Held to these three words by run_ai_analysis_status_check. */
export type AiAnalysisStatus = 'pending' | 'ready' | 'failed';

export interface AiAnalysisRecord {
  runId: string;
  status: AiAnalysisStatus;
  /** The validated analysis; null until it is ready. Validated by the caller, never here. */
  content: unknown | null;
  provider: string | null;
  model: string | null;
  /** The facts version the analysis was checked against: a record, not a staleness signal. */
  factsVersion: number | null;
  failureReason: string | null;
  requestedAt: Date;
  /** When the analysis was written; staleness compares the run's own ingest and recompute times with it. */
  generatedAt: Date | null;
}

/**
 * Everything the API and the worker decide eligibility from, in one read.
 * `verificationStatus` is run_verification.status, null when the run has no
 * row; `hasStats` is whether any run_stat row exists; `notExact` is
 * NOT_EXACT_RUN_SQL, the one definition of a run whose statistics predate
 * exact statistics.
 */
export interface AiEligibility {
  orgId: string;
  status: string;
  hasStats: boolean;
  notExact: boolean;
  verificationStatus: string | null;
  ingestedAt: Date | null;
  recomputedAt: Date | null;
}

/** A run the pipeline may still be working on: no analysis describes it yet. */
const IN_PROGRESS = new Set(['pending', 'parsing', 'running']);
/** The two endings that leave figures to analyse. */
const ANALYSABLE = new Set(['complete', 'incomplete']);

/**
 * ═══ THE ONE DEFINITION OF WHETHER A RUN MAY BE ANALYSED ═══
 *
 * Why this run may not be analysed, in the order the API reports it
 * (`AI_UNAVAILABLE_REASONS`), or null when it may. Beside `eligibility()`,
 * whose row it reads, so the API's GET and POST and the worker's re-check
 * before calling the provider cannot disagree: a card offered for a run the
 * worker then skips would be a button that fails. `configured` and
 * `orgEnabled` are passed in — they are the deployment's and the org's, not
 * the run's.
 *
 * TERMINAL is read as the spec's "complete or incomplete with run_stat rows":
 * a run still pending, parsing or running is `not_terminal`; a run that ended
 * any other way (a failed ingest) has nothing measured to analyse and reads
 * `no_statistics`, as a finished run without rows does.
 */
export function aiUnavailableReason(
  run: AiEligibility,
  opts: { configured: boolean; orgEnabled: boolean },
): AiUnavailableReason | null {
  if (!opts.configured) return 'not_configured';
  if (!opts.orgEnabled) return 'org_disabled';
  if (IN_PROGRESS.has(run.status)) return 'not_terminal';
  if (!ANALYSABLE.has(run.status) || !run.hasStats) return 'no_statistics';
  if (run.notExact) return 'estimated';
  if (run.verificationStatus === 'mismatch') return 'verification_mismatch';
  return null;
}

/*
 * ═══ THE INPUT'S SHAPE IS DECLARED HERE, NOT IMPORTED ═══
 *
 * @perfportal/insight builds the facts from this, and that package may not
 * import persistence at runtime — nor may persistence depend on it, which
 * would make the two a cycle. So these are structural: insight's test pins
 * that they are assignable to its FactsInput, the same way it pins
 * StoredFigures against FactsFigures.
 */

export interface AiAnalysisRun {
  simulation: string | null;
  status: string;
  durationMs: number | null;
  activityMs: number | null;
}

/** A platform SLA assertion, already described and rendered from its frozen snapshot. */
export interface AiPlatformAssertion {
  description: string;
  outcome: string;
  /** The measured value in the rule's own unit; null when nothing was measured. */
  actualDisplay: string | null;
}

export interface AiAnalysisInput {
  run: AiAnalysisRun;
  figures: StoredFigures;
  platformAssertions: AiPlatformAssertion[];
  /** run.tool_assertions as stored: the simulation's own assertions. */
  toolAssertions: unknown;
}

interface AiAnalysisRow {
  run_id: string;
  status: string;
  content: unknown;
  provider: string | null;
  model: string | null;
  facts_version: number | null;
  failure_reason: string | null;
  requested_at: Date;
  generated_at: Date | null;
}

/**
 * One AI analysis per run, and what deciding whether to make one reads.
 * Raw SQL on a pg pool, like VerificationRepository beside it.
 */
export class AiAnalysisRepository {
  constructor(private readonly pool: pg.Pool) {}

  async find(runId: string): Promise<AiAnalysisRecord | null> {
    const { rows } = await this.pool.query<AiAnalysisRow>(
      `SELECT run_id, status, content, provider, model, facts_version, failure_reason,
              requested_at, generated_at
         FROM run_ai_analysis WHERE run_id = $1::uuid`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId: row.run_id,
      // Narrowed by the CHECK constraint, not guessed.
      status: row.status as AiAnalysisStatus,
      content: row.content,
      provider: row.provider,
      model: row.model,
      factsVersion: row.facts_version,
      failureReason: row.failure_reason,
      requestedAt: row.requested_at,
      generatedAt: row.generated_at,
    };
  }

  async eligibility(runId: string): Promise<AiEligibility | null> {
    const { rows } = await this.pool.query<{
      org_id: string;
      status: string;
      has_stats: boolean;
      not_exact: boolean;
      verification_status: string | null;
      ingested_at: Date | null;
      recomputed_at: Date | null;
    }>(
      `SELECT r.org_id, r.status,
              EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id) AS has_stats,
              ${NOT_EXACT_RUN_SQL} AS not_exact,
              v.status AS verification_status, r.ingested_at, r.recomputed_at
         FROM run r LEFT JOIN run_verification v ON v.run_id = r.id
        WHERE r.id = $1::uuid`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      orgId: row.org_id,
      status: row.status,
      hasStats: row.has_stats,
      notExact: row.not_exact,
      verificationStatus: row.verification_status,
      ingestedAt: row.ingested_at,
      recomputedAt: row.recomputed_at,
    };
  }

  /**
   * Upsert: an analysis (re)requested. Everything the last attempt left —
   * content, provider, model, facts version, failure, generated time — is
   * cleared, and the request is stamped now and by this person. A run that
   * does not exist gets no row, rather than a foreign-key error.
   */
  async markPending(runId: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_ai_analysis (run_id, status, requested_by, requested_at)
       SELECT r.id, 'pending', $2, now() FROM run r WHERE r.id = $1::uuid
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'pending', content = NULL, provider = NULL, model = NULL,
         facts_version = NULL, failure_reason = NULL, generated_at = NULL,
         requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at`,
      [runId, userId],
    );
  }

  /**
   * A finished analysis. When it was asked for, and by whom, is kept: those
   * describe the request, not the answer.
   */
  async record(
    runId: string,
    r: { content: unknown; provider: string; model: string; factsVersion: number },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_ai_analysis (run_id, status, content, provider, model, facts_version, generated_at)
       VALUES ($1::uuid, 'ready', $2::jsonb, $3, $4, $5, now())
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'ready', content = EXCLUDED.content, provider = EXCLUDED.provider,
         model = EXCLUDED.model, facts_version = EXCLUDED.facts_version,
         failure_reason = NULL, generated_at = EXCLUDED.generated_at`,
      [runId, JSON.stringify(r.content), r.provider, r.model, r.factsVersion],
    );
  }

  /**
   * An attempt that produced nothing usable. The content and its provenance
   * go with it, so a failed row never pairs a reason with an older answer,
   * and generated_at stays null: nothing was generated.
   */
  async markFailed(runId: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_ai_analysis (run_id, status, failure_reason)
       VALUES ($1::uuid, 'failed', $2)
       ON CONFLICT (run_id) DO UPDATE SET
         status = 'failed', failure_reason = EXCLUDED.failure_reason, content = NULL,
         provider = NULL, model = NULL, facts_version = NULL, generated_at = NULL`,
      [runId, reason],
    );
  }

  /**
   * Everything the facts builder reads, from the stored rows the run pages
   * read: the run's own columns, readStoredFigures, the platform assertions
   * with their FROZEN rule snapshot (never the current rule), and the
   * simulation's own assertions as stored. Null for a run that does not exist.
   */
  async readInput(runId: string): Promise<AiAnalysisInput | null> {
    const { rows } = await this.pool.query<{
      simulation: string | null;
      status: string;
      duration_ms: number | null;
      activity_ms: number | null;
      started_on: string;
      tool_assertions: unknown;
    }>(
      `SELECT simulation, status, duration_ms, activity_ms, started_on::text AS started_on, tool_assertions
         FROM run WHERE id = $1::uuid`,
      [runId],
    );
    const run = rows[0];
    if (run === undefined) return null;

    // started_on is a date column, selected as text because node-postgres
    // would parse it as LOCAL midnight; readStoredFigures wants the UTC day.
    const figures = await readStoredFigures(this.pool, runId, new Date(`${run.started_on}T00:00:00.000Z`));

    // Failed first, as the run page lists them; id breaks ties so two reads agree.
    const assertions = await this.pool.query<{
      rule_snapshot: unknown;
      outcome: string;
      actual_value: number | null;
      message: string;
    }>(
      `SELECT rule_snapshot, outcome, actual_value, message
         FROM run_assertion WHERE run_id = $1::uuid ORDER BY outcome, id`,
      [runId],
    );

    return {
      run: {
        simulation: run.simulation,
        status: run.status,
        durationMs: run.duration_ms,
        activityMs: run.activity_ms,
      },
      figures,
      platformAssertions: assertions.rows.map((a) => platformAssertion(runId, a)),
      toolAssertions: run.tool_assertions,
    };
  }
}

/**
 * A stored assertion in the run page's own words. A snapshot that does not
 * parse is logged and falls back to the evaluator's stored message and the
 * bare number, rather than dropping the assertion: a failed gate missing from
 * the facts would let an analysis say the run passed.
 */
function platformAssertion(
  runId: string,
  a: { rule_snapshot: unknown; outcome: string; actual_value: number | null; message: string },
): AiPlatformAssertion {
  const rule = AssertionRuleSchema.safeParse(a.rule_snapshot);
  if (!rule.success) {
    console.warn(`run ${runId}: an SLA assertion's rule snapshot does not parse`, rule.error.issues);
    return {
      description: a.message,
      outcome: a.outcome,
      actualDisplay: a.actual_value === null ? null : String(a.actual_value),
    };
  }
  return {
    description: describeSlaRule(rule.data),
    outcome: a.outcome,
    actualDisplay:
      a.actual_value === null ? null : formatSlaMeasured(rule.data.metric, a.actual_value, rule.data.threshold),
  };
}
