import { z } from 'zod';
import { RunStatusSchema, RunVerdictSchema } from './run.js';

export const ProjectSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  /**
   * The project's most recent run, by the same ordering GET /v1/runs
   * uses. Null for a project nothing has ever been ingested into.
   *
   * `status` rides along with `verdict` deliberately: a pending run has
   * `verdict: null`, and a badge reading that as "not evaluated" would
   * state a fact about a run nobody has measured yet. Read `status`
   * first; fall through to `verdict` only for a `complete` run.
   */
  latestRun: z
    .object({
      id: z.string().uuid(),
      status: RunStatusSchema,
      verdict: RunVerdictSchema.nullable(),
    })
    .nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const CreateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.'),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * Every project a credential can see. A session sees its whole org's; a
 * bearer token sees the one project it was minted against. One rule, not
 * two — "the projects this credential can see".
 *
 * No `nextCursor`: an org has a handful of projects, not a page of them. If
 * one ever has enough to need paging, this schema needs a cursor and the
 * sidebar needs a scroll region — one change, and this sentence is where it
 * starts.
 */
export const ProjectListResponseSchema = z.object({
  items: z.array(ProjectSummarySchema),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
