import { z } from 'zod';
import { RunStatusSchema, RunVerdictSchema } from './run.js';
import { RunNumberSchema } from './run-number.js';

/**
 * A test: the named thing a project runs repeatedly, and the layer between a
 * project and its runs.
 *
 * ═══ THE RESPONSE IS DELIBERATELY LOOSE WHERE THE REQUEST IS STRICT ═══
 *
 * `slug`, `name` and `simulationClass` are plain strings on the way out. A
 * stored row that somehow fails a tighter shape must not 500 a list the reader
 * is entitled to see — the same reasoning `RunListResponse` records for not
 * making its status an enum. Requests are `.strict()` for the opposite reason:
 * a field the schema does not know is a caller mistake worth naming.
 */
export const TestSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  /**
   * The tool's own class name, and the key a parsed run is matched on. Kept
   * separate from `name` because renaming a test must not orphan its runs:
   * `name` is what a reader calls it, this is what the log header says.
   */
  simulationClass: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * How many runs this test has. Cheap here (one grouped count) and expensive
   * for a caller to assemble — it would be one request per test otherwise.
   */
  runCount: z.number().int().nonnegative(),
  /**
   * This test's most recent run by ARRIVAL (`created_at DESC, id DESC`), which
   * is the order run numbers follow — so it is always the test's
   * highest-numbered run. That is NOT the order `GET /v1/runs` uses: the run
   * list sorts by when the test RAN (`COALESCE(tool_started_at, started_at)`),
   * and the two differ only for a bundle uploaded after a newer one, which is
   * the latest run here and sits lower in that list. (This docstring used to
   * claim the run list's ordering; the code never used it.)
   *
   * Null for a test whose every run has since been deleted; NOT null merely
   * because a run is unfinished.
   *
   * `status` rides along with `verdict` for the reason `ProjectSummary`
   * records: a pending run has `verdict: null`, and reading that as "not
   * evaluated" states a fact about a run nobody has measured yet.
   */
  latestRun: z
    .object({
      id: z.string().uuid(),
      status: RunStatusSchema,
      verdict: RunVerdictSchema.nullable(),
      /** "Run 12" in the catalogue's last-run cell. Optional: an older pod
       *  omits it, and the browser drops a body that fails the schema. */
      runNumber: RunNumberSchema.nullable().optional(),
    })
    .nullable(),
});
export type TestSummary = z.infer<typeof TestSummarySchema>;

export const TestListResponseSchema = z.object({
  tests: z.array(TestSummarySchema),
});
export type TestListResponse = z.infer<typeof TestListResponseSchema>;

/**
 * One row of the ORG-WIDE test list (`GET /v1/tests`): a test, the project it
 * belongs to, the run it is currently about, and a short p95 history. It
 * serves the portfolio home table and the command palette, so everything a
 * row draws is here and neither has to ask per test.
 *
 * Loose on the way out like `TestSummarySchema`, for the same reason: a stored
 * row that fails a tighter shape must not 500 a list the reader may see. That
 * is also why no string here is bounded — the trimmed-input guard would
 * demand `.trim()` of a bound, and trimming a value we only RETURN would
 * quietly rewrite what is stored.
 */
export const OrgTestSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  /** The tool's own class name; see `TestSummarySchema.simulationClass`. */
  simulationClass: z.string(),
  /** How many runs this test has. */
  runCount: z.number().int().nonnegative(),
  /** The owning project, so a row can name and link it without a lookup. */
  project: z.object({ slug: z.string(), name: z.string() }),
  /**
   * The test's latest run by ARRIVAL (`created_at DESC, id DESC`) — the order
   * run numbers follow, NOT the run list's by-start order. Null for a test
   * that has never run, or whose every run was deleted.
   */
  latestRun: z
    .object({
      id: z.string().uuid(),
      /** "Run 12". Null for a run with no test number; see `RunNumberSchema`. */
      runNumber: RunNumberSchema.nullable(),
      /**
       * `status` rides along with `verdict` for the reason `TestSummarySchema`
       * records: a pending run has no verdict yet, which is not "not
       * evaluated".
       */
      status: RunStatusSchema,
      verdict: RunVerdictSchema.nullable(),
      /**
       * When the LOAD TEST started — `COALESCE(tool_started_at, started_at)`,
       * the same instant the run list's Started column shows — and not when
       * the run arrived.
       */
      startedAt: z.string().datetime(),
      /** Null until the run has a measured duration. */
      durationMs: z.number().int().nullable(),
      /**
       * Failed and total simulation checks (the assertions the tool recorded).
       * Null when the run recorded none, which is different from `0 / 0`.
       */
      checks: z.object({ failed: z.number().int(), total: z.number().int() }).nullable(),
      /**
       * The run-scope response-time p95, clamped to that run's own min and
       * max — the figure the run list's `metrics.p95Ms` shows. Null when the
       * run has no usable one.
       */
      p95Ms: z.number().nullable(),
    })
    .nullable(),
  /**
   * The p95 of this test's last runs that completed, OLDEST FIRST, for a
   * sparkline. At most ten: the query takes ten, and the cap is stated here
   * as well so a longer array fails to parse rather than growing the row. A
   * run with no usable p95 contributes no point, so this can be shorter than
   * the number of recent runs, and is empty for a test that has never
   * completed one. Each point equals the `p95Ms` on that run's list row.
   */
  p95History: z
    .array(
      z.object({
        runId: z.string().uuid(),
        runNumber: RunNumberSchema.nullable(),
        p95Ms: z.number(),
      }),
    )
    .max(10),
});
export type OrgTestSummary = z.infer<typeof OrgTestSummarySchema>;

export const OrgTestListResponseSchema = z.object({
  items: z.array(OrgTestSummarySchema),
  /**
   * Opaque. A string asks the caller to request the next page with it; null
   * means this was the last. Required, not optional: an absent cursor would
   * be neither answer.
   */
  nextCursor: z.string().nullable(),
});
export type OrgTestListResponse = z.infer<typeof OrgTestListResponseSchema>;

/**
 * What a caller may change about a test, which is deliberately only what a
 * HUMAN chose.
 *
 * ═══ `simulationClass` IS NOT HERE, AND THAT IS THE WHOLE POINT ═══
 *
 * It is the key the worker matches a parsed run on
 * (`@@unique([projectId, simulationClass])`). Editing it would silently
 * re-aim the test: every future run of the old class would create a SECOND
 * test and start a second history, while the runs already recorded stayed
 * here. Nothing would error, and the split would only show up as a trend line
 * that went quiet.
 *
 * `slug` is absent for a smaller reason — it is a URL, changing it breaks
 * links people have shared, and no reader has asked to. Deriving it once from
 * the class is enough.
 */
export const UpdateTestRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /**
     * `null` CLEARS it, which is different from omitting the field. A caller
     * that wants to remove a description has to be able to say so, and
     * `undefined` already means "leave this alone".
     */
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: 'Send at least one of "name" or "description".',
  });
export type UpdateTestRequest = z.infer<typeof UpdateTestRequestSchema>;
