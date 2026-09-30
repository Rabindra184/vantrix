import { z } from 'zod';

/**
 * ═══ A RUN'S LIFECYCLE EVENTS — WHAT THE LOGS TAB SHOWS ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * For a run the on-prem runner executed: the run's own orchestration events,
 * in Gatling Enterprise's words wherever the moment exists here. NEVER
 * Gatling's console — the runner's job log keeps that, and it carries the
 * command line with every -D value, none of which belongs on the run page.
 *
 * An event is a MESSAGE or a PHASE separator (`---| Injecting |---`), never
 * both and never neither. The database's CHECK constraint is what enforces
 * that; this schema describes the shape rather than deciding it a second time.
 */
export const RUN_EVENT_SOURCES = ['perfportal', 'runner'] as const;
export const RunEventSourceSchema = z.enum(RUN_EVENT_SOURCES);
export type RunEventSource = z.infer<typeof RunEventSourceSchema>;

/** Gatling Enterprise's own three phase separators, in the order they occur. */
export const RUN_EVENT_PHASES = ['Deploying', 'Injecting', 'Ending'] as const;
export const RunEventPhaseSchema = z.enum(RUN_EVENT_PHASES);
export type RunEventPhase = z.infer<typeof RunEventPhaseSchema>;

export const RunEventSchema = z.object({
  at: z.string().datetime(),
  source: RunEventSourceSchema,
  message: z.string().nullable(),
  phase: RunEventPhaseSchema.nullable(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunEventsResponseSchema = z.object({
  runId: z.string().uuid(),
  /** False when the run has no on-prem runner job — an upload, or a run the
   *  Gradle plugin streamed — so there was nothing to record. */
  recorded: z.boolean(),
  /** Oldest first. */
  events: z.array(RunEventSchema),
});
export type RunEventsResponse = z.infer<typeof RunEventsResponseSchema>;
