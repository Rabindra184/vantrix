import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTIONS,
  PROJECT_ROLES,
  ProjectSummarySchema,
  TOKEN_SCOPES,
  roleSatisfies,
  type ProjectRole,
} from '../src/index.js';

/**
 * ═══ THE PERMISSION TABLE ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 2)
 *
 * One table maps each action to its lowest project role AND to the token
 * scope a bearer credential needs, so the two credential types cannot drift
 * apart. Imported through the package index, so a table nobody exported
 * fails here rather than in the API.
 */
describe('project roles', () => {
  it('ranks viewer below member below manager', () => {
    expect(roleSatisfies('member', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'member')).toBe(false);
    expect(roleSatisfies('manager', 'manager')).toBe(true);
    expect(roleSatisfies('member', 'manager')).toBe(false);
  });

  /**
   * FAILS CLOSED, BOTH WAYS. The ranking is an array index, and `indexOf`
   * answers -1 for a role it has never heard of. Compared naively, an unknown
   * REQUIRED role ranks below everything and is satisfied by any role at all
   * — so `'admin'` reaching here (a caller that skipped the admin flag) or a
   * role spelled wrong would let a viewer through. The types forbid both; a
   * value from a database row or an `as` does not ask the types.
   */
  it('satisfies nothing when the required role is not a project role', () => {
    expect(roleSatisfies('manager', 'admin' as ProjectRole)).toBe(false);
    expect(roleSatisfies('viewer', 'owner' as ProjectRole)).toBe(false);
  });

  it('satisfies nothing when the held role is not a project role', () => {
    expect(roleSatisfies('owner' as ProjectRole, 'viewer')).toBe(false);
    expect(roleSatisfies('owner' as ProjectRole, 'owner' as ProjectRole)).toBe(false);
  });
});

describe('ACCESS_ACTIONS', () => {
  it('gives every action a role, a label and a known scope', () => {
    for (const [name, a] of Object.entries(ACCESS_ACTIONS)) {
      expect([...PROJECT_ROLES, 'admin'], name).toContain(a.role);
      expect(a.label.length, name).toBeGreaterThan(0);
      if (a.scope !== null) expect(TOKEN_SCOPES, name).toContain(a.scope);
    }
    expect(Object.keys(ACCESS_ACTIONS)).toHaveLength(14);
  });

  it('lets no token perform an admin action', () => {
    // An admin action is a decision about the whole organisation, and a token
    // is minted against one project: a scope there would let a CI credential
    // create projects or manage people.
    for (const a of Object.values(ACCESS_ACTIONS)) if (a.role === 'admin') expect(a.scope).toBeNull();
  });

  /**
   * The table is read by the guard on every request and by the route walk;
   * a write to one row anywhere would change both for the life of the
   * process. `Readonly<Record<…>>` only stops a row being REPLACED, so the
   * rows carry their own `readonly`. A compile-time claim: `pnpm typecheck`
   * reports an unused `@ts-expect-error` (TS2578) the day a row's fields can
   * be assigned again. The function is never called, so nothing is mutated.
   */
  it('keeps every row read-only, not only the table', () => {
    const assignToARow = (): void => {
      // @ts-expect-error -- a row's role is readonly
      ACCESS_ACTIONS['project:read'].role = 'manager';
    };
    expect(typeof assignToARow).toBe('function');
  });
});

describe('ProjectSummarySchema.role', () => {
  const summary = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'checkout',
    name: 'Checkout',
    latestRun: null,
  };

  it('reads a project summary with a role, a null role, and none at all', () => {
    expect(ProjectSummarySchema.parse({ ...summary, role: 'member' }).role).toBe('member');
    // null is an admin who holds no membership in this project; absent is a
    // response from a pod that predates the field, which must still parse.
    expect(ProjectSummarySchema.parse({ ...summary, role: null }).role).toBeNull();
    expect(ProjectSummarySchema.parse(summary).role).toBeUndefined();
    expect(ProjectSummarySchema.safeParse({ ...summary, role: 'owner' }).success).toBe(false);
  });
});
