import { describe, expect, it } from 'vitest';
import {
  AddMemberRequestSchema,
  MemberListResponseSchema,
  PROJECT_ROLES,
  ProjectMemberSchema,
  UpdateMemberRequestSchema,
} from '../src/index.js';

/** Roles a project row must never hold: `admin` is an ACCOUNT flag, not a
 *  membership, and the rest are near-misses a hand-written client sends. */
const NOT_ROLES = ['admin', 'owner', 'Viewer', 'MEMBER', ''];

const MEMBER = {
  userId: 'u_1',
  name: 'Asha',
  email: 'asha@example.test',
  role: 'member',
  addedAt: '2026-10-07T09:00:00.000Z',
};

describe('ProjectMemberSchema', () => {
  it('parses a member and a list of them', () => {
    expect(ProjectMemberSchema.parse(MEMBER)).toEqual(MEMBER);
    expect(MemberListResponseSchema.parse({ members: [MEMBER] })).toEqual({ members: [MEMBER] });
  });

  it('accepts exactly the project roles', () => {
    for (const role of PROJECT_ROLES) {
      expect(ProjectMemberSchema.safeParse({ ...MEMBER, role }).success, role).toBe(true);
    }
    for (const role of NOT_ROLES) {
      expect(ProjectMemberSchema.safeParse({ ...MEMBER, role }).success, role).toBe(false);
    }
  });
});

describe('AddMemberRequestSchema', () => {
  it('accepts an existing user and a role, trimming the id', () => {
    expect(AddMemberRequestSchema.parse({ userId: '  u_1 ', role: 'viewer' })).toEqual({
      userId: 'u_1',
      role: 'viewer',
    });
  });

  it('refuses a missing or blank user id', () => {
    expect(AddMemberRequestSchema.safeParse({ role: 'viewer' }).success).toBe(false);
    expect(AddMemberRequestSchema.safeParse({ userId: '   ', role: 'viewer' }).success).toBe(false);
  });

  it('accepts exactly the project roles', () => {
    for (const role of PROJECT_ROLES) {
      expect(AddMemberRequestSchema.safeParse({ userId: 'u_1', role }).success, role).toBe(true);
    }
    for (const role of NOT_ROLES) {
      expect(AddMemberRequestSchema.safeParse({ userId: 'u_1', role }).success, role).toBe(false);
    }
  });

  /** No `projectSlug` in the body: the URL names the project, and a body that
   *  could name a second one is a request that means two things. */
  it('refuses a field it does not know', () => {
    expect(
      AddMemberRequestSchema.safeParse({ userId: 'u_1', role: 'viewer', projectSlug: 'checkout' }).success,
    ).toBe(false);
  });
});

describe('UpdateMemberRequestSchema', () => {
  it('accepts exactly the project roles', () => {
    for (const role of PROJECT_ROLES) {
      expect(UpdateMemberRequestSchema.safeParse({ role }).success, role).toBe(true);
    }
    for (const role of NOT_ROLES) {
      expect(UpdateMemberRequestSchema.safeParse({ role }).success, role).toBe(false);
    }
  });

  it('requires the role', () => {
    expect(UpdateMemberRequestSchema.safeParse({}).success).toBe(false);
  });

  /** The user is named by the URL; a body that could name another would be
   *  a request that means two things. */
  it('refuses a field it does not know', () => {
    expect(UpdateMemberRequestSchema.safeParse({ role: 'viewer', userId: 'u_2' }).success).toBe(false);
  });
});
