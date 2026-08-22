import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'pending', 'parsing',
  // Opened for streaming, accepting batches. Reported as 202 exactly like
  // pending/parsing, so a CI poll loop needs no change.
  'running',
  'complete', 'failed',
  // Closed without its producer saying so -- inactivity or abort. All received
  // data is retained and the run is labelled; its verdict is always
  // not_evaluated, because a partial run can satisfy every SLA rule purely by
  // having stopped before the load that would have broken it (FR-LIVE-5).
  'incomplete',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunVerdictSchema = z.enum(['passed', 'failed', 'not_evaluated']);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const AssertionOutcomeSchema = z.enum(['passed', 'failed', 'not_applicable']);
export type AssertionOutcome = z.infer<typeof AssertionOutcomeSchema>;

export const AssertionSchema = z.object({
  ruleId: z.string().uuid(),
  outcome: AssertionOutcomeSchema,
  /** Null when the outcome is not_applicable — there was nothing to measure. */
  actualValue: z.number().nullable(),
  message: z.string(),
  rule: z.object({
    scope: z.enum(['run', 'scenario', 'group', 'request']),
    targetName: z.string().nullable(),
    family: z.enum(['response_time', 'latency', 'group_cumulated', 'group_duration']),
    metric: z.string(),
    comparator: z.enum(['lte', 'gte']),
    threshold: z.number(),
  }),
});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * One of the tool's own assertions, as a reader sees it — Appendix A G-05's
 * four columns.
 *
 * `expression` carries the expected value inside it ("… is less than 30000.0"),
 * because that is how the tool renders it and G-05's tolerance is exact on the
 * wording, not just the number. Splitting the threshold back out would produce
 * a row that reads differently from the report it claims parity with.
 */
export const ToolAssertionOutcomeSchema = z.enum(['passed', 'failed', 'not_applicable']);
export type ToolAssertionOutcome = z.infer<typeof ToolAssertionOutcomeSchema>;

export const ToolAssertionSchema = z.object({
  expression: z.string(),
  /** Null when nothing could be measured — see `not_applicable`. */
  actualValue: z.number().nullable(),
  /**
   * `not_applicable` where the assertion named a path this run has no
   * statistics for. The tool calls that a failure; this platform does not,
   * because "the endpoint you named does not exist" and "the endpoint is too
   * slow" are different facts a reader acts on differently (§22.1 tenet 6).
   */
  outcome: ToolAssertionOutcomeSchema,
});
export type ToolAssertion = z.infer<typeof ToolAssertionSchema>;

/**
 * A run's owning project, as every run response carries it. Its own schema
 * rather than an inline object so RunResponse and RunListResponse cannot
 * describe the same thing two ways.
 */
export const ProjectRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/**
 * What a run knows about itself from the moment it exists, independent of
 * whether anything has parsed it.
 *
 * ONE SCHEMA, EXTENDED TWICE — by `RunResponseSchema` below and by
 * `RunProcessingSchema` further down. That is the anti-drift device and the
 * reason this is not a copied field list: adding a chip to the run header is
 * then one edit rather than two that can silently disagree about a field's
 * nullability.
 *
 * NO `status` HERE, deliberately. The two consumers enumerate their own
 * statuses independently (see `RunProcessingSchema`'s own comment), and
 * hoisting the field would make widening one widen the other.
 *
 * NO `verdict`, `windowable`, `assertions` or `error` either: those are
 * MEASUREMENTS, not identity, and keeping them off this schema is what stops
 * a running run's type from being able to express one.
 */
export const RunIdentitySchema = z.object({
  id: z.string().uuid(),
  /**
   * The project this run belongs to. REQUIRED, not optional: run.project_id
   * is NOT NULL, so an optional field would model a state the database
   * cannot hold — and apps/web parses with RunResponseSchema.parse, so a
   * server that forgets it must fail loudly rather than render a blank
   * where a project name belongs.
   */
  project: ProjectRefSchema,
  tool: z.string(),
  toolVersion: z.string().nullable().optional(),
  /**
   * From ingest metadata, frozen at accept time. Null for every run created
   * before migration 20260815000000_run_ingest_provenance, and for any run
   * whose caller did not send them.
   */
  environment: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  /** The tool's own simulation identity and run description (G-01, G-02). */
  simulation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /**
   * The span the SERIES OFFSETS live in: run-header start to last event.
   * Every bucket `startOffsetMs` is relative to the header start, so a time
   * axis must span this or the final bucket falls outside the domain
   * (`useTimeDomainFromShell`, `TimeBrush`).
   *
   * NOT the number the run page labels "Duration" — that is `activityMs`.
   */
  durationMs: z.number().int().nullable().optional(),
  /**
   * The run's MEASURED span: first event (after warm-up) to last event, and
   * exactly what every `throughputRps` divides by (G-04).
   *
   * THE PAGE USED TO CONTRADICT ITSELF WITHOUT THIS. The header rendered
   * `durationMs` while the throughput tile beside it divided by the activity
   * span, so `throughput x duration` disagreed with the request count on the
   * same screen — 14.32 req/s over a stated 63s is 907, printed next to 895.
   * Gatling anchors its own reported duration at the first event too, which
   * is why its report reads "1m 2s" where `durationMs` rounds to 63s.
   *
   * Null for runs ingested before migration 20260822090000: the lead-in it
   * subtracts is not recoverable from a stored row, so readers fall back to
   * `durationMs` rather than showing a backfilled guess.
   */
  activityMs: z.number().int().nullable().optional(),
  /** When the platform received this run's bundle — ingest time, not tool start. */
  startedAt: z.string().datetime(),
  /**
   * The load test's own start, read from the tool's run header. Null until
   * the worker finishes parsing (and forever for a run that never
   * completes) — distinct from startedAt, which is always ingest time.
   */
  toolStartedAt: z.string().datetime().nullable().optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const RunResponseSchema = RunIdentitySchema.extend({
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  /**
   * Whether this run's buckets carry the per-bucket histograms a time window is
   * re-aggregated from.
   *
   * False for a run ingested before that migration. The UI must not offer a
   * brush for such a run: every windowed metric call would return 400
   * WINDOW_UNAVAILABLE, which is correct of the API and useless to a reader who
   * was invited to drag something. Optional so a client written before this
   * field existed still parses.
   */
  windowable: z.boolean().optional(),
  ingestedAt: z.string().datetime().nullable().optional(),
  assertions: z.array(AssertionSchema),
  /**
   * The assertions the LOAD TEST declared, re-evaluated against this
   * platform's statistics — Appendix A G-05.
   *
   * A SECOND FIELD, not merged into `assertions` above. Those are SLA rule
   * results: they carry a `ruleId`, they are configured per project, and their
   * outcome drives the 200/422 verdict a CI job gates on. These are owned by
   * whoever wrote the simulation, are immutable, and can express comparisons
   * (`between`, `in`) that the SLA comparator set has no member for. Merging
   * them would mean inventing a rule id or widening a contract CI depends on.
   *
   * NULL means the run predates the assertion decoder — its definitions were
   * discarded at ingest and live only in the raw bundle. `[]` means the
   * simulation declared none. Optional so a client written before this field
   * existed still parses.
   */
  toolAssertions: z.array(ToolAssertionSchema).nullable().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), remediation: z.string() })
    .nullable()
    .optional(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

/**
 * The 202 body: the run is not yet terminal. Mirrors exactly what
 * respondWithRun() sends (apps/api/src/runs/runs.controller.ts) — `failed`
 * is excluded because a failed run is handled by that function's own
 * `run.status === 'failed'` branch before this shape would ever apply, and
 * `complete` never reaches 202 at all (it resolves to 200 or 422 instead).
 *
 * `incomplete` is excluded for the same reason `complete` is: it is terminal
 * (see RunStatusSchema above), so it is never reported as 202 either.
 *
 * This enum is declared INDEPENDENTLY of RunStatusSchema rather than derived
 * from it (e.g. `RunStatusSchema.exclude([...])`), so widening one is not
 * enough to widen the other -- and nothing typechecks that gap, which is
 * exactly why `running` needs its own line here. `running` belongs: an
 * in-progress live run is still pending-shaped from a poller's point of
 * view, so it gets the same 202 treatment as pending/parsing and a CI script
 * needs no new branch to keep working once streaming exists.
 *
 * EVERY IDENTITY FIELD IS OPTIONAL HERE, INCLUDING `project` AND `tool` — and
 * for a different reason than they are optional on a run body. During a
 * rolling deploy a new browser polls an OLD pod and receives just
 * `{ id, status, statusUrl }`. A required field would make `.parse()` throw
 * and blank the run page for the whole rollout, the same failure
 * `live-delta.test.ts` exists to prevent one endpoint over.
 */
export const RunProcessingSchema = RunIdentitySchema.partial().extend({
  // Re-required after `.partial()`: the API has always sent it, on every path.
  id: z.string().uuid(),
  status: z.enum(['pending', 'parsing', 'running']),
  statusUrl: z.string(),
});
export type RunProcessing = z.infer<typeof RunProcessingSchema>;

export const RunListResponseSchema = z.object({
  items: z.array(
    RunResponseSchema.pick({
      id: true,
      project: true,
      status: true,
      verdict: true,
      tool: true,
      startedAt: true,
      toolStartedAt: true,
      simulation: true,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
