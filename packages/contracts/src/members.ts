import { z } from 'zod';
import { PROJECT_ROLES } from './access.js';

/**
 * One person's membership of a project, as `GET /v1/projects/:slug/members`
 * returns it.
 *
 * `role` is the enum rather than `z.string()` — the asymmetry
 * `TokenSummarySchema` argues for does not apply, because
 * `project_member_role_check` constrains the column to `PROJECT_ROLES`, so a
 * stored row cannot hold anything this refuses.
 */
export const ProjectMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(PROJECT_ROLES),
  addedAt: z.string().datetime(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const MemberListResponseSchema = z.object({
  members: z.array(ProjectMemberSchema),
});
export type MemberListResponse = z.infer<typeof MemberListResponseSchema>;

/**
 * The body of `POST /v1/projects/:slug/members`: an EXISTING account, and the
 * role it gets. No project here — the URL names it, and a body that could
 * name a second project is a request that means two things.
 *
 * `userId` is trimmed although an id is machine-produced: it carries a bound,
 * every bounded input in this package trims (`trimmed-input.test.ts`), and a
 * trim cannot turn one real id into another.
 */
export const AddMemberRequestSchema = z
  .object({
    userId: z.string().trim().min(1),
    role: z.enum(PROJECT_ROLES),
  })
  .strict();
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

/** The body of `PATCH /v1/projects/:slug/members/:userId`: the URL names the
 *  person, so the role is all there is to change. */
export const UpdateMemberRequestSchema = z
  .object({
    role: z.enum(PROJECT_ROLES),
  })
  .strict();
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;
