import { describe, expect, it } from 'vitest';
import { visibilityClause } from '../src/repositories/tenant.js';

/**
 * The one clause every org-wide read filters through. Its two answers mean
 * opposite things, so each is asserted with what it leaves in `params`: a
 * clause whose placeholder names a parameter that was never pushed binds the
 * wrong value, and a parameter pushed with no clause shifts every later one.
 */
describe('visibilityClause', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';

  it('narrows nothing for a scope that names no projects (an admin, or a token)', () => {
    const params: unknown[] = [orgId];
    expect(visibilityClause({ orgId }, 'p.project_id', params)).toBeNull();
    expect(params).toEqual([orgId]);
  });

  it('matches the listed projects, numbering its placeholder after the params already bound', () => {
    const params: unknown[] = [orgId];
    expect(visibilityClause({ orgId, projectIds: ['a'] }, 'p.project_id', params)).toBe(
      'p.project_id = ANY($2::uuid[])',
    );
    expect(params).toEqual([orgId, ['a']]);
  });

  it('still returns a clause for an EMPTY list, which matches nothing and never everything', () => {
    const params: unknown[] = [orgId];
    expect(visibilityClause({ orgId, projectIds: [] }, 'r.project_id', params)).toBe(
      'r.project_id = ANY($2::uuid[])',
    );
    expect(params).toEqual([orgId, []]);
  });
});
