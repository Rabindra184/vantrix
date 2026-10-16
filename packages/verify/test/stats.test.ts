import { readFileSync } from 'node:fs';
import type { CanonicalEvent, GroupEvent, RequestEvent } from '@perfportal/core';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import {
  VERIFIER_VERSION,
  compare,
  expectedFrom,
  optionsFrom,
  type Expected,
  type ExpectedStat,
  type Stored,
  type VerifyOptions,
} from '../src/index.js';

/**
 * Every expectation here is computed in the test from the events it built —
 * a mean is summed and divided, a window is subtracted — never copied from
 * the verifier's own output. The verifier has to be checked by something
 * other than itself, the same way it exists to check the engine.
 */

const RUN_START = 1_700_000_000_000;

function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return { ...optionsFrom({}, RUN_START), ...over };
}

function req(name: string, startOff: number, endOff: number, ok = true, groups: string[] = []): RequestEvent {
  return { type: 'request', name, groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, ok };
}

function grp(groups: string[], startOff: number, endOff: number, cumulated: number, ok = true): GroupEvent {
  return { type: 'group', groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, cumulatedResponseTimeMs: cumulated, ok };
}

function row(e: Expected, scope: string, name: string, family: string): ExpectedStat | undefined {
  return e.stats.find((s) => s.scope === scope && s.name === name && s.family === family);
}

function describeValues(values: number[]): { min: number; max: number; mean: number; stddev: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return { min: Math.min(...values), max: Math.max(...values), mean, stddev: Math.sqrt(variance) };
}

describe('optionsFrom', () => {
  it('fills every knob a run did not freeze with the engine default', () => {
    expect(optionsFrom({}, RUN_START)).toEqual({
      runStartMs: RUN_START,
      warmupMs: 0,
      percentiles: [50, 75, 95, 99],
      maxBucketsRun: 1200,
      maxBucketsEndpoint: 300,
    });
  });

  it('reads the frozen knobs, and ignores a value of the wrong shape', () => {
    expect(
      optionsFrom({ warmupMs: 5000, percentiles: [90, 99.9], maxBucketsRun: 600, maxBucketsEndpoint: 'x' }, RUN_START),
    ).toEqual({ runStartMs: RUN_START, warmupMs: 5000, percentiles: [90, 99.9], maxBucketsRun: 600, maxBucketsEndpoint: 300 });
  });

  it('has a version the worker records beside each verification', () => {
    expect(Number.isInteger(VERIFIER_VERSION)).toBe(true);
  });
});

describe('expectedFrom: run_stat rows', () => {
  it('computes every figure of a row from its observations', () => {
    const events: CanonicalEvent[] = [
      req('A', 0, 10),
      req('A', 100, 120, false),
      req('A', 200, 230),
      req('A', 300, 340, false),
    ];
    const e = expectedFrom(events, opts());
    const values = [10, 20, 30, 40];
    const d = describeValues(values);
    const windowMs = RUN_START + 340 - (RUN_START + 0);
    const r = row(e, 'run', '', 'response_time')!;
    expect(r).toEqual({
      scope: 'run', name: '', family: 'response_time',
      count: 4, okCount: 2, koCount: 2, errorRate: 2 / 4,
      minMs: d.min, maxMs: d.max, meanMs: d.mean, stddevMs: d.stddev,
      throughputRps: (4 / windowMs) * 1000,
      // nearest rank over 4 sorted values: ceil(p*4/100)-th
      percentiles: { p50: 20, p75: 30, p95: 40, p99: 40 },
    });
    expect(row(e, 'request', 'A', 'response_time')).toEqual({ ...r, scope: 'request', name: 'A' });
  });

  it('joins a request’s groups and name into its path', () => {
    const e = expectedFrom([req('Add', 0, 10, true, ['Cart', 'Inner']), req('Home', 0, 5)], opts());
    expect(e.stats.filter((s) => s.scope === 'request').map((s) => s.name).sort()).toEqual(['Cart/Inner/Add', 'Home']);
  });

  it('files a group under both families, cumulated and duration', () => {
    const e = expectedFrom([req('A', 0, 10), grp(['Cart', 'Inner'], 0, 80, 30, false)], opts());
    const cum = row(e, 'group', 'Cart/Inner', 'group_cumulated')!;
    const dur = row(e, 'group', 'Cart/Inner', 'group_duration')!;
    expect([cum.minMs, cum.count, cum.koCount]).toEqual([30, 1, 1]);
    expect([dur.minMs, dur.count, dur.koCount]).toEqual([80, 1, 1]);
    // no request row and no run row for a group
    expect(e.stats.filter((s) => s.scope !== 'group').map((s) => s.name).sort()).toEqual(['', 'A']);
  });

  it('clamps a negative value to 0 and rounds a fractional one', () => {
    const e = expectedFrom([req('A', 50, 40), grp(['G'], 0, 10, -3), grp(['H'], 0, 10, 12.5)], opts());
    expect(row(e, 'request', 'A', 'response_time')!.maxMs).toBe(0);
    expect(row(e, 'group', 'G', 'group_cumulated')!.maxMs).toBe(0);
    expect(row(e, 'group', 'H', 'group_cumulated')!.maxMs).toBe(Math.round(12.5));
  });

  it('spells a fractional percentile key the way the engine stores it', () => {
    const e = expectedFrom([req('A', 0, 10), req('A', 0, 20)], opts({ percentiles: [50, 99.9] }));
    expect(Object.keys(row(e, 'run', '', 'response_time')!.percentiles)).toEqual(['p50', 'p99.9']);
  });

  /**
   * Warm-up is EXCLUDED from the rows and INCLUDED in the span: a request that
   * started in warm-up still moves the last end, and the window is anchored at
   * the END OF WARM-UP — not at the first request that started after it. One
   * case per claim, so each mutation lands on its own.
   */
  const warmupMs = 5000;
  const warmupEvents: CanonicalEvent[] = [
    req('Warm', 1000, 30_000), // warm-up, and the last end of the run
    req('A', 6000, 6100),
    req('A', 9000, 9300, false),
  ];

  it('excludes warm-up observations from every row, and drops a row that had only warm-up', () => {
    const e = expectedFrom(warmupEvents, opts({ warmupMs }));
    const r = row(e, 'run', '', 'response_time')!;
    expect([r.count, r.okCount, r.koCount]).toEqual([2, 1, 1]);
    expect(row(e, 'request', 'Warm', 'response_time')).toBeUndefined();
  });

  it('anchors the window at the end of warm-up, with warm-up still moving the last end', () => {
    const e = expectedFrom(warmupEvents, opts({ warmupMs }));
    const lastMs = RUN_START + 30_000;
    const firstMs = RUN_START + 1000;
    const windowMs = lastMs - Math.max(firstMs, RUN_START + warmupMs);
    const r = row(e, 'run', '', 'response_time')!;
    expect(r.throughputRps).toBe((r.count / windowMs) * 1000);
    expect(e.run).toEqual({ durationMs: lastMs - RUN_START, activityMs: windowMs });
  });

  it('anchors the window at the first request when that is later than warm-up', () => {
    const e = expectedFrom([req('A', 8000, 9000), req('A', 8500, 12_000)], opts({ warmupMs: 5000 }));
    const windowMs = RUN_START + 12_000 - (RUN_START + 8000);
    expect(e.run.activityMs).toBe(windowMs);
    expect(row(e, 'run', '', 'response_time')!.throughputRps).toBe((2 / windowMs) * 1000);
  });

  it('gives group rows the requests’ window, which groups never move', () => {
    const events: CanonicalEvent[] = [
      grp(['G'], -500, 99_000, 40), // starts before and ends after every request
      req('A', 1000, 2000),
      req('A', 3000, 4000),
    ];
    const e = expectedFrom(events, opts());
    const windowMs = RUN_START + 4000 - (RUN_START + 1000);
    expect(e.run).toEqual({ durationMs: 4000, activityMs: windowMs });
    expect(row(e, 'group', 'G', 'group_duration')!.throughputRps).toBe((1 / windowMs) * 1000);
    expect(row(e, 'group', 'G', 'group_cumulated')!.throughputRps).toBe((1 / windowMs) * 1000);
  });

  it('ignores user and error records in run_stat', () => {
    const base = [req('A', 0, 10)];
    const noisy: CanonicalEvent[] = [
      ...base,
      { type: 'user', scenario: 's', userId: 'u', kind: 'start', tsMs: RUN_START - 99_000 },
      { type: 'error', message: 'boom', tsMs: RUN_START + 99_000 },
    ];
    expect(expectedFrom(noisy, opts())).toEqual(expectedFrom(base, opts()));
  });

  it('has no rows and zero spans for a run with no requests', () => {
    expect(expectedFrom([], opts())).toEqual({ stats: [], run: { durationMs: 0, activityMs: 0 } });
  });
});

describe('expectedFrom on the reference fixture', () => {
  const events = [...parseSimulationLog(readFileSync('fixtures/gatling-3.15.1.2/reference-report/simulation.log'))];
  const meta = events.find((e) => e.type === 'meta')!;
  const requests = events.filter((e): e is RequestEvent => e.type === 'request');
  const e = expectedFrom(events, optionsFrom({}, meta.startedAtMs));

  it('counts the run row exactly as the log’s own request records count', () => {
    const r = row(e, 'run', '', 'response_time')!;
    const ok = requests.filter((q) => q.ok).length;
    expect([r.count, r.okCount, r.koCount]).toEqual([requests.length, ok, requests.length - ok]);
    expect(r.maxMs).toBe(Math.max(...requests.map((q) => q.endMs - q.startMs)));
  });

  it('has one request row per path, each with its own count', () => {
    const byPath = new Map<string, number>();
    for (const q of requests) {
      const path = [...q.groups, q.name].join('/');
      byPath.set(path, (byPath.get(path) ?? 0) + 1);
    }
    const got = new Map(e.stats.filter((s) => s.scope === 'request').map((s) => [s.name, s.count]));
    expect(got).toEqual(byPath);
  });
});

/** A stored copy of what the verifier expects: the shape a faithful engine writes. */
function storedFrom(e: Expected): Stored {
  return structuredClone({ stats: e.stats, run: e.run });
}

describe('compare', () => {
  const events: CanonicalEvent[] = [
    req('A', 0, 10),
    req('A', 100, 120, false),
    req('B', 200, 230, true, ['G']),
    grp(['G'], 200, 240, 30),
  ];
  const expected = expectedFrom(events, opts());

  it('finds nothing wrong with a faithful copy, and counts every figure it checked', () => {
    const r = compare(expected, storedFrom(expected));
    expect(r.mismatches).toEqual([]);
    // 9 scalar figures plus each percentile, per row, plus the run's two spans
    const want = expected.stats.reduce((n, s) => n + 9 + Object.keys(s.percentiles).length, 0) + 2;
    expect(r.figuresChecked).toBe(want);
  });

  function corrupt(mutate: (s: Stored) => void): ReturnType<typeof compare> {
    const stored = storedFrom(expected);
    mutate(stored);
    return compare(expected, stored);
  }

  const runRow = (s: Stored) => s.stats.find((x) => x.scope === 'run')!;
  const runExpected = row(expected, 'run', '', 'response_time')!;

  it('reports one mismatch for a corrupted count', () => {
    const r = corrupt((s) => { runRow(s).count += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: null, bucket: null, table: 'run_stat', figure: 'count', stored: runExpected.count + 1, recomputed: runExpected.count },
    ]);
  });

  it('reports one mismatch for a corrupted percentile', () => {
    const r = corrupt((s) => { runRow(s).percentiles.p95! += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: 'all', bucket: null, table: 'run_stat', figure: 'p95', stored: runExpected.percentiles.p95! + 1, recomputed: runExpected.percentiles.p95! },
    ]);
  });

  it('reports a mean off by more than 1e-9 relative, and forgives one within it', () => {
    const off = corrupt((s) => { runRow(s).meanMs *= 1 + 1e-7; });
    expect(off.mismatches.map((m) => [m.table, m.figure, m.population])).toEqual([['run_stat', 'mean_ms', 'all']]);
    expect(corrupt((s) => { runRow(s).meanMs *= 1 + 1e-12; }).mismatches).toEqual([]);
  });

  it('compares a zero-expected float absolutely', () => {
    const okRow = (s: Stored) => s.stats.find((x) => x.scope === 'request' && x.name === 'G/B')!;
    expect(row(expected, 'request', 'G/B', 'response_time')!.errorRate).toBe(0);
    expect(corrupt((s) => { okRow(s).errorRate = 1e-12; }).mismatches).toEqual([]);
    expect(corrupt((s) => { okRow(s).errorRate = 1e-6; }).mismatches.map((m) => m.figure)).toEqual(['error_rate']);
  });

  it('reports a missing row once, as a row', () => {
    const r = corrupt((s) => { s.stats = s.stats.filter((x) => !(x.scope === 'group' && x.family === 'group_duration')); });
    expect(r.mismatches).toEqual([
      { scope: 'group', name: 'G', family: 'group_duration', population: null, bucket: null, table: 'run_stat', figure: 'row', stored: null, recomputed: 1 },
    ]);
  });

  it('reports an extra row once, as a row', () => {
    const r = corrupt((s) => { s.stats.push({ ...runRow(s), scope: 'request', name: 'Ghost', count: 7 }); });
    expect(r.mismatches).toEqual([
      { scope: 'request', name: 'Ghost', family: 'response_time', population: null, bucket: null, table: 'run_stat', figure: 'row', stored: 7, recomputed: null },
    ]);
  });

  it('reports a corrupted run span against the run table', () => {
    const r = corrupt((s) => { s.run.activityMs += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'run', name: '', family: '', population: null, bucket: null, table: 'run', figure: 'activity_ms', stored: expected.run.activityMs + 1, recomputed: expected.run.activityMs },
    ]);
  });
});
