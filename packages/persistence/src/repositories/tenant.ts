/**
 * Every repository method takes this. Tenancy is a required parameter, not a
 * convention someone remembers — a query that forgets it will not compile.
 */
export interface TenantScope {
  readonly orgId: string;
  readonly projectId: string;
}
