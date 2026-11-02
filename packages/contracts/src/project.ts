import { z } from 'zod';
import { PROJECT_ROLES } from './access.js';
import { RunStatusSchema, RunVerdictSchema } from './run.js';

export const ProjectSummarySchema = z.object({
  id: z.guid(),
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
      id: z.guid(),
      status: RunStatusSchema,
      verdict: RunVerdictSchema.nullable(),
    })
    .nullable(),
  /**
   * The caller's role in this project, so the UI can show and hide controls.
   * `null` is either an admin who holds no membership row here — the admin
   * flag is what lets them see the project, so read that flag before this
   * field — or a bearer token, which is a machine credential and holds no
   * role in any project. `POST /v1/projects` answers `null` for the first
   * reason: only an admin may create a project, and creating one writes no
   * membership row for its creator.
   *
   * `.nullable().optional()`, and the OPTIONAL half is the load-bearing one,
   * for the reason `TokenSummarySchema.expiresAt` records: the browser drops
   * a body that fails this schema, so a response from a pod that predates the
   * field must still parse during a rolling deploy.
   */
  role: z.enum(PROJECT_ROLES).nullable().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/**
 * What a project slug may be, and therefore also what a URL segment must NOT
 * look like if it is to sit beside `/projects/:slug` without shadowing a real
 * project.
 *
 * EXPORTED because two places need the SAME grammar and a second copy could
 * drift: this schema, and `apps/web/test/paths.test.ts`, which asserts that
 * every literal segment the router declares under `/projects/` fails this
 * pattern. Note it forbids `_` — which is what makes `_new` a segment no
 * project can ever be named, by construction rather than by a reserved-word
 * list somebody has to remember to extend.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateProjectRequestSchema = z
  .object({
    // Every bound carries its own sentence because `NewProject` shows the
    // first issue's message to a person, and zod's own wording describes the
    // check ("Too small: expected string to have >=2 characters") rather
    // than the field.
    name: z
      .string()
      .trim()
      .min(1, 'Enter a project name.')
      .max(120, 'A project name is at most 120 characters.'),
    slug: z
      .string()
      .trim()
      .min(2, 'A project slug is at least 2 characters.')
      .max(80, 'A project slug is at most 80 characters.')
      .regex(PROJECT_SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens.'),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * Every project a credential can see. An admin's session sees its whole
 * org's; anyone else's sees the projects they hold a role in, and none when
 * they hold none; a bearer token sees the one project it was minted against.
 * One rule, not three — "the projects this credential can see".
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
