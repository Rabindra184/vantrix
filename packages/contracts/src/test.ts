import { z } from 'zod';
import { RunStatusSchema, RunVerdictSchema } from './run.js';

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
   * This test's most recent run, by the same ordering `GET /v1/runs` uses.
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
    })
    .nullable(),
});
export type TestSummary = z.infer<typeof TestSummarySchema>;

export const TestListResponseSchema = z.object({
  tests: z.array(TestSummarySchema),
});
export type TestListResponse = z.infer<typeof TestListResponseSchema>;

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
