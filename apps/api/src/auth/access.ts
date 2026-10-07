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
 * `projectIds` is present for a non-admin session ONLY. Absent means "every
 * project in the org" to that clause, which is right for an admin and
 * meaningless for a bearer token (whose `projectId` already narrows it), and
 * `[]` means "none". So a non-admin session that somehow arrives without its
 * list is given `[]`: it sees nothing rather than the whole org.
 */
export function listScope(tenant: Tenant): TenantScope {
  const scope: { orgId: string; projectId?: string; projectIds?: readonly string[] } = { orgId: tenant.orgId };
  if (tenant.projectId !== undefined) scope.projectId = tenant.projectId;
  if (tenant.isAdmin === false) scope.projectIds = tenant.projectIds ?? [];
  return scope;
}

/**
 * Whether the caller may see a project at all: a bearer token sees the one
 * project it was minted for, an admin sees every project, and anyone else
 * sees the projects they hold a role in — any role, since viewer is the
 * lowest and seeing is what it grants.
 *
 * Says nothing about the ORG: callers reach `projectId` through an org-scoped
 * lookup, which is what keeps another install's project out. Every branch
 * fails closed — a tenant missing the field its branch reads sees nothing.
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
