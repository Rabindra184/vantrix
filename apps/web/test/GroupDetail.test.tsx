import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { groupRow } from '../src/routes/GroupDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof groupRow>[0];

describe('groupRow', () => {
  it('distinguishes the two families under one name', () => {
    const c = groupRow(stats, 'Cart', 'group_cumulated')!;
    const d = groupRow(stats, 'Cart', 'group_duration')!;

    // THE discriminating assertion: a lookup matching only (scope, name)
    // returns the same row twice and this fails.
    expect(c.meanMs).not.toBe(d.meanMs);
    expect(c.family).toBe('group_cumulated');
    expect(d.family).toBe('group_duration');
  });

  it('does not match a request of the same name', () => {
    // `Catalog` is a group; a request could plausibly be called that too.
    expect(groupRow(stats, 'Catalog', 'response_time')).toBeUndefined();
  });

  it('finds a nested group by its full path', () => {
    const row = groupRow(stats, 'Catalog/Recommendations', 'group_cumulated');
    expect(row?.name).toBe('Catalog/Recommendations');
  });

  it('is undefined for a name the run never recorded', () => {
    expect(groupRow(stats, 'Nope', 'group_cumulated')).toBeUndefined();
  });
});
