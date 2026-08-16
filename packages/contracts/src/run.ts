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
