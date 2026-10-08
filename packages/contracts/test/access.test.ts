import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTIONS,
  PROJECT_ROLES,
  ProjectSummarySchema,
  TOKEN_SCOPES,
  accessRefusal,
  canPerform,
  roleSatisfies,
  type AccessAction,
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

const EVERY_ACTION = Object.keys(ACCESS_ACTIONS) as AccessAction[];

/** Every role a session can carry for one project: a row's role, an admin with no row (`null`), and not loaded yet. */
const EVERY_HELD: ReadonlyArray<ProjectRole | null | undefined> = [...PROJECT_ROLES, null, undefined];

/**
 * ═══ ONE RULE, ASKED BY BOTH SIDES ═══
 *
 * The API's guard and the web's controls ask the same question of the same
 * table, so a control is drawn exactly when the request behind it would be
 * let through. The expectations are read off each row: the roles at or above
 * its role meet it, an admin row is met by the admin flag alone, and the flag
 * meets everything — whatever role the admin happens to hold in the project.
 */
describe('canPerform', () => {
  for (const action of EVERY_ACTION) {
    const { role: required } = ACCESS_ACTIONS[action];
    const meets: ReadonlyArray<ProjectRole> =
      required === 'admin' ? [] : PROJECT_ROLES.slice(PROJECT_ROLES.indexOf(required));

    it(`${action}: an admin, holding any role or none`, () => {
      for (const role of EVERY_HELD) {
        expect(canPerform(action, { isAdmin: true, role }), String(role)).toBe(true);
      }
    });

    it(`${action}: a non-admin meets it exactly with ${meets.length === 0 ? 'no role' : meets.join(', ')}`, () => {
      for (const role of EVERY_HELD) {
        const expected = role !== null && role !== undefined && meets.includes(role);
        expect(canPerform(action, { isAdmin: false, role }), String(role)).toBe(expected);
      }
    });
  }

  /** Fails closed on a role read from somewhere the types do not reach, as `roleSatisfies` does. */
  it('lets a non-admin holding a role it does not know do nothing', () => {
    for (const action of EVERY_ACTION) {
      expect(canPerform(action, { isAdmin: false, role: 'owner' as ProjectRole }), action).toBe(false);
    }
  });
});

/**
 * ═══ THE REFUSAL IS THE API'S OWN SENTENCE ═══
 *
 * The guard's 403 and the web's "you cannot do this" state are built here,
 * so a reader is told the same thing whichever side refuses them. Written out
 * as literals, not rebuilt from the table: the words ARE the claim.
 */
describe('accessRefusal', () => {
  it('names the project role an action needs', () => {
    expect(accessRefusal('run:upload')).toStrictEqual({
      code: 'ROLE_REQUIRED',
      detail: 'Uploading runs needs the Member role in this project.',
      remediation: 'Ask an admin to change your role.',
    });
    expect(accessRefusal('tokens:manage').detail).toBe('Managing API tokens needs the Manager role in this project.');
    expect(accessRefusal('project:read').detail).toBe('Reading this project needs the Viewer role in this project.');
  });

  it('says an admin action needs an admin', () => {
    expect(accessRefusal('projects:create')).toStrictEqual({
      code: 'ADMIN_REQUIRED',
      detail: 'Creating projects needs an admin.',
      remediation: 'Ask an admin to do this.',
    });
  });

  it('answers ADMIN_REQUIRED exactly for the actions whose row asks for an admin', () => {
    for (const action of EVERY_ACTION) {
      expect(accessRefusal(action).code, action).toBe(
        ACCESS_ACTIONS[action].role === 'admin' ? 'ADMIN_REQUIRED' : 'ROLE_REQUIRED',
      );
    }
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
