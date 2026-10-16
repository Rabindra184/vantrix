import { readFileSync } from 'node:fs';
import type { CanonicalEvent, GroupEvent, RequestEvent } from '@perfportal/core';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import {
  compare,
  expectedFrom,
  optionsFrom,
  type Expected,
  type ExpectedSeriesBucket,
  type Stored,
  type VerifyOptions,
} from '../src/index.js';

/**
 * `run_series_bucket`, recomputed. Every expectation is worked out here from
 * the events the case builds — offsets floored by hand, ranks counted — and
 * never read back from the verifier, and never from an engine run.
 */

const RUN_START = 1_700_000_000_000;
const FIXED = [25, 50, 75, 80, 85, 90, 95, 99] as const;

function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return { ...optionsFrom({}, RUN_START), ...over };
}

function req(name: string, startOff: number, endOff: number, ok = true, groups: string[] = []): RequestEvent {
  return { type: 'request', name, groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, ok };
}

function grp(groups: string[], startOff: number, endOff: number, cumulated: number, ok = true): GroupEvent {
  return { type: 'group', groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, cumulatedResponseTimeMs: cumulated, ok };
}

function series(e: Expected, scope: string, name: string, family: string): ExpectedSeriesBucket[] {
  return e.series.filter((b) => b.scope === scope && b.name === name && b.family === family);
}

function bucket(e: Expected, scope: string, name: string, family: string, offset: number): ExpectedSeriesBucket | undefined {
  return series(e, scope, name, family).find((b) => b.startOffsetMs === offset);
}

/** Nearest rank for an INTEGER p: the ceil(p·n/100)-th smallest. */
function ranks(values: number[]): Record<string, number> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (const p of FIXED) out[`p${p}`] = sorted[Math.max(1, Math.ceil((p * sorted.length) / 100)) - 1]!;
  return out;
}

describe('series width', () => {
  /*
   * Edges, as offsets from the run start, and their indexes at each width:
   *   req1 -1500 → -200   req2 2500 → 2600   req3 7000 → 7100   req4 9000 → 15000
   *   W=1000: -2 -1  2  2  7  7  9 15 → 6 distinct
   *   W=2000: -1 -1  1  1  3  3  4  7 → 5 distinct
   *   W=4000: -1 -1  0  0  1  1  2  3 → 5 distinct
   *   W=8000: -1 -1  0  0  0  0  1  1 → 3 distinct   ← the first ≤ 4
   * The start edges ALONE would fit at W=1000 (-2, 2, 7, 9: four indexes),
   * which is why the end edges have to count.
   */
  const events: CanonicalEvent[] = [req('A', -1500, -200), req('A', 2500, 2600), req('A', 7000, 7100), req('A', 9000, 15_000)];

  it('coalesces the run series to the smallest 1000·2^k that fits its cap, over start AND end edges', () => {
    const e = expectedFrom(events, opts({ maxBucketsRun: 4 }));
    // At W=8000 the eight edges fall in three buckets. Asserted by what each
    // bucket holds, so this case is about the WIDTH; the offsets are the next one's.
    expect(series(e, 'run', '', 'response_time').map((b) => [b.startedCount, b.endedCount])).toEqual([
      [1, 1],
      [2, 2],
      [1, 1],
    ]);
  });

  it('places each bucket at its index times the coalesced width, negative before the run start', () => {
    /*
     * Zero-length requests, so the start edges alone choose the same width:
     * -1500, 2500, 7000, 9000, 15000 are 5 distinct indexes at W=1000, 2000
     * and 4000, and 3 at W=8000 (-1, 0, 0, 1, 1). Offsets are index · 8000.
     */
    const instants = [-1500, 2500, 7000, 9000, 15_000].map((t) => req('A', t, t));
    const e = expectedFrom(instants, opts({ maxBucketsRun: 3 }));
    expect(series(e, 'run', '', 'response_time').map((b) => [b.startOffsetMs, b.startedCount])).toEqual([
      [-8000, 1],
      [0, 2],
      [8000, 2],
    ]);
  });

  it('gives a request series the endpoint cap, not the run’s', () => {
    const e = expectedFrom(events, opts({ maxBucketsRun: 1200, maxBucketsEndpoint: 4 }));
    // six distinct seconds fit 1200 at W=1000
    expect(series(e, 'run', '', 'response_time').map((b) => b.startOffsetMs)).toEqual([-2000, -1000, 2000, 7000, 9000, 15_000]);
    expect(series(e, 'request', 'A', 'response_time').map((b) => b.startOffsetMs)).toEqual([-8000, 0, 8000]);
  });

  /*
   * 151 groups, the i-th from 2000·i to 2000·i + 1000: at W=1000 that is 302
   * distinct seconds (> 300); at W=2000 both edges of group i floor to i, so
   * 151. The group cap is 300 whatever the run froze for the other caps.
   */
  const groups: CanonicalEvent[] = Array.from({ length: 151 }, (_, i) => grp(['G'], 2000 * i, 2000 * i + 1000, 7));

  it('coalesces a group series at the fixed cap of 300, for both families', () => {
    const offsets = Array.from({ length: 151 }, (_, i) => 2000 * i);
    for (const over of [{}, { maxBucketsEndpoint: 4, maxBucketsRun: 4 }, { maxBucketsEndpoint: 10_000, maxBucketsRun: 10_000 }]) {
      const e = expectedFrom(groups, opts(over));
      expect(series(e, 'group', 'G', 'group_cumulated').map((b) => b.startOffsetMs)).toEqual(offsets);
      expect(series(e, 'group', 'G', 'group_duration').map((b) => b.startOffsetMs)).toEqual(offsets);
    }
  });

  it('measures a group by its cumulated time in one family and its span in the other', () => {
    const e = expectedFrom([grp(['G', 'H'], 0, 400, 130.4, false)], opts());
    const cum = bucket(e, 'group', 'G/H', 'group_cumulated', 0)!;
    const dur = bucket(e, 'group', 'G/H', 'group_duration', 0)!;
    expect([cum.minMs, cum.startedKoCount, cum.koCount]).toEqual([Math.round(130.4), 1, 1]);
    expect([dur.minMs, dur.startedKoCount, dur.koCount]).toEqual([400, 1, 1]);
  });
});

describe('series edges and latency', () => {
  it('counts a request started at its start edge and ended at its end edge, its latency only at the start', () => {
    const e = expectedFrom([req('A', 500, 2500)], opts());
    expect(bucket(e, 'run', '', 'response_time', 0)).toEqual({
      scope: 'run', name: '', family: 'response_time', startOffsetMs: 0,
      startedCount: 1, endedCount: 0, okCount: 0, koCount: 0, startedOkCount: 1, startedKoCount: 0,
      minMs: 2000, maxMs: 2000, meanMs: 2000,
      percentiles: ranks([2000]), percentilesOk: ranks([2000]), percentilesKo: {},
    });
    expect(bucket(e, 'run', '', 'response_time', 1000)).toBeUndefined();
    expect(bucket(e, 'run', '', 'response_time', 2000)).toEqual({
      scope: 'run', name: '', family: 'response_time', startOffsetMs: 2000,
      startedCount: 0, endedCount: 1, okCount: 1, koCount: 0, startedOkCount: 0, startedKoCount: 0,
      minMs: 0, maxMs: 0, meanMs: 0,
      percentiles: {}, percentilesOk: {}, percentilesKo: {},
    });
  });

  it('takes the FIXED percentile set over all, ok and ko, whatever the run froze for run_stat', () => {
    // ten requests in second 0, durations 10..100; the odd ones failed
    const events = Array.from({ length: 10 }, (_, i) => req('A', i, i + 10 * (i + 1), i % 2 === 0));
    const e = expectedFrom(events, opts({ percentiles: [50, 99.9] }));
    const b = bucket(e, 'request', 'A', 'response_time', 0)!;
    const all = events.map((q) => q.endMs - q.startMs);
    const ok = events.filter((q) => q.ok).map((q) => q.endMs - q.startMs);
    const ko = events.filter((q) => !q.ok).map((q) => q.endMs - q.startMs);
    expect(Object.keys(b.percentiles)).toEqual(FIXED.map((p) => `p${p}`));
    expect([b.percentiles, b.percentilesOk, b.percentilesKo]).toEqual([ranks(all), ranks(ok), ranks(ko)]);
    expect([b.minMs, b.maxMs, b.meanMs]).toEqual([Math.min(...all), Math.max(...all), all.reduce((a, v) => a + v, 0) / all.length]);
    expect([b.startedCount, b.startedOkCount, b.startedKoCount, b.endedCount, b.okCount, b.koCount]).toEqual([10, 5, 5, 10, 5, 5]);
  });

  it('leaves a population with no observation empty: zeros for the extremes and mean, {} for its ranks', () => {
    const e = expectedFrom([req('A', 0, 30, false)], opts());
    const b = bucket(e, 'run', '', 'response_time', 0)!;
    expect([b.percentiles, b.percentilesOk, b.percentilesKo]).toEqual([ranks([30]), {}, ranks([30])]);
  });

  it('includes warm-up in every series, though run_stat leaves it out', () => {
    const e = expectedFrom([req('A', 1000, 1100), req('A', 7000, 7050)], opts({ warmupMs: 5000 }));
    expect(e.stats.find((s) => s.scope === 'run')!.count).toBe(1);
    expect(bucket(e, 'run', '', 'response_time', 1000)).toMatchObject({ startedCount: 1, endedCount: 1, minMs: 100 });
    expect(bucket(e, 'request', 'A', 'response_time', 1000)).toMatchObject({ startedCount: 1, endedCount: 1 });
  });

  it('clamps a negative latency to 0, while its edges stay where they fell', () => {
    const e = expectedFrom([req('A', 2500, 1500)], opts());
    expect(bucket(e, 'run', '', 'response_time', 2000)).toMatchObject({ startedCount: 1, endedCount: 0, maxMs: 0 });
    expect(bucket(e, 'run', '', 'response_time', 1000)).toMatchObject({ startedCount: 0, endedCount: 1 });
  });

  it('joins a request’s groups into its series name, and has no series without requests or groups', () => {
    const e = expectedFrom([req('Add', 0, 10, true, ['Cart'])], opts());
    expect([...new Set(e.series.map((b) => `${b.scope}:${b.name}:${b.family}`))].sort()).toEqual(['request:Cart/Add:response_time', 'run::response_time']);
    expect(expectedFrom([], opts()).series).toEqual([]);
  });
});

describe('series on the reference fixture', () => {
  const events = [...parseSimulationLog(readFileSync('fixtures/gatling-3.15.1.2/reference-report/simulation.log'))];
  const meta = events.find((e) => e.type === 'meta')!;
  const requests = events.filter((e): e is RequestEvent => e.type === 'request');
  const e = expectedFrom(events, optionsFrom({}, meta.startedAtMs));

  it('starts and ends every request exactly once in the run series', () => {
    const run = series(e, 'run', '', 'response_time');
    const ok = requests.filter((q) => q.ok).length;
    const sum = (f: (b: ExpectedSeriesBucket) => number): number => run.reduce((n, b) => n + f(b), 0);
    expect([sum((b) => b.startedCount), sum((b) => b.endedCount), sum((b) => b.okCount), sum((b) => b.startedOkCount)]).toEqual([
      requests.length,
      requests.length,
      ok,
      ok,
    ]);
  });
});

/** A stored copy of what the verifier expects: the shape a faithful engine writes. */
function storedFrom(e: Expected): Stored {
  return structuredClone({ stats: e.stats, run: e.run, series: e.series });
}

describe('compare: series buckets', () => {
  const expected = expectedFrom([req('A', 0, 30), req('A', 100, 2400, false), grp(['G'], 0, 500, 40)], opts());

  it('finds nothing wrong with a faithful copy, and counts every bucket figure', () => {
    const r = compare(expected, storedFrom(expected));
    expect(r.mismatches).toEqual([]);
    const statFigures = expected.stats.reduce((n, s) => n + 9 + Object.keys(s.percentiles).length, 0) + 2;
    const bucketFigures = expected.series.reduce(
      (n, b) => n + 9 + Object.keys(b.percentiles).length + Object.keys(b.percentilesOk).length + Object.keys(b.percentilesKo).length,
      0,
    );
    expect(r.figuresChecked).toBe(statFigures + bucketFigures);
  });

  function corrupt(mutate: (s: Stored) => void): ReturnType<typeof compare> {
    const stored = storedFrom(expected);
    mutate(stored);
    return compare(expected, stored);
  }

  const at = (s: Stored, scope: string, offset: number) => s.series.find((b) => b.scope === scope && b.startOffsetMs === offset)!;

  it('reports one mismatch, at its bucket, for a corrupted ok_count', () => {
    const want = bucket(expected, 'request', 'A', 'response_time', 2000)!;
    const r = corrupt((s) => { at(s, 'request', 2000).koCount += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'request', name: 'A', family: 'response_time', population: null, bucket: 2000, table: 'run_series_bucket', figure: 'ko_count', stored: want.koCount + 1, recomputed: want.koCount },
    ]);
    const okWant = bucket(expected, 'run', '', 'response_time', 0)!;
    const ok = corrupt((s) => { at(s, 'run', 0).okCount += 1; });
    expect(ok.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: null, bucket: 0, table: 'run_series_bucket', figure: 'ok_count', stored: okWant.okCount + 1, recomputed: okWant.okCount },
    ]);
  });

  it('names the population of a corrupted ko percentile', () => {
    const want = bucket(expected, 'run', '', 'response_time', 0)!;
    const r = corrupt((s) => { at(s, 'run', 0).percentilesKo!.p95! += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: 'ko', bucket: 0, table: 'run_series_bucket', figure: 'p95', stored: want.percentilesKo.p95! + 1, recomputed: want.percentilesKo.p95! },
    ]);
  });

  it('reports a bucket on one side only as one row, at its offset', () => {
    const missing = corrupt((s) => { s.series = s.series.filter((b) => !(b.scope === 'run' && b.startOffsetMs === 2000)); });
    expect(missing.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: null, bucket: 2000, table: 'run_series_bucket', figure: 'row', stored: null, recomputed: 1 },
    ]);
    const extra = corrupt((s) => { s.series.push({ ...at(s, 'run', 0), startOffsetMs: 9000, startedCount: 2, endedCount: 3 }); });
    expect(extra.mismatches).toEqual([
      { scope: 'run', name: '', family: 'response_time', population: null, bucket: 9000, table: 'run_series_bucket', figure: 'row', stored: 5, recomputed: null },
    ]);
  });

  it('reports a stored column that was never written (null) against the figure it should hold', () => {
    const want = bucket(expected, 'run', '', 'response_time', 0)!;
    const r = corrupt((s) => {
      at(s, 'run', 0).startedOkCount = null;
      at(s, 'run', 0).percentilesOk = null;
    });
    expect(r.mismatches.map((m) => [m.figure, m.population, m.stored, m.recomputed])).toEqual([
      ['started_ok_count', null, null, want.startedOkCount],
      ...Object.entries(want.percentilesOk).map(([k, v]) => [k, 'ok', null, v]),
    ]);
  });
});
