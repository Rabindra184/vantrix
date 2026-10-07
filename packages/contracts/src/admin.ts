import { z } from 'zod';
import { PROJECT_ROLES } from './access.js';
import { PasswordSchema } from './me.js';

/**
 * The schemas behind `/v1/admin`: an admin managing every account and seeing
 * every project in the install (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 3).
 *
 * `role` is the enum everywhere here, responses included —
 * `project_member_role_check` constrains the stored column to `PROJECT_ROLES`,
 * so the response-schema caution `TokenSummarySchema` records does not apply.
 */

/** One project an account belongs to, with the role it holds there. */
const AdminMembershipSchema = z.object({
  projectSlug: z.string(),
  projectName: z.string(),
  role: z.enum(PROJECT_ROLES),
});

/**
 * An account as the Users list shows it. `isAdmin` is the account flag
 * (`user.role === 'admin'`), never a project role; `disabled` is Better
 * Auth's ban; `mustChangePassword` is set by a create or a reset and cleared
 * by `PUT /v1/me/password`.
 */
export const AdminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  mustChangePassword: z.boolean(),
  memberships: z.array(AdminMembershipSchema),
  createdAt: z.string().datetime(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUserListResponseSchema = z.object({
  users: z.array(AdminUserSchema),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

/**
 * A person's display name, on a create and on an edit alike: trimmed, and the
 * 120-character bound every other human-typed name in this package carries.
 */
const UserNameSchema = z.string().trim().min(1).max(120);

/**
 * One project row on an Add user form: which project, and what role.
 *
 * `projectSlug` is NOT checked against `PROJECT_SLUG_PATTERN`. That grammar is
 * what `POST /v1/projects` lets a new slug be, not what every existing slug
 * is: bootstrap writes its slug verbatim from argv or
 * `PERFPORTAL_PROJECT_SLUG`, so a project slugged `Checkout_API` can exist and
 * serve its routes. A regex here would refuse every role in it, so whether
 * the slug names a project is the route's lookup to decide.
 */
const ProjectGrantSchema = z
  .object({
    projectSlug: z.string().trim().min(1),
    role: z.enum(PROJECT_ROLES),
  })
  .strict();

/**
 * The body of `POST /v1/admin/users`.
 *
 * `email` is trimmed and lowercased here. The admin routes look an account up
 * ignoring case, so lowercasing hands them the spelling Better Auth stores.
 * The trim is about the address the admin meant: Better Auth's `createUser`
 * refuses a padded one outright (its own email check throws 400
 * INVALID_EMAIL, an error the admin routes would otherwise have to map), so
 * a pasted trailing space would otherwise fail a create that was right.
 *
 * `password` is the temporary one the person must replace at first sign-in.
 * `auth.api.createUser` does not check its length, so `PasswordSchema` is the
 * only check it gets.
 *
 * The defaults are what an admin gets by leaving the form alone: an ordinary
 * account in no project. Neither may default the other way — an account that
 * is quietly an admin, or quietly a member of something, is access nobody
 * chose to grant.
 *
 * A project listed twice is refused, at the repeat: one project with two roles
 * is a request that means two things, and which row won would be decided by
 * insertion order, out of sight. Slugs are compared after their trim.
 */
export const CreateUserRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    name: UserNameSchema,
    password: PasswordSchema,
    isAdmin: z.boolean().default(false),
    projects: z
      .array(ProjectGrantSchema)
      .superRefine((rows, ctx) => {
        const seen = new Set<string>();
        rows.forEach((row, index) => {
          if (seen.has(row.projectSlug)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'projectSlug'],
              message: `"${row.projectSlug}" is listed more than once. Give each project one role.`,
            });
          }
          seen.add(row.projectSlug);
        });
      })
      .default([]),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
/** What a client may SEND, before the defaults apply: `isAdmin` and
 *  `projects` optional. `CreateUserRequest` is the parsed shape, with both
 *  filled in. */
export type CreateUserRequestInput = z.input<typeof CreateUserRequestSchema>;

/**
 * The body of `PATCH /v1/admin/users/:userId`. No email and no password: the
 * password has its own route, and changing an email is not offered.
 *
 * The `.refine()` makes an empty patch a 400 rather than a write that changes
 * nothing and reports success — the reason `UpdateSlaRuleRequestSchema`
 * refuses one too.
 */
export const UpdateUserRequestSchema = z
  .object({
    name: UserNameSchema.optional(),
    isAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.isAdmin !== undefined || body.disabled !== undefined, {
    message: 'Send at least one of "name", "isAdmin" or "disabled".',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

/** The body of `PUT /v1/admin/users/:userId/password`: a new temporary
 *  password, which the person must replace at their next sign-in. */
export const SetPasswordRequestSchema = z
  .object({
    password: PasswordSchema,
  })
  .strict();
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

/** A project as the admin's Projects list shows it, with how many people hold
 *  a role in it. */
export const AdminProjectSchema = z.object({
  slug: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type AdminProject = z.infer<typeof AdminProjectSchema>;

export const AdminProjectListResponseSchema = z.object({
  projects: z.array(AdminProjectSchema),
});
export type AdminProjectListResponse = z.infer<typeof AdminProjectListResponseSchema>;
