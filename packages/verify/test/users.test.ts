import { readFileSync } from 'node:fs';
import type { CanonicalEvent, UserEvent } from '@perfportal/core';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import { compare, expectedFrom, optionsFrom, type Expected, type Stored, type VerifyOptions } from '../src/index.js';

/**
 * `run_user_bucket`, recomputed. Each case writes its buckets out by hand from
 * the events it builds: which second each event falls in, and the concurrency
 * standing before and after it.
 */

const RUN_START = 1_700_000_000_000;

function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return { ...optionsFrom({}, RUN_START), ...over };
}

function start(scenario: string, off: number): UserEvent {
  return { type: 'user', scenario, userId: 'u', kind: 'start', tsMs: RUN_START + off };
}

function end(scenario: string, off: number): UserEvent {
  return { type: 'user', scenario, userId: 'u', kind: 'end', tsMs: RUN_START + off };
}

/** One scenario's buckets as `[offset, started, ended, maxConcurrent]`. */
function usersOf(e: Expected, scenario: string): [number, number, number, number][] {
  return e.users
    .filter((b) => b.scenario === scenario)
    .map((b): [number, number, number, number] => [b.startOffsetMs, b.started, b.ended, b.maxConcurrent])
    .sort((a, b) => a[0] - b[0]);
}

describe('run_user_bucket rows', () => {
  it('walks events in time order, a start before an end at the same millisecond', () => {
    /*
     * Given out of order. Sorted: start@100, then at 1500 the start before the end.
     *   bucket 0:    created at concurrency 0; start → 1; peak 1
     *   bucket 1000: created at 1; start → 2 (peak 2); end → 1
     * Ends first at 1500 would go 1 → 0 → 1 and leave that bucket's peak at 1.
     */
    const e = expectedFrom([end('S', 1500), start('S', 1500), start('S', 100)], opts());
    expect(usersOf(e, 'S')).toEqual([
      [0, 1, 0, 1],
      [1000, 1, 1, 2],
    ]);
  });

  it('starts a bucket at the concurrency standing when it is created, and keeps its peak', () => {
    // bucket 0: two starts, peak 2. bucket 1000: created at 2, two ends → 0; peak stays 2.
    const e = expectedFrom([start('S', 0), start('S', 10), end('S', 1100), end('S', 1200)], opts());
    expect(usersOf(e, 'S')).toEqual([
      [0, 2, 0, 2],
      [1000, 0, 2, 2],
    ]);
  });

  it('fills every empty second between the first and last with the standing concurrency', () => {
    // bucket 0: two starts (standing 2 after it); seconds 1 and 2 empty; bucket 3000: one end.
    const e = expectedFrom([start('S', 100), start('S', 200), end('S', 3500)], opts());
    expect(usersOf(e, 'S')).toEqual([
      [0, 2, 0, 2],
      [1000, 0, 0, 2],
      [2000, 0, 0, 2],
      [3000, 0, 1, 2],
    ]);
  });

  it('coalesces above 1200 buckets: width doubles, counts sum, max_concurrent is a max', () => {
    /*
     * Seconds 0 .. 1200 are 1201 buckets after gap-filling: one too many, so
     * the width doubles once to 2000 and index i joins i/2 — 601 buckets.
     *   second 0:    start@0 → peak 1           second 1: start@1500 (peak 2), end@1600 → 1
     *   seconds 2..1199: empty, standing 1      second 1200: created at 1, end@1_200_500 → 0
     *   → 0: started 2, ended 1, max(1, 2) = 2  (a sum would say 3)
     *   → 1..599 (×2000): 0, 0, 1             → 600 (offset 1_200_000): 0, 1, 1
     */
    const e = expectedFrom([start('S', 0), start('S', 1500), end('S', 1600), end('S', 1_200_500)], opts());
    const got = usersOf(e, 'S');
    expect(got.length).toBe(601);
    expect(got[0]).toEqual([0, 2, 1, 2]);
    expect(got[1]).toEqual([2000, 0, 0, 1]);
    expect(got[599]).toEqual([1_198_000, 0, 0, 1]);
    expect(got[600]).toEqual([1_200_000, 0, 1, 1]);
    expect(got.every(([off], i) => off === i * 2000)).toBe(true);
  });

  it('keeps 1200 buckets at a width of one second', () => {
    const e = expectedFrom([start('S', 0), end('S', 1_199_500)], opts());
    const got = usersOf(e, 'S');
    expect(got.length).toBe(1200);
    expect(got[1199]).toEqual([1_199_000, 0, 1, 1]);
  });

  it('keeps each scenario’s concurrency and buckets apart', () => {
    const e = expectedFrom([start('A', 0), start('B', 100), start('A', 200), end('B', 2100)], opts());
    expect(usersOf(e, 'A')).toEqual([[0, 2, 0, 2]]);
    expect(usersOf(e, 'B')).toEqual([
      [0, 1, 0, 1],
      [1000, 0, 0, 1],
      [2000, 0, 1, 1],
    ]);
  });

  it('includes warm-up, and places a user before the run start at a negative offset', () => {
    const e = expectedFrom([start('S', -500), end('S', 600)], opts({ warmupMs: 10_000 }));
    expect(usersOf(e, 'S')).toEqual([
      [-1000, 1, 0, 1],
      [0, 0, 1, 1],
    ]);
  });

  it('has no user buckets without user events', () => {
    const none: CanonicalEvent[] = [];
    expect(expectedFrom(none, opts()).users).toEqual([]);
  });
});

describe('users on the reference fixture', () => {
  it('starts and ends every user event exactly once, per scenario', () => {
    const events = [...parseSimulationLog(readFileSync('fixtures/gatling-3.15.1.2/reference-report/simulation.log'))];
    const meta = events.find((x) => x.type === 'meta')!;
    const e = expectedFrom(events, optionsFrom({}, meta.startedAtMs));
    const want = new Map<string, [number, number]>();
    for (const x of events) {
      if (x.type !== 'user') continue;
      const [s, n] = want.get(x.scenario) ?? [0, 0];
      want.set(x.scenario, x.kind === 'start' ? [s + 1, n] : [s, n + 1]);
    }
    const got = new Map<string, [number, number]>();
    for (const b of e.users) {
      const [s, n] = got.get(b.scenario) ?? [0, 0];
      got.set(b.scenario, [s + b.started, n + b.ended]);
    }
    expect(want.size).toBeGreaterThan(0);
    expect(got).toEqual(want);
  });
});

/** A stored copy of what the verifier expects: the shape a faithful engine writes. */
function storedFrom(e: Expected): Stored {
  return structuredClone({ stats: e.stats, series: e.series, errors: e.errors, errorBuckets: e.errorBuckets, users: e.users, run: e.run });
}

describe('compare: user buckets', () => {
  const expected = expectedFrom([start('S', 100), start('S', 200), end('S', 3500), start('T', 0)], opts());

  function corrupt(mutate: (s: Stored) => void): ReturnType<typeof compare> {
    const stored = storedFrom(expected);
    mutate(stored);
    return compare(expected, stored);
  }

  it('finds nothing wrong with a faithful copy, and counts three figures per bucket', () => {
    const r = compare(expected, storedFrom(expected));
    expect(r.mismatches).toEqual([]);
    const without = compare({ ...expected, users: [] }, { ...storedFrom(expected), users: [] }).figuresChecked;
    expect(expected.users.length).toBe(5);
    expect(r.figuresChecked).toBe(without + 3 * 5);
  });

  it('reports one mismatch for a corrupted max_concurrent, at its scenario and bucket', () => {
    const r = corrupt((s) => { s.users.find((b) => b.scenario === 'S' && b.startOffsetMs === 2000)!.maxConcurrent = 7; });
    expect(r.mismatches).toEqual([
      { scope: 'scenario', name: 'S', family: '', population: null, bucket: 2000, table: 'run_user_bucket', figure: 'max_concurrent', stored: 7, recomputed: 2 },
    ]);
  });

  it('reports a corrupted started and ended each by name', () => {
    const r = corrupt((s) => {
      const b = s.users.find((x) => x.scenario === 'T')!;
      b.started = 0;
      b.ended = 1;
    });
    expect(r.mismatches.map((m) => [m.name, m.figure, m.stored, m.recomputed])).toEqual([
      ['T', 'started', 0, 1],
      ['T', 'ended', 1, 0],
    ]);
  });

  it('reports a bucket on one side only as one row', () => {
    const missing = corrupt((s) => { s.users = s.users.filter((b) => !(b.scenario === 'S' && b.startOffsetMs === 1000)); });
    expect(missing.mismatches).toEqual([
      { scope: 'scenario', name: 'S', family: '', population: null, bucket: 1000, table: 'run_user_bucket', figure: 'row', stored: null, recomputed: 2 },
    ]);
  });
});
