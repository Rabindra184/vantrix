import { AiAnalysisContentSchema, ToolAssertionSchema, type ToolAssertion } from '@perfportal/contracts';
import { buildRunFacts, checkNumbers, type RunFacts } from '@perfportal/insight';
import { AiAnalysisRepository, aiUnavailableReason, OrgSettingsRepository } from '@perfportal/persistence';
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
 * attempt is it recorded (`provider_error`). A provider that REFUSED the
 * request (a bad key, an unknown model) is recorded at once: the same request
 * will be refused again. Any other error is rethrown too, and recorded on the
 * last attempt as `internal_error` — so a pending row never outlives its last
 * job, whatever ended it. (One exception no service can see: a job BullMQ
 * fails for stalling too often never reaches this code. Its row stays pending,
 * and the API's re-queue of a stale pending row is what settles it; the queue
 * keeps no failed job, so that re-queue is not ignored.)
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
    try {
      return await this.#generate(runId, opts);
    } catch (err) {
      // Anything that reaches here is a failure nothing above classified — the
      // database refusing a read or a write, a bug — and it is rethrown so the
      // queue's attempts apply. On the LAST attempt it is also recorded, or
      // the row would read "Analysing…" for ever: BullMQ gives up on the job
      // and nothing else would ever settle it. `internal_error`, not
      // `provider_error`: the provider was never the problem, and an operator
      // reading the row should look at this worker's log, not at the
      // provider's status page. Recording it may fail for the same reason the
      // job did; that is logged, and the ORIGINAL error is the one rethrown.
      if (opts.lastAttempt) {
        console.error(`ai analysis: run ${runId}: failed on its last attempt`, err);
        await this.#analyses.markFailed(runId, 'internal_error').catch((recordErr: unknown) => {
          console.error(`ai analysis: run ${runId}: could not record the failure`, recordErr);
        });
      }
      throw err;
    }
  }

  async #generate(runId: string, opts: { lastAttempt: boolean }): Promise<AiOutcome> {
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
      `Your previous answer used numbers that are not in the facts, or numbers written as words: ${list}. ` +
      "Write the analysis again, using only numbers copied exactly from a fact's display string, " +
      'writing every number in digits (never as a word, a multiple or a fraction), ' +
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
