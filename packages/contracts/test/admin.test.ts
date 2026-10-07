import { describe, expect, it } from 'vitest';
import {
  AdminProjectListResponseSchema,
  AdminProjectSchema,
  AdminUserListResponseSchema,
  AdminUserSchema,
  CreateUserRequestSchema,
  PROJECT_ROLES,
  SetPasswordRequestSchema,
  UpdateUserRequestSchema,
} from '../src/index.js';

/** Roles a project row must never hold: `admin` is an ACCOUNT flag, not a
 *  membership, and the rest are near-misses a hand-written client sends. */
const NOT_ROLES = ['admin', 'owner', 'Viewer', 'MEMBER', ''];

const CREATE = { email: 'asha@example.test', name: 'Asha', password: 'temporary-1' };

describe('CreateUserRequestSchema', () => {
  /**
   * The two defaults are what an admin gets by leaving the form alone: an
   * ordinary account in no project. Neither may default the other way — an
   * account that is quietly an admin, or quietly a member of something, is
   * access nobody chose to grant.
   */
  it('defaults to an ordinary account in no project', () => {
    expect(CreateUserRequestSchema.parse(CREATE)).toEqual({ ...CREATE, isAdmin: false, projects: [] });
  });

  it('keeps an admin flag and project rows it is given', () => {
    const body = { ...CREATE, isAdmin: true, projects: [{ projectSlug: 'checkout', role: 'manager' }] };
    expect(CreateUserRequestSchema.parse(body)).toEqual(body);
  });

  /**
   * Better Auth stores an email lowercased and does not trim it, and the admin
   * routes look an account up ignoring case — so the schema hands them the
   * one spelling both agree on, and a pasted trailing space cannot become
   * part of an address.
   */
  it('trims and lowercases the email, and refuses one that is not an address', () => {
    expect(CreateUserRequestSchema.parse({ ...CREATE, email: '  Asha@Example.TEST ' }).email).toBe(
      'asha@example.test',
    );
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, email: 'asha' }).success).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, email: '   ' }).success).toBe(false);
  });

  it('trims the name and bounds it at 1 to 120 characters', () => {
    expect(CreateUserRequestSchema.parse({ ...CREATE, name: '  Asha  ' }).name).toBe('Asha');
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, name: '   ' }).success).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, name: 'n'.repeat(120) }).success).toBe(true);
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, name: 'n'.repeat(121) }).success).toBe(false);
  });

  /** `auth.api.createUser` does not check password length, so this is the
   *  only check a temporary password gets. */
  it.each([
    [7, false],
    [8, true],
    [128, true],
    [129, false],
  ])('a temporary password of %i characters is accepted: %s', (length, accepted) => {
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, password: 't'.repeat(length) }).success).toBe(
      accepted,
    );
  });

  it('accepts exactly the project roles on a project row', () => {
    for (const role of PROJECT_ROLES) {
      const body = { ...CREATE, projects: [{ projectSlug: 'checkout', role }] };
      expect(CreateUserRequestSchema.safeParse(body).success, role).toBe(true);
    }
    for (const role of NOT_ROLES) {
      const body = { ...CREATE, projects: [{ projectSlug: 'checkout', role }] };
      expect(CreateUserRequestSchema.safeParse(body).success, role).toBe(false);
    }
  });

  /** The slug grammar is `CreateProjectRequestSchema`'s, so a row can only
   *  name something that could be a project. */
  it('refuses a project row whose slug no project could have', () => {
    for (const projectSlug of ['Checkout', 'check out', 'check--out', '']) {
      const body = { ...CREATE, projects: [{ projectSlug, role: 'viewer' }] };
      expect(CreateUserRequestSchema.safeParse(body).success, projectSlug).toBe(false);
    }
  });

  /**
   * One project, two roles, is a request that means two things — and which
   * row "wins" would be decided by insertion order, out of sight. Refused at
   * the duplicate, so the message points at the row to remove. Compared after
   * the trim, so padding cannot smuggle a second row past it.
   */
  it('refuses the same project listed twice, at the second row', () => {
    const r = CreateUserRequestSchema.safeParse({
      ...CREATE,
      projects: [
        { projectSlug: 'checkout', role: 'viewer' },
        { projectSlug: 'search', role: 'member' },
        { projectSlug: ' checkout ', role: 'manager' },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path)).toEqual([['projects', 2, 'projectSlug']]);
  });

  it('accepts distinct projects', () => {
    const body = {
      ...CREATE,
      projects: [
        { projectSlug: 'checkout', role: 'viewer' },
        { projectSlug: 'search', role: 'member' },
      ],
    };
    expect(CreateUserRequestSchema.safeParse(body).success).toBe(true);
  });

  it('refuses a field it does not know, at the top or on a project row', () => {
    expect(CreateUserRequestSchema.safeParse({ ...CREATE, role: 'admin' }).success).toBe(false);
    expect(
      CreateUserRequestSchema.safeParse({
        ...CREATE,
        projects: [{ projectSlug: 'checkout', role: 'viewer', addedBy: 'u_9' }],
      }).success,
    ).toBe(false);
  });
});

describe('UpdateUserRequestSchema', () => {
  it('accepts any one of name, isAdmin or disabled', () => {
    expect(UpdateUserRequestSchema.parse({ name: '  Asha K ' })).toEqual({ name: 'Asha K' });
    expect(UpdateUserRequestSchema.parse({ isAdmin: true })).toEqual({ isAdmin: true });
    expect(UpdateUserRequestSchema.parse({ disabled: false })).toEqual({ disabled: false });
  });

  /** An empty patch would be a write that changes nothing and reports
   *  success — the reason `UpdateSlaRuleRequestSchema` refuses one too. */
  it('refuses an empty patch', () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
  });

  it('bounds the name exactly as a create does', () => {
    expect(UpdateUserRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ name: 'n'.repeat(121) }).success).toBe(false);
  });

  /** No email and no password: the password has its own route, and an email
   *  change is not something this PR offers. Silently ignoring either would
   *  let a caller believe they had changed it. */
  it('refuses a field it does not know', () => {
    expect(UpdateUserRequestSchema.safeParse({ name: 'Asha', email: 'x@example.test' }).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ password: 'temporary-1' }).success).toBe(false);
  });
});

describe('SetPasswordRequestSchema', () => {
  it.each([
    [7, false],
    [8, true],
    [128, true],
    [129, false],
  ])('a reset password of %i characters is accepted: %s', (length, accepted) => {
    expect(SetPasswordRequestSchema.safeParse({ password: 'r'.repeat(length) }).success).toBe(accepted);
  });

  it('refuses a field it does not know', () => {
    expect(SetPasswordRequestSchema.safeParse({ password: 'temporary-1', userId: 'u_2' }).success).toBe(false);
  });
});

describe('AdminUserSchema', () => {
  const USER = {
    id: 'u_1',
    name: 'Asha',
    email: 'asha@example.test',
    isAdmin: false,
    disabled: false,
    mustChangePassword: true,
    memberships: [{ projectSlug: 'checkout', projectName: 'Checkout', role: 'member' }],
    createdAt: '2026-10-07T09:00:00.000Z',
  };

  it('parses a user and a list of them', () => {
    expect(AdminUserSchema.parse(USER)).toEqual(USER);
    expect(AdminUserListResponseSchema.parse({ users: [USER] })).toEqual({ users: [USER] });
  });

  it('accepts exactly the project roles on a membership', () => {
    for (const role of PROJECT_ROLES) {
      const user = { ...USER, memberships: [{ ...USER.memberships[0], role }] };
      expect(AdminUserSchema.safeParse(user).success, role).toBe(true);
    }
    for (const role of NOT_ROLES) {
      const user = { ...USER, memberships: [{ ...USER.memberships[0], role }] };
      expect(AdminUserSchema.safeParse(user).success, role).toBe(false);
    }
  });
});

describe('AdminProjectSchema', () => {
  it('parses a project with its member count, and a list of them', () => {
    const project = { slug: 'checkout', name: 'Checkout', memberCount: 3, createdAt: '2026-10-07T09:00:00.000Z' };
    expect(AdminProjectSchema.parse(project)).toEqual(project);
    expect(AdminProjectListResponseSchema.parse({ projects: [project] })).toEqual({ projects: [project] });
    expect(AdminProjectSchema.safeParse({ ...project, memberCount: -1 }).success).toBe(false);
  });
});
