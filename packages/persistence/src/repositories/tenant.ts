/**
 * Every repository method takes this. Tenancy is a required parameter, not a
 * convention someone remembers — a query that forgets it will not compile.
 */
export interface TenantScope {
  readonly orgId: string;
  /**
   * Present for a bearer token, which is minted against one project. ABSENT for
   * a user session, which names no single project: an admin's session reaches
   * every project in the org, and anyone else's is narrowed by `projectIds`
   * below. When absent, callers filter on org_id - never on a guessed project -
   * plus `visibilityClause` wherever an org-wide read must honour that list.
   *
   * A session that names one project of its own (`GET /v1/runs?project=`)
   * carries it here too, beside its `projectIds`: the caller checked the
   * session can see it before narrowing to it.
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
 * genuinely needs a project" for every method that is not one of those taking
 * a project-less session scope: `RunRepository.findById`/`setNote` and the
 * org-wide lists (`RunRepository.list`, `TestRepository.listOrg`,
 * `ProjectRepository.listForOrg`, `ActivityRepository.read`).
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
 *
 * `column` IS SPLICED INTO THE SQL AS WRITTEN, NOT BOUND. It must be a literal
 * in the calling code — a trusted identifier such as `'r.project_id'` — and
 * never anything that came from a request; only the id list is a parameter.
 *
 * Callers AND the clause onto the org predicate they already have, never into
 * an OR: a branch the planner cannot index costs every other branch of an OR
 * its index (see the run search in `RunRepository.list`).
 */
export function visibilityClause(scope: TenantScope, column: string, params: unknown[]): string | null {
  if (scope.projectIds === undefined) return null;
  params.push(scope.projectIds);
  return `${column} = ANY($${params.length}::uuid[])`;
}
