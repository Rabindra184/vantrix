import { roleSatisfies, type AccessRole, type ProjectRole } from '@perfportal/contracts';
import type { ProjectMemberRepository, TenantScope } from '@perfportal/persistence';
import type { Tenant } from './auth.guard.js';

/**
 * What a SESSION knows about which of its org's projects it may see: the
 * three Tenant fields `authenticateSession` adds and `authenticateRequest`
 * never sets. `isAdmin` and `projectRoles` always; `projectIds` for a
 * non-admin only.
 */
export type SessionAccess = Required<Pick<Tenant, 'isAdmin' | 'projectRoles'>> & Pick<Tenant, 'projectIds'>;

/**
 * Who a signed-in person is, beyond their org. The ONE place that answers
 * it: `authenticateSession` spreads the result onto the session's Tenant, and
 * `LiveGateway` — which authenticates its own upgrades, outside Nest's
 * pipeline — calls this rather than deciding for itself, so the HTTP path and
 * the live feed cannot drift into two answers to the same question.
 *
 * The admin flag is exactly `user.role === 'admin'`: anything else, including
 * a role this product never writes, is an ordinary account. An admin sees
 * every project and skips the roles query, so their `projectRoles` is empty
 * and they carry no `projectIds`.
 *
 * Read per call and never cached: a role removed between two requests is gone
 * on the second.
 */
export async function loadSessionAccess(
  user: { id: string; role?: string | null },
  projectMembers: Pick<ProjectMemberRepository, 'rolesForUser'>,
): Promise<SessionAccess> {
  if (user.role === 'admin') return { isAdmin: true, projectRoles: new Map() };
  const projectRoles = await projectMembers.rolesForUser(user.id);
  return { isAdmin: false, projectRoles, projectIds: [...projectRoles.keys()] };
}

/**
 * The repository scope an org-wide read takes: the org, a bearer token's one
 * project, and a non-admin session's project list for `visibilityClause`.
 *
 * Absent `projectIds` means "every project in the org" to that clause, which
 * is right for an admin and meaningless for a bearer token (whose `projectId`
 * already narrows it); `[]` means "none". So the list is left off for exactly
 * those two — a tenant carrying a `projectId`, or one marked `isAdmin: true` —
 * and EVERY OTHER tenant is narrowed, to its list or to `[]` without one. That
 * is `canSeeProject`'s decision tree, and it fails closed the same way: a
 * session built without `loadSessionAccess` (a dropped spread, a new path
 * that forgot it) has neither field, and sees nothing rather than the org.
 */
export function listScope(tenant: Tenant): TenantScope {
  const scope: { -readonly [K in keyof TenantScope]: TenantScope[K] } = { orgId: tenant.orgId };
  if (tenant.projectId !== undefined) scope.projectId = tenant.projectId;
  if (tenant.projectId === undefined && tenant.isAdmin !== true) scope.projectIds = tenant.projectIds ?? [];
  return scope;
}

/**
 * DOES NOT CHECK THE ORG. The admin branch answers true for ANY project id,
 * another org's project included, so a caller must reach `projectId` through
 * an org-scoped lookup first (the run or project row it read, scoped by
 * `orgId`) — that lookup, not this function, is what keeps another org's
 * project out.
 *
 * Within the org: a bearer token sees the one project it was minted for, an
 * admin sees every project, and anyone else sees the projects they hold a
 * role in — any role, since viewer is the lowest and seeing is what it
 * grants. Every branch fails closed — a tenant missing the field its branch
 * reads sees nothing.
 *
 * Takes only the three fields it reads, so `LiveGateway` can ask with the
 * {@link SessionAccess} it loaded rather than a Tenant it would have to fake.
 */
export function canSeeProject(
  tenant: Pick<Tenant, 'projectId' | 'isAdmin' | 'projectRoles'>,
  projectId: string,
): boolean {
  if (tenant.projectId !== undefined) return tenant.projectId === projectId;
  if (tenant.isAdmin === true) return true;
  return tenant.projectRoles?.has(projectId) === true;
}

/**
 * What a SESSION may do with one action in one project — the whole rule,
 * kept apart from the guard's lookups so every case can be read and tested
 * in one place. `required` is the action's row in `ACCESS_ACTIONS`; `role`
 * is the session's role in the project the route names, or null when it
 * holds none there.
 *
 * In order: an admin passes everything. An admin action refuses everyone
 * else, whatever role they hold. No role in the project is `not-found`, never
 * a 403 — the project is one this person cannot see, and the answer has to
 * be the one a project that does not exist gets. Otherwise the role is
 * ranked against the action's; `'admin'` is settled above, so it never
 * reaches `roleSatisfies`.
 */
export function accessDecision(input: {
  required: AccessRole;
  isAdmin: boolean;
  role: ProjectRole | null;
}): 'allow' | 'not-found' | 'role-required' | 'admin-required' {
  if (input.isAdmin) return 'allow';
  if (input.required === 'admin') return 'admin-required';
  if (input.role === null) return 'not-found';
  return roleSatisfies(input.role, input.required) ? 'allow' : 'role-required';
}
