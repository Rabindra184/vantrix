/**
 * Every repository method takes this. Tenancy is a required parameter, not a
 * convention someone remembers — a query that forgets it will not compile.
 */
export interface TenantScope {
  readonly orgId: string;
  /**
   * Present for a bearer token, which is minted against one project. ABSENT for
   * a user session, which is org-scoped: a human may read any run in their org.
   * When absent, callers filter on org_id alone - never on a guessed project.
   */
  readonly projectId?: string;
  /**
   * The projects a NON-ADMIN session may see: present only for one. Absent for
   * an admin (who sees every project in the org) and for a bearer token (which
   * names its one project in `projectId` instead).
   *
   * `[]` and absent mean OPPOSITE things: `[]` is a person who belongs to no
   * project and must see nothing, absent is someone who may see everything.
   * Never collapse one into the other — `visibilityClause` below is the one
   * place that reads it, so an org-wide read cannot get this wrong by itself.
   */
  readonly projectIds?: readonly string[];
}

/**
 * A TenantScope known to carry a project. Every caller today builds its scope
 * from a run row or a bearer token, both of which always have one — so this
 * costs no call site anything, and keeps the compiler enforcing "this query
 * genuinely needs a project" for methods that are not findById/list (the two
 * that must accept a project-less session scope).
 */
export type ProjectScope = TenantScope & { projectId: string };

/**
 * The one clause an org-wide read adds to keep a non-admin session to its own
 * projects: `null` when the scope names no project list (nothing to narrow),
 * otherwise `<column> = ANY($n::uuid[])` with the list pushed onto `params`,
 * so `$n` is numbered after whatever the caller has already bound.
 *
 * AN EMPTY LIST STILL RETURNS A CLAUSE. `= ANY('{}')` matches no row, which is
 * the answer for a person who belongs to no project; returning `null` for it
 * would hand them the whole org. That is why the test is `=== undefined` and
 * never a truthiness or length check.
 */
export function visibilityClause(scope: TenantScope, column: string, params: unknown[]): string | null {
  if (scope.projectIds === undefined) return null;
  params.push(scope.projectIds);
  return `${column} = ANY($${params.length}::uuid[])`;
}
