import type { ProjectRole } from '@perfportal/contracts';
import { describe, expect, it, vi } from 'vitest';
import { canSeeProject, listScope, loadSessionAccess } from '../src/auth/access.js';
import type { Tenant } from '../src/auth/auth.guard.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

/** Shaped exactly as `authenticateSession` and `authenticateRequest` build each kind. */
function session(fields: Pick<Tenant, 'isAdmin' | 'projectRoles' | 'projectIds'>): Tenant {
  return { orgId: ORG, tokenId: 'session:s1', userId: 'u1', scopes: ['read', 'ingest', 'runner'], ...fields };
}

function nonAdmin(roles: ReadonlyArray<[string, ProjectRole]>): Tenant {
  const projectRoles = new Map(roles);
  return session({ isAdmin: false, projectRoles, projectIds: [...projectRoles.keys()] });
}

const admin = session({ isAdmin: true, projectRoles: new Map() });
const bearer: Tenant = { orgId: ORG, projectId: A, tokenId: 'tok-1', scopes: ['read'] };

describe('listScope', () => {
  it("copies a non-admin session's project list", () => {
    expect(listScope(nonAdmin([[A, 'viewer']]))).toStrictEqual({ orgId: ORG, projectIds: [A] });
  });

  /**
   * `[]` and absent mean OPPOSITE things to `visibilityClause`: `[]` sees
   * nothing, absent sees the org. A member of no project has to arrive as
   * `[]`, never be tidied away into absence.
   */
  it('keeps an empty list for a session that belongs to no project', () => {
    expect(listScope(nonAdmin([]))).toStrictEqual({ orgId: ORG, projectIds: [] });
  });

  /**
   * Fails closed. `authenticateSession` always sets the list for a non-admin,
   * so this tenant cannot be built today; if a later change drops it, the
   * session must see nothing rather than the whole org.
   */
  it('narrows a non-admin session that carries no list to nothing', () => {
    expect(listScope(session({ isAdmin: false, projectRoles: new Map() }))).toStrictEqual({
      orgId: ORG,
      projectIds: [],
    });
  });

  it('omits the list for an admin, who sees every project in the org', () => {
    expect(listScope(admin)).toStrictEqual({ orgId: ORG });
  });

  it('omits the list for a bearer token, which names its one project instead', () => {
    expect(listScope(bearer)).toStrictEqual({ orgId: ORG, projectId: A });
  });
});

describe('canSeeProject', () => {
  it('is false for a session holding roles only in another project', () => {
    expect(canSeeProject(nonAdmin([[A, 'manager']]), B)).toBe(false);
  });

  it('is true for a session holding any role in the project', () => {
    expect(canSeeProject(nonAdmin([[B, 'viewer']]), B)).toBe(true);
  });

  it('is false for a session that belongs to no project', () => {
    expect(canSeeProject(nonAdmin([]), A)).toBe(false);
  });

  it('is true for an admin holding no role anywhere', () => {
    expect(canSeeProject(admin, B)).toBe(true);
  });

  it("is true for a bearer token in its own project and false in any other", () => {
    expect(canSeeProject(bearer, A)).toBe(true);
    expect(canSeeProject(bearer, B)).toBe(false);
  });
});

describe('loadSessionAccess', () => {
  it('reads an admin from the role alone, without asking for project roles', async () => {
    const rolesForUser = vi.fn();

    const access = await loadSessionAccess({ id: 'u1', role: 'admin' }, { rolesForUser });

    expect(access).toStrictEqual({ isAdmin: true, projectRoles: new Map() });
    expect(rolesForUser).not.toHaveBeenCalled();
  });

  it("lists a non-admin's projects from one read of their roles", async () => {
    const roles = new Map<string, ProjectRole>([[A, 'member'], [B, 'viewer']]);
    const rolesForUser = vi.fn(async () => roles);

    const access = await loadSessionAccess({ id: 'u1', role: 'user' }, { rolesForUser });

    expect(access).toStrictEqual({ isAdmin: false, projectRoles: roles, projectIds: [A, B] });
    expect(rolesForUser).toHaveBeenCalledTimes(1);
    expect(rolesForUser).toHaveBeenCalledWith('u1');
  });

  it('gives a member of no project an empty list, not an absent one', async () => {
    const access = await loadSessionAccess({ id: 'u1', role: 'user' }, { rolesForUser: async () => new Map() });

    expect(access.isAdmin).toBe(false);
    expect(access.projectIds).toStrictEqual([]);
  });

  /**
   * The admin flag is EXACTLY `'admin'`. A role the plugin never wrote — or no
   * role at all, on a row that predates the column — is an ordinary account.
   */
  it.each([['user'], ['Admin'], [null], [undefined]])('treats role %s as not an admin', async (role) => {
    const access = await loadSessionAccess({ id: 'u1', role }, { rolesForUser: async () => new Map() });

    expect(access.isAdmin).toBe(false);
  });
});
