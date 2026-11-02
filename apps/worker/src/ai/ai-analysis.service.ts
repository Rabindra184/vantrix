import { AiAnalysisContentSchema, ToolAssertionSchema, type AiUnavailableReason, type ToolAssertion } from '@perfportal/contracts';
import { buildRunFacts, checkNumbers, type RunFacts } from '@perfportal/insight';
import { AiAnalysisRepository, OrgSettingsRepository, type AiEligibility } from '@perfportal/persistence';
import type pg from 'pg';
import { z } from 'zod';
import type { WorkerConfig } from '../config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { isTransientProviderError, RefusedError, type AnalysisProvider } from './providers.js';

/**
 * What became of one job: an analysis stored (`ready`), an attempt recorded
 * as failed (`failed`), or nothing generated because the run is not one an
 * analysis may be written for (`skipped`, its reason recorded on the row).
 */
export type AiOutcome = 'ready' | 'failed' | 'skipped';

/** A run the pipeline may still be working on: no analysis describes it yet. */
const IN_PROGRESS = new Set(['pending', 'parsing', 'running']);
/** The two endings that leave figures to analyse. */
const ANALYSABLE = new Set(['complete', 'incomplete']);

/**
 * Why this run may not be analysed, in the order the API asks
 * (`AI_UNAVAILABLE_REASONS`), or null when it may. `configured` and
 * `orgEnabled` are passed in: they are the deployment's and the org's, not
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

const ToolAssertionsSchema = z.array(ToolAssertionSchema);

/** The longest schema complaint quoted back to the model: enough to name the fields, never a page. */
const FEEDBACK_ISSUE_LIMIT = 1_000;

/**
 * ═══ ONE ANALYSIS, CHECKED AGAINST THE RUN'S OWN FACTS ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, How it works)
 *
 * The API marks a row pending and queues a job; this does the rest. It
 * re-reads the org switch and the run's eligibility FIRST, because an admin
 * may have turned AI off, or the run been recomputed into a state with no
 * analysis, between the click and the job: a job queued just before the
 * switch went off must send nothing.
 *
 * The answer is held to two checks before it is stored: the content schema,
 * and `checkNumbers` (every number in it traces to a fact). Either failing
 * earns ONE retry, told what was wrong; a second failure is recorded with the
 * reason and the card says the analysis could not be produced. A model that
 * declines is recorded `refused` at once — asking again gets the same answer.
 *
 * A provider that could not be reached is the queue's to retry: the error is
 * rethrown so BullMQ's attempts and backoff apply, and only on the last
 * attempt is it recorded (`provider_error`), so a pending row never outlives
 * its last job. A provider that REFUSED the request (a bad key, an unknown
 * model) is recorded at once: the same request will be refused again.
 */
export class AiAnalysisService {
  readonly #analyses: AiAnalysisRepository;
  readonly #orgs: OrgSettingsRepository;

  constructor(
    private readonly config: WorkerConfig,
    pool: pg.Pool,
    private readonly provider: AnalysisProvider | null,
  ) {
    this.#analyses = new AiAnalysisRepository(pool);
    this.#orgs = new OrgSettingsRepository(pool);
  }

  async generate(runId: string, opts: { lastAttempt: boolean }): Promise<AiOutcome> {
    const run = await this.#analyses.eligibility(runId);
    // A run deleted after it was queued: there is no row to record a reason
    // on, and nothing left to analyse.
    if (run === null) return 'skipped';

    const provider = this.config.ai === null ? null : this.provider;
    const reason = aiUnavailableReason(run, {
      configured: provider !== null,
      orgEnabled: await this.#orgs.aiEnabled(run.orgId),
    });
    if (reason !== null || provider === null) {
      await this.#analyses.markFailed(runId, reason ?? 'not_configured');
      return 'skipped';
    }

    const input = await this.#analyses.readInput(runId);
    if (input === null) return 'skipped';
    const facts = buildRunFacts({ ...input, toolAssertions: toolAssertionsOf(runId, input.toolAssertions) });

    let feedback: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let raw: unknown;
      try {
        raw = await provider.generate({ system: SYSTEM_PROMPT, facts, feedback });
      } catch (err) {
        if (err instanceof RefusedError) {
          await this.#analyses.markFailed(runId, 'refused');
          return 'failed';
        }
        if (isTransientProviderError(err) && !opts.lastAttempt) throw err;
        console.error(`ai analysis: run ${runId}: the provider failed`, err);
        await this.#analyses.markFailed(runId, 'provider_error');
        return 'failed';
      }

      const verdict = judge(raw, facts);
      if (verdict.ok) {
        await this.#analyses.record(runId, {
          content: verdict.content,
          provider: provider.name,
          model: provider.model,
          factsVersion: facts.version,
        });
        return 'ready';
      }
      if (attempt === 2) {
        await this.#analyses.markFailed(runId, verdict.reason);
        return 'failed';
      }
      feedback = verdict.feedback;
    }
    // Unreachable: the second pass returns on every branch.
    throw new Error('ai analysis: retry loop fell through');
  }
}

type Verdict =
  | { ok: true; content: unknown }
  | { ok: false; reason: string; feedback: string };

/** The schema first (a malformed answer has no numbers worth checking), then the numbers. */
function judge(raw: unknown, facts: RunFacts): Verdict {
  const parsed = AiAnalysisContentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = z.prettifyError(parsed.error).slice(0, FEEDBACK_ISSUE_LIMIT);
    return {
      ok: false,
      reason: 'invalid_output',
      feedback:
        `Your previous answer did not match the required format:\n${issues}\n` +
        'Write the analysis again, filling every field of the schema and nothing else.',
    };
  }
  const refused = checkNumbers(parsed.data, facts);
  if (refused.length === 0) return { ok: true, content: parsed.data };
  const list = refused.join(', ');
  return {
    ok: false,
    reason: `numbers_not_in_facts: ${list}`,
    feedback:
      `Your previous answer used numbers that are not in the facts: ${list}. ` +
      "Write the analysis again, using only numbers copied exactly from a fact's display string, " +
      'and quoting an error message whole or not at all.',
  };
}

/**
 * run.tool_assertions as the facts builder needs it. Absent is none. A value
 * that does not parse — a column some older worker wrote in a shape this one
 * does not read — is logged and treated as none: the column is the ingest's,
 * and an analysis of every other figure is worth more than a refusal over it.
 */
function toolAssertionsOf(runId: string, stored: unknown): ToolAssertion[] {
  if (stored === null || stored === undefined) return [];
  const parsed = ToolAssertionsSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  console.warn(`ai analysis: run ${runId}: its simulation assertions do not parse, so none are sent`, parsed.error.issues);
  return [];
}
