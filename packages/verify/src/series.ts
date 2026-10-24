import type { CanonicalEvent } from '@perfportal/core';
import type { ExpectedSeriesBucket, VerifyOptions } from './figures.js';
import { BASE_WIDTH_MS } from './figures.js';
import { nearestRankIndex } from './rank.js';

/**
 * ═══ `run_series_bucket`, RECOMPUTED FROM THE EDGES ═══
 *
 * Appendix A of the PR 3 plan, implemented from the text and nothing else:
 *
 *   - Series: `('run','','response_time')` capped at `maxBucketsRun`,
 *     `('request', path, 'response_time')` at `maxBucketsEndpoint`, and
 *     `('group', path, 'group_cumulated' | 'group_duration')` at a fixed 300.
 *   - Every observation, WARM-UP INCLUDED, has two edges: its start and its
 *     end. The width is the smallest `1000 · 2^k` at which the distinct
 *     `floor((t − runStart) / W)` over EVERY edge of the series — starts and
 *     ends both — number no more than the cap. A bucket's offset is its index
 *     times that width, so it may be negative.
 *   - The START edge counts `started_count` and `started_ok/ko_count` and
 *     carries the observation's latency; the END edge counts `ended_count`
 *     and `ok/ko_count` and carries no latency.
 *   - Latency figures are over the start-edge population: min, max and mean
 *     (0 when there is none), and the FIXED percentile set below over all,
 *     ok and ko (`{}` for an empty population).
 *
 * Kept as plain value lists sorted once, like stats.ts — never a histogram or
 * a sketch, because those are the engine's machinery and this package exists
 * to check it.
 */

/** The bucket percentile set is fixed; `engine_options.percentiles` is for `run_stat` only. */
export const SERIES_PERCENTILES: readonly number[] = [25, 50, 75, 80, 85, 90, 95, 99];

/** A group series' cap. Not configurable. */
export const GROUP_SERIES_CAP = 300;

interface Observation {
  /** Edge offsets from the run start. */
  start: number;
  end: number;
  value: number;
  ok: boolean;
}

interface SeriesAcc {
  scope: string;
  name: string;
  family: string;
  cap: number;
  observations: Observation[];
}

interface BucketAcc {
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  startedOkCount: number;
  startedKoCount: number;
  ok: number[];
  ko: number[];
}

function observed(v: number): number {
  return Math.max(0, Math.round(v));
}

/**
 * The smallest `1000 · 2^k` whose distinct indexes over `edges` are at most
 * `cap`. A cap below 1 is taken as 1, as the engine clamps its own
 * (`Math.max(1, cap)`). The run series' width is also the error buckets'
 * (errors.ts), which is why this is exported.
 *
 * The `width > reach` guard then fires for exactly one shape: a cap of 1 on a
 * series whose edges straddle the run start, whose indexes stay at -1 and 0 at
 * every width. The engine loops there and stores no rows at all, so whatever
 * this returns is compared against nothing; the guard only keeps the verifier
 * from looping too. Any cap of 2 or more is met by the time the width passes
 * the furthest edge, and so is a cap of 1 on a series on one side of the start.
 */
export function seriesWidth(edges: readonly number[], rawCap: number): number {
  const cap = Math.max(1, rawCap);
  let reach = 0;
  for (const t of edges) reach = Math.max(reach, Math.abs(t));
  let width = BASE_WIDTH_MS;
  for (;;) {
    const distinct = new Set<number>();
    for (const t of edges) distinct.add(Math.floor(t / width));
    if (distinct.size <= cap || width > reach) return width;
    width *= 2;
  }
}

/**
 * The run-scope `response_time` series' width, as `expectedSeries` derives it
 * for that series: every request's start and end edge, warm-up and OK
 * requests included, at the run cap. Null for a run with no request, which has
 * no run series at all. The error buckets (errors.ts) and the agent buckets
 * (agent.ts, through the worker) are laid on this width, so it is ONE
 * derivation, not three that could disagree.
 */
export function runSeriesWidth(events: Iterable<CanonicalEvent>, opts: Pick<VerifyOptions, 'runStartMs' | 'maxBucketsRun'>): number | null {
  const edges: number[] = [];
  for (const e of events) {
    if (e.type === 'request') edges.push(e.startMs - opts.runStartMs, e.endMs - opts.runStartMs);
  }
  return edges.length === 0 ? null : seriesWidth(edges, opts.maxBucketsRun);
}

function ranked(values: number[]): Record<string, number> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (const p of SERIES_PERCENTILES) out[`p${String(p)}`] = sorted[nearestRankIndex(p, sorted.length)]!;
  return out;
}

const SCOPE_ORDER: Record<string, number> = { run: 0, request: 1, group: 2 };

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function expectedSeries(events: Iterable<CanonicalEvent>, opts: VerifyOptions): ExpectedSeriesBucket[] {
  const all = new Map<string, SeriesAcc>();
  const add = (scope: string, name: string, family: string, cap: number, o: Observation): void => {
    const key = `${scope}\u0000${name}\u0000${family}`;
    let acc = all.get(key);
    if (acc === undefined) {
      acc = { scope, name, family, cap, observations: [] };
      all.set(key, acc);
    }
    acc.observations.push(o);
  };

  for (const e of events) {
    if (e.type === 'request') {
      const o: Observation = { start: e.startMs - opts.runStartMs, end: e.endMs - opts.runStartMs, value: observed(e.endMs - e.startMs), ok: e.ok };
      add('run', '', 'response_time', opts.maxBucketsRun, o);
      add('request', [...e.groups, e.name].join('/'), 'response_time', opts.maxBucketsEndpoint, o);
    } else if (e.type === 'group') {
      const start = e.startMs - opts.runStartMs;
      const end = e.endMs - opts.runStartMs;
      const path = e.groups.join('/');
      add('group', path, 'group_cumulated', GROUP_SERIES_CAP, { start, end, value: observed(e.cumulatedResponseTimeMs), ok: e.ok });
      add('group', path, 'group_duration', GROUP_SERIES_CAP, { start, end, value: observed(e.endMs - e.startMs), ok: e.ok });
    }
  }

  const out: ExpectedSeriesBucket[] = [];
  for (const acc of all.values()) out.push(...bucketsOf(acc));
  out.sort(
    (a, b) =>
      (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) ||
      byName(a.name, b.name) ||
      byName(a.family, b.family) ||
      a.startOffsetMs - b.startOffsetMs,
  );
  return out;
}

function bucketsOf(acc: SeriesAcc): ExpectedSeriesBucket[] {
  const edges: number[] = [];
  for (const o of acc.observations) edges.push(o.start, o.end);
  const width = seriesWidth(edges, acc.cap);

  const buckets = new Map<number, BucketAcc>();
  const at = (t: number): BucketAcc => {
    const index = Math.floor(t / width);
    let b = buckets.get(index);
    if (b === undefined) {
      b = { startedCount: 0, endedCount: 0, okCount: 0, koCount: 0, startedOkCount: 0, startedKoCount: 0, ok: [], ko: [] };
      buckets.set(index, b);
    }
    return b;
  };

  for (const o of acc.observations) {
    const s = at(o.start);
    s.startedCount += 1;
    if (o.ok) {
      s.startedOkCount += 1;
      s.ok.push(o.value);
    } else {
      s.startedKoCount += 1;
      s.ko.push(o.value);
    }
    const e = at(o.end);
    e.endedCount += 1;
    if (o.ok) e.okCount += 1;
    else e.koCount += 1;
  }

  return [...buckets.entries()].map(([index, b]) => {
    const values = [...b.ok, ...b.ko];
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const v of values) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const n = values.length;
    return {
      scope: acc.scope,
      name: acc.name,
      family: acc.family,
      startOffsetMs: index * width,
      startedCount: b.startedCount,
      endedCount: b.endedCount,
      okCount: b.okCount,
      koCount: b.koCount,
      startedOkCount: b.startedOkCount,
      startedKoCount: b.startedKoCount,
      minMs: n === 0 ? 0 : min,
      maxMs: n === 0 ? 0 : max,
      meanMs: n === 0 ? 0 : sum / n,
      percentiles: ranked(values),
      percentilesOk: ranked(b.ok),
      percentilesKo: ranked(b.ko),
    };
  });
}
