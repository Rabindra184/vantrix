import type { TokenScopeName } from './tokens.js';

/**
 * The roles a person can hold in ONE project, in rank order: each role can do
 * everything the one before it can. The order of this array IS the ranking
 * `roleSatisfies` reads, so a fourth role goes in at its rank, not at the end.
 *
 * `admin` is deliberately not here. It is a flag on the ACCOUNT
 * (`user.role === 'admin'`), not a membership, so no project row can grant it.
 */
export const PROJECT_ROLES = ['viewer', 'member', 'manager'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The lowest standing an action asks for: a project role, or the admin flag. */
export type AccessRole = ProjectRole | 'admin';

export type AccessAction =
  | 'project:read'
  | 'rules:read'
  | 'members:read'
  | 'run:note'
  | 'run:upload'
  | 'runner:run'
  | 'packages:manage'
  | 'packages:delete'
  | 'rules:edit'
  | 'tests:manage'
  | 'tokens:manage'
  | 'members:manage'
  | 'projects:create'
  | 'users:manage';

/**
 * Every action a project route can declare, with the lowest role that may
 * perform it AND the token scope a bearer credential needs for it — one table,
 * so the two credential types cannot drift apart
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 2).
 *
 * `scope: null` means SESSION ONLY: no token may perform the action, whatever
 * its scopes. That is every admin action, because a token is minted against
 * one project and an admin action is a decision about the whole organisation.
 *
 * `run:upload` is null although `POST /v1/runs` takes `ingest`: that is the
 * bearer route, and it declares no action. The route this action guards is
 * the browser upload, which is session-only today and stays so.
 *
 * `label` names the action in a refusal ("Editing SLA rules needs the Member
 * role in this project."), so it reads as the subject of a sentence.
 */
export const ACCESS_ACTIONS: Readonly<
  Record<AccessAction, Readonly<{ role: AccessRole; scope: TokenScopeName | null; label: string }>>
> = {
  'project:read': { role: 'viewer', scope: 'read', label: 'Reading this project' },
  'rules:read': { role: 'viewer', scope: null, label: 'Viewing SLA rules' },
  'members:read': { role: 'viewer', scope: null, label: 'Viewing members' },
  'run:note': { role: 'member', scope: null, label: 'Editing run notes' },
  'run:upload': { role: 'member', scope: null, label: 'Uploading runs' },
  'runner:run': { role: 'member', scope: 'runner', label: 'Starting, cancelling and retrying runs' },
  'packages:manage': { role: 'member', scope: 'runner', label: 'Managing packages' },
  'packages:delete': { role: 'member', scope: null, label: 'Deleting packages' },
  'rules:edit': { role: 'member', scope: null, label: 'Editing SLA rules' },
  'tests:manage': { role: 'manager', scope: null, label: 'Renaming and deleting tests' },
  'tokens:manage': { role: 'manager', scope: null, label: 'Managing API tokens' },
  'members:manage': { role: 'admin', scope: null, label: 'Managing members' },
  'projects:create': { role: 'admin', scope: null, label: 'Creating projects' },
  'users:manage': { role: 'admin', scope: null, label: 'Managing users' },
};

/**
 * Whether a person holding `held` in a project meets an action asking for
 * `required`.
 *
 * FALSE when either is not a project role. `indexOf` answers -1 for a role
 * it does not know, which a bare `>=` reads as the lowest rank of all — so an
 * unknown REQUIRED role would be satisfied by anyone. The types rule both out;
 * a value read from a row, or `'admin'` from an `AccessRole` a caller forgot
 * to handle first, does not consult the types. The admin flag is never a
 * project role, so a caller checks it BEFORE asking this.
 */
export function roleSatisfies(held: ProjectRole, required: ProjectRole): boolean {
  const heldRank = PROJECT_ROLES.indexOf(held);
  const requiredRank = PROJECT_ROLES.indexOf(required);
  return heldRank !== -1 && requiredRank !== -1 && heldRank >= requiredRank;
}

/**
 * Whether someone may perform `action` in one project: the API's rule, asked
 * where the API is not. `AccessGuard` decides with `accessDecision`, which
 * also tells a missing role (a 404) from a low one (a 403); the web only
 * needs yes or no, to draw a control exactly when the request behind it
 * would be let through. `apps/api/test/access.test.ts` pins the two to the
 * same answer for every action and every caller.
 *
 * In order: the admin flag passes everything, whatever role its holder has
 * in this project. An admin action refuses everyone else. No role — `null`
 * for a project the person holds none in, `undefined` for a response with no
 * `role` field at all (an API older than the field) — refuses. Otherwise the
 * role is ranked against the action's. Whether the answer is KNOWN — a list
 * not loaded yet, say — is the caller's question, never this function's: the
 * web's `useProjectAccess` keeps it apart as `known`.
 */
export function canPerform(
  action: AccessAction,
  who: { isAdmin: boolean; role: ProjectRole | null | undefined },
): boolean {
  if (who.isAdmin === true) return true;
  const required = ACCESS_ACTIONS[action].role;
  if (required === 'admin') return false;
  if (who.role === null || who.role === undefined) return false;
  return roleSatisfies(who.role, required);
}

/**
 * A project role as a sentence names it: the enum's own word, capitalised
 * (`member` reads "Member"). `accessRefusal` and the API document's role
 * sentences both spell a role through this, so the two cannot disagree.
 */
export function roleName(role: ProjectRole): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

/** The words a refused action is answered with: a 403's code, detail and remediation. */
export type AccessRefusal = {
  code: 'ROLE_REQUIRED' | 'ADMIN_REQUIRED';
  detail: string;
  remediation: string;
};

/**
 * How a refusal of `action` is worded — the ONE place, so `AccessGuard`'s
 * 403 and the web's own "you cannot do this" say the same thing. An admin
 * action names no role, since no project role can grant it; any other names
 * the role it needs, capitalised ("needs the Member role in this project").
 * The sentence depends on the action alone, never on who was refused.
 */
export function accessRefusal(action: AccessAction): AccessRefusal {
  const { role, label } = ACCESS_ACTIONS[action];
  if (role === 'admin') {
    return { code: 'ADMIN_REQUIRED', detail: `${label} needs an admin.`, remediation: 'Ask an admin to do this.' };
  }
  return {
    code: 'ROLE_REQUIRED',
    detail: `${label} needs the ${roleName(role)} role in this project.`,
    remediation: 'Ask an admin to change your role.',
  };
}
