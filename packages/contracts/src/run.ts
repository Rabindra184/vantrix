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

export const RunResponseSchema = z.object({
  id: z.string().uuid(),
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  tool: z.string(),
  toolVersion: z.string().nullable().optional(),
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
      status: true,
      verdict: true,
      tool: true,
      startedAt: true,
      toolStartedAt: true,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
