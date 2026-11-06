import { requestsInGroup, type StatRow, type StatsResponse, type UsersResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { narrowStats, narrowUsers } from '../src/routes/report/narrow';
import fixture from './fixtures/reference-run.json';

/**
 * ═══ WHAT THE REPORT TAKES FROM /stats AND /users UNDER A PICK ═══
 * (the Report pickers spec, sections 4 and 5)
 *
 * Every figure the Requests section draws from `/stats` is additive — counts
 * and the indicator bands — so a group's is the sum of its members' rows, and
 * Virtual users already carries one series per scenario. Both are narrowed in
 * the browser. Every expectation below is computed from the captured payload.
 */

const stats = fixture.stats as StatsResponse;
const users = fixture.users as UsersResponse;

const requestNames = stats.stats.filter((r) => r.scope === 'request' && r.family === 'response_time').map((r) => r.name);
const groupNames = [...new Set(stats.stats.filter((r) => r.scope === 'group').map((r) => r.name))];
const membersOf = (group: string) => requestsInGroup(requestNames, groupNames, group);

const BANDS = ['under', 'between', 'over', 'failed'] as const;
const bandsOf = (rows: readonly StatRow[]) =>
  Object.fromEntries(BANDS.map((b) => [b, rows.reduce((sum, r) => sum + r.indicators[b], 0)]));
const rowsNamed = (names: readonly string[]) =>
  stats.stats.filter((r) => r.scope === 'request' && r.family === 'response_time' && names.includes(r.name));

describe('narrowStats', () => {
  it('keeps the members’ request rows and the group rows on their paths', () => {
    for (const group of ['Cart', 'Catalog', '']) {
      const members = membersOf(group);
      // A pick of one request would prove nothing about a group.
      expect(members.length, group).toBeGreaterThan(1);
      const narrowed = narrowStats(stats, members);

      expect(narrowed.stats.filter((r) => r.scope === 'request').map((r) => r.name), group).toEqual(members);
      const onPath = groupNames.filter((g) => members.some((m) => m.startsWith(`${g}/`)));
      // Both of a group's rows (cumulated and duration), in payload order.
      expect(narrowed.stats.filter((r) => r.scope === 'group'), group).toEqual(
        stats.stats.filter((r) => r.scope === 'group' && onPath.includes(r.name)),
      );
    }
    // Catalog's subtree carries its subgroup; (no group) carries no group at all.
    expect(narrowStats(stats, membersOf('Catalog')).stats.some((r) => r.name === 'Catalog/Recommendations')).toBe(true);
    expect(narrowStats(stats, membersOf('')).stats.some((r) => r.scope === 'group')).toBe(false);
  });

  it('drops the run row', () => {
    // The premise: the payload has one to drop.
    expect(stats.stats.some((r) => r.scope === 'run')).toBe(true);
    for (const group of ['Cart', 'Catalog', '']) {
      expect(narrowStats(stats, membersOf(group)).stats.some((r) => r.scope === 'run'), group).toBe(false);
    }
  });

  it('sums the members’ bands into the response’s indicators', () => {
    const members = membersOf('Cart');
    const expected = bandsOf(rowsNamed(members));
    // A sum over every request is the run's own bands; the case must be able
    // to tell the two apart, or it proves nothing about WHICH rows were added.
    expect(expected).not.toEqual(bandsOf(rowsNamed(requestNames)));
    expect(narrowStats(stats, members).indicators).toEqual(expected);
  });

  it('answers one request’s own bands for a request pick', () => {
    const [request] = membersOf('Cart');
    expect(narrowStats(stats, [request!]).indicators).toEqual(bandsOf(rowsNamed([request!])));
  });

  it('keeps what belongs to the response rather than to a row', () => {
    const narrowed = narrowStats(stats, membersOf('Cart'));
    expect([narrowed.runId, narrowed.bounds, narrowed.configurable, narrowed.window]).toEqual([
      stats.runId,
      stats.bounds,
      stats.configurable,
      stats.window,
    ]);
  });

  it('answers nothing for no names, and leaves the payload it was given alone', () => {
    const before = structuredClone(stats);
    const narrowed = narrowStats(stats, []);
    expect(narrowed.stats).toEqual([]);
    expect(narrowed.indicators).toEqual({ under: 0, between: 0, over: 0, failed: 0 });
    narrowStats(stats, membersOf('Catalog'));
    expect(stats).toEqual(before);
  });

  /**
   * Two rules the reference run cannot exercise: its group names share no
   * prefix with a top-level request, and every request row is response_time.
   * A synthetic payload built from its own rows gives both something to get
   * wrong.
   */
  it('matches a group by its whole path segment, and sums only response_time bands', () => {
    const request = rowsNamed(membersOf('Cart'))[0]!;
    const group = stats.stats.find((r) => r.scope === 'group' && r.name === 'Cart')!;
    const row = (over: Partial<StatRow>): StatRow => ({ ...request, ...over });
    const bands = { under: 1, between: 2, over: 3, failed: 4 };
    const synthetic: StatsResponse = {
      ...stats,
      stats: [
        { ...group },
        row({ name: 'Cartoon/x', indicators: bands }),
        // The same request again under another family: present, but not summed.
        row({ name: 'Cartoon/x', family: 'latency' as StatRow['family'], indicators: { under: 100, between: 100, over: 100, failed: 100 } }),
      ],
    };

    const narrowed = narrowStats(synthetic, ['Cartoon/x']);

    // 'Cartoon/x' does not sit inside 'Cart': a bare prefix match would bring it.
    expect(narrowed.stats.some((r) => r.scope === 'group')).toBe(false);
    expect(narrowed.stats.filter((r) => r.name === 'Cartoon/x')).toHaveLength(2);
    expect(narrowed.indicators).toEqual(bands);
  });
});

describe('narrowUsers', () => {
  const browse = users.scenarios.find((s) => s.scenario === 'Browse');

  it('keeps one scenario, and its total is that scenario’s own buckets', () => {
    // The premise: another scenario contributes to the run's total.
    expect(browse).toBeDefined();
    expect(users.scenarios.length).toBeGreaterThan(1);
    expect(users.total).not.toEqual(browse!.buckets);

    const narrowed = narrowUsers(users, 'Browse');
    expect(narrowed.scenarios).toEqual([browse]);
    expect(narrowed.total).toEqual(browse!.buckets);
    expect([narrowed.runId, narrowed.window]).toEqual([users.runId, users.window]);
  });

  it('answers nothing for a scenario the run does not have', () => {
    const narrowed = narrowUsers(users, 'Nope');
    expect([narrowed.scenarios, narrowed.total]).toEqual([[], []]);
  });
});
