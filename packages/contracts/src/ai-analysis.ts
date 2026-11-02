import { z } from 'zod';

/**
 * ═══ THE AI RUN ANALYSIS CONTRACTS ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md)
 *
 * One finished run, summarised by a model into three sections: how the run
 * went, what the figures show, and what to do next. GE's "AI run analysis"
 * card, built on PerfPortal's own exact figures.
 *
 * ═══ THE CONTENT SCHEMA IS ALSO THE MODEL'S OUTPUT SCHEMA ═══
 *
 * `AiAnalysisContentSchema` is handed to the provider as the JSON schema its
 * answer must fill, AND it parses that answer before anything is stored. So
 * every bound below is an instruction to the model as well as a check, and
 * `.strict()` on every object is load-bearing twice over: it puts
 * `additionalProperties: false` into the schema the model sees, and it turns a
 * key the model invented anyway into a refusal rather than a silent strip —
 * zod's default would drop the key and store an answer that looked complete.
 *
 * Every string is trimmed before it is measured, so a bullet of spaces is
 * empty and refused rather than stored as a blank line on the page.
 */

/** One sentence the model writes: trimmed, 1 to 400 characters. */
const AnalysisLineSchema = z.string().trim().min(1).max(400);

/** A section's one-line lead: trimmed, 1 to 300 characters. */
const AnalysisHeadlineSchema = z.string().trim().min(1).max(300);

/**
 * A headed list of at least one and at most six bullets. Health and
 * recommendations ARE the analysis, so neither may be empty: a model with
 * nothing to say there has failed, and the answer is refused.
 */
const AnalysisSectionSchema = z
  .object({
    headline: AnalysisHeadlineSchema,
    bullets: z.array(AnalysisLineSchema).min(1).max(6),
  })
  .strict();
export type AiAnalysisSection = z.infer<typeof AnalysisSectionSchema>;

/**
 * An insights list may be EMPTY: a run with no errors has nothing to say
 * under Errors, and an empty list is how the model says so without inventing
 * a bullet to fill the heading.
 */
const InsightListSchema = z.array(AnalysisLineSchema).max(6);

export const AiAnalysisContentSchema = z
  .object({
    health: AnalysisSectionSchema,
    insights: z
      .object({
        headline: AnalysisHeadlineSchema,
        errors: InsightListSchema,
        assertions: InsightListSchema,
        injectionProfile: InsightListSchema,
        responseTimes: InsightListSchema,
      })
      .strict(),
    recommendations: AnalysisSectionSchema,
  })
  .strict();
export type AiAnalysisContent = z.infer<typeof AiAnalysisContentSchema>;

/**
 * Why a run cannot be analysed at all, in the order the API asks:
 *
 * - `not_configured` — the deployment set no `AI_PROVIDER`.
 * - `org_disabled` — the deployment has a provider and this org's admin has
 *   not switched the feature on.
 * - `not_terminal` — the run is still pending, parsing or running.
 * - `no_statistics` — the run finished with nothing measured.
 * - `estimated` — its statistics predate exact statistics (never recomputed,
 *   or retired with a `recompute_error`). The analysis promises exact numbers
 *   and those runs cannot keep the promise, so they get no card.
 * - `verification_mismatch` — the verifier found stored figures disagreeing
 *   with the raw log, and no NEW analysis is written while it says so.
 */
export const AI_UNAVAILABLE_REASONS = [
  'not_configured',
  'org_disabled',
  'not_terminal',
  'no_statistics',
  'estimated',
  'verification_mismatch',
] as const;
export const AiUnavailableReasonSchema = z.enum(AI_UNAVAILABLE_REASONS);
export type AiUnavailableReason = z.infer<typeof AiUnavailableReasonSchema>;

/**
 * Where a run's analysis is: never asked for (`none`), queued or being
 * written (`pending`), stored (`ready`), or given up on (`failed`).
 */
export const AiAnalysisStateSchema = z.enum(['none', 'pending', 'ready', 'failed']);
export type AiAnalysisState = z.infer<typeof AiAnalysisStateSchema>;

/**
 * How long a pending analysis is trusted to have a job behind it. Past this a
 * POST queues it again, and the card offers to (it reads `requestedAt`). One
 * number for both, so the page never offers a retry the API would answer with
 * the same pending row.
 *
 * Thirty-five minutes is the longest a job can run, with room. One attempt
 * makes at most two provider calls (a second only when the first answer
 * fails the number check) of at most 300 s each (`TIMEOUT_MS`, worker
 * providers.ts): 600 s. A call cut off at its timeout is recorded at once and
 * never retried, but a transient failure (a 5xx, a 429) can still arrive at
 * the end of a long call, so all three attempts (`AI_ANALYSIS_JOB_OPTIONS`)
 * can each take the full 600 s: 1,800 s, plus the backoff between them,
 * 10 s and then 20 s — 1,830 s, about 30.5 minutes.
 */
export const AI_PENDING_REQUEUE_AFTER_MS = 35 * 60_000;

/**
 * `GET /v1/runs/{id}/ai-analysis`.
 *
 * Unavailable carries the reason alone, because nothing else can be true of
 * it. Available carries every field whatever the state, null where the state
 * has none — so a client reads one shape and branches on `state`, never on
 * which keys happen to be present.
 *
 * CONTENT EXACTLY WHEN READY. A ready analysis without content, or a pending
 * one carrying some, is a response that means two things and the page could
 * only guess which; the refinement refuses both. `stale` is true when the
 * run's statistics were rewritten (its `recomputed_at` or `ingested_at` is
 * later than `generatedAt`) after the analysis was written, so the stored text
 * may describe figures the page no longer shows. A facts-version bump in a
 * release is NOT staleness: an upgrade must not invite paid regeneration
 * across an install.
 */
const AiAnalysisAvailableSchema = z
  .object({
    available: z.literal(true),
    state: AiAnalysisStateSchema,
    content: AiAnalysisContentSchema.nullable(),
    failureReason: z.string().nullable(),
    generatedAt: z.string().datetime().nullable(),
    model: z.string().nullable(),
    stale: z.boolean(),
    /**
     * When the analysis was last asked for — the row's `requested_at`, null
     * with no row. A pending row older than `AI_PENDING_REQUEUE_AFTER_MS` has
     * nothing working on it any more, and this is how the card can tell that
     * apart from one a job is still writing, and offer to ask again.
     *
     * `.optional()` as well as `.nullable()`, for the rolling-deploy reason
     * `live-delta.ts` and `RunIdentity` carry: the GET shipped before this
     * field did, the browser drops a body that fails the schema, and a page
     * reading an older pod would lose its card — and read a POST that pod had
     * accepted as a failure. Absent means "not reported", which the card
     * treats as an unknown age: it keeps polling and offers no retry.
     */
    requestedAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.state === 'ready') !== (body.content !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message:
          body.state === 'ready'
            ? 'A ready analysis carries its content.'
            : `An analysis in state "${body.state}" carries no content.`,
      });
    }
  });

export const AiAnalysisResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: AiUnavailableReasonSchema }),
  AiAnalysisAvailableSchema,
]);
export type AiAnalysisResponse = z.infer<typeof AiAnalysisResponseSchema>;
