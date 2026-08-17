import { z } from 'zod';

export const RunStatusSchema = z.enum(['pending', 'parsing', 'complete', 'failed']);
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

export const RunResponseSchema = z.object({
  id: z.string().uuid(),
  /**
   * The project this run belongs to. REQUIRED, not optional: run.project_id
   * is NOT NULL, so an optional field would model a state the database
   * cannot hold — and apps/web parses with RunResponseSchema.parse, so a
   * server that forgets it must fail loudly rather than render a blank
   * where a project name belongs.
   */
  project: ProjectRefSchema,
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
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
  /** The load test's own span. Gatling's header renders this to whole seconds (G-04). */
  durationMs: z.number().int().nullable().optional(),
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
  /** When the platform received this run's bundle — ingest time, not tool start. */
  startedAt: z.string().datetime(),
  /**
   * The load test's own start, read from the tool's run header. Null until
   * the worker finishes parsing (and forever for a run that never
   * completes) — distinct from startedAt, which is always ingest time.
   */
  toolStartedAt: z.string().datetime().nullable().optional(),
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
 */
export const RunProcessingSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'parsing']),
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
