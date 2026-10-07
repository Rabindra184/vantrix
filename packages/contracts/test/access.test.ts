import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTIONS,
  PROJECT_ROLES,
  ProjectSummarySchema,
  TOKEN_SCOPES,
  roleSatisfies,
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
