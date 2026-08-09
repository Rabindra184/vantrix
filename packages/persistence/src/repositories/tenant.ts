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
}
