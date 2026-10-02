import type { StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { groupRows } from '../src/routes/GroupsList';
import reference from './fixtures/reference-run.json';

const stats = reference.stats as StatsResponse;

/** The names of the payload's `group_cumulated` rows, in the order it carries them. */
const cumulatedNames = (response: StatsResponse) =>
  response.stats.filter((s) => s.scope === 'group' && s.family === 'group_cumulated').map((s) => s.name);

describe('groupRows', () => {
  it('is one row per group, joining its cumulated and its wall-clock row', () => {
    const rows = groupRows(stats);
    // The fixture has several groups, one nested — or this proves nothing.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.name.includes('/'))).toBe(true);
    expect(rows.map((r) => r.name)).toEqual(cumulatedNames(stats));
    for (const row of rows) {
      const cumulated = stats.stats.find((s) => s.scope === 'group' && s.name === row.name && s.family === 'group_cumulated')!;
      const duration = stats.stats.find((s) => s.scope === 'group' && s.name === row.name && s.family === 'group_duration')!;
      expect(row.count).toBe(cumulated.count);
      expect(row.okCount).toBe(cumulated.okCount);
      expect(row.koCount).toBe(cumulated.koCount);
      expect(row.cumulatedP95).toBe(Math.min(Math.max(cumulated.percentiles.p95!, cumulated.minMs), cumulated.maxMs));
      expect(row.durationP95).toBe(Math.min(Math.max(duration.percentiles.p95!, duration.minMs), duration.maxMs));
    }
  });

  // The fixture's groups arrive alphabetically, so a list that re-sorted them
  // would still match above. Turned round, only the payload's own order does.
  it('keeps the payload’s own order, never a sorted one', () => {
    const reversed = { ...stats, stats: [...stats.stats].reverse() };
    expect(groupRows(reversed).map((r) => r.name)).toEqual(cumulatedNames(reversed));
    expect(groupRows(reversed).map((r) => r.name)).not.toEqual(groupRows(stats).map((r) => r.name));
  });

  it('has none for a run with no groups', () => {
    expect(groupRows({ ...stats, stats: stats.stats.filter((s) => s.scope !== 'group') })).toEqual([]);
  });
});
