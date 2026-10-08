import { describe, expect, it } from 'vitest';
import { isUniqueViolationOn, prismaCode, prismaMeta } from '../src/common/prisma-errors.js';

/**
 * The shapes these read are Prisma's own, as measured: a unique violation on
 * the membership's primary key arrives as
 * `{ code: 'P2002', meta: { modelName: 'ProjectMember', target: ['project_id', 'user_id'] } }`,
 * and a foreign-key violation as
 * `{ code: 'P2003', meta: { modelName: 'ProjectMember', constraint: 'project_member_user_id_fkey' } }`.
 * Plain objects, because the readers are duck-typed on purpose (a Better Auth
 * write throws from a Prisma client whose classes this app does not import).
 */
const unique = (target: unknown) => ({ code: 'P2002', meta: { modelName: 'ProjectMember', target } });
const KEY = ['project_id', 'user_id'] as const;

describe('isUniqueViolationOn', () => {
  it('matches a P2002 on exactly the columns named, in either order', () => {
    expect(isUniqueViolationOn(unique(['project_id', 'user_id']), KEY)).toBe(true);
    expect(isUniqueViolationOn(unique(['user_id', 'project_id']), KEY)).toBe(true);
  });

  /**
   * The reason it exists. A unique index added to the table later would
   * refuse an INSERT for its own reason — and a match on the code alone, or
   * on "includes the key's columns", would report that as the key's refusal
   * ("already a member"), falsely. Each of these is some other index.
   */
  it('does not match a P2002 on any other set of columns', () => {
    for (const target of [
      ['project_id', 'user_id', 'role'],
      ['user_id'],
      ['project_id'],
      ['email'],
      [],
      'project_member_pkey',
      undefined,
    ]) {
      expect(isUniqueViolationOn(unique(target), KEY), JSON.stringify(target)).toBe(false);
    }
  });

  it('matches nothing but a P2002', () => {
    for (const err of [
      { code: 'P2003', meta: { target: ['project_id', 'user_id'] } },
      { code: 'P2025' },
      new Error('Unique constraint failed'),
      null,
      undefined,
      'P2002',
    ]) {
      expect(isUniqueViolationOn(err, KEY), JSON.stringify(err)).toBe(false);
    }
  });
});

describe('prismaCode and prismaMeta', () => {
  it('read the code and the meta off a Prisma-shaped throw, and nothing off anything else', () => {
    const fk = { code: 'P2003', meta: { modelName: 'ProjectMember', constraint: 'project_member_user_id_fkey' } };
    expect([prismaCode(fk), prismaMeta(fk)]).toEqual(['P2003', fk.meta]);
    for (const err of [new Error('boom'), { code: 7, meta: 'x' }, null, undefined, 'P2003']) {
      expect([prismaCode(err), prismaMeta(err)], JSON.stringify(err)).toEqual([undefined, undefined]);
    }
  });
});
