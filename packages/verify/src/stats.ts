import type { CanonicalEvent } from '@perfportal/core';
import type { Expected, ExpectedStat, VerifyOptions } from './figures.js';
import { nearestRankIndex } from './rank.js';
import { expectedSeries } from './series.js';

/**
 * ═══ RECOMPUTED FROM THE RAW EVENTS, THE PLAINEST WAY THERE IS ═══
 *
 * Every row keeps every value it was given, sorted once; each figure is then
 * read off that sorted array or a running sum. No histogram, no sketch, no
 * bucket: the engine's machinery is exactly what this package exists to
 * check, so it uses none of it (Appendix A of the PR 3 plan is the contract,
 * and eslint.config.js refuses an import of @perfportal/statistics).
 */

const DEFAULT_PERCENTILES: readonly number[] = [50, 75, 95, 99];
const DEFAULT_MAX_BUCKETS_RUN = 1200;
const DEFAULT_MAX_BUCKETS_ENDPOINT = 300;

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * The run's frozen `engine_options`, every knob it did not freeze filled with
 * the engine's default. A number of the wrong shape counts as not frozen. The
 * percentile list is the exception, read exactly as Appendix A states it —
 * `Array.isArray(p) ? p : [50, 75, 95, 99]` — so a frozen array is used as
 * given, an empty or odd one included, the way the engine uses it.
 */
export function optionsFrom(engineOptions: Record<string, unknown>, runStartMs: number): VerifyOptions {
  const p: unknown = engineOptions['percentiles'];
  const percentiles = Array.isArray(p) ? [...(p as number[])] : [...DEFAULT_PERCENTILES];
  return {
    runStartMs,
    warmupMs: finiteNumber(engineOptions['warmupMs'], 0),
    percentiles,
    maxBucketsRun: finiteNumber(engineOptions['maxBucketsRun'], DEFAULT_MAX_BUCKETS_RUN),
    maxBucketsEndpoint: finiteNumber(engineOptions['maxBucketsEndpoint'], DEFAULT_MAX_BUCKETS_ENDPOINT),
  };
}

interface RowAcc {
  scope: string;
  name: string;
  family: string;
  values: number[];
  ok: number;
}

/** Every observation is a whole, non-negative millisecond count. */
function observed(v: number): number {
  return Math.max(0, Math.round(v));
}

const SCOPE_ORDER: Record<string, number> = { run: 0, request: 1, group: 2 };

export function expectedFrom(source: Iterable<CanonicalEvent>, opts: VerifyOptions): Expected {
  // Read once: a generator would hand the series pass nothing.
  const events = [...source];
  const rows = new Map<string, RowAcc>();
  const add = (scope: string, name: string, family: string, value: number, ok: boolean): void => {
    const key = `${scope}\u0000${name}\u0000${family}`;
    let acc = rows.get(key);
    if (acc === undefined) {
      acc = { scope, name, family, values: [], ok: 0 };
      rows.set(key, acc);
    }
    acc.values.push(value);
    if (ok) acc.ok += 1;
  };
  const isWarmup = (t: number): boolean => opts.warmupMs > 0 && t - opts.runStartMs < opts.warmupMs;

  // The span is taken over EVERY request, warm-up included; groups, users and
  // error records never move it.
  let sawRequest = false;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;

  for (const e of events) {
    if (e.type === 'request') {
      sawRequest = true;
      if (e.startMs < firstMs) firstMs = e.startMs;
      if (e.endMs > lastMs) lastMs = e.endMs;
      if (isWarmup(e.startMs)) continue;
      const v = observed(e.endMs - e.startMs);
      add('run', '', 'response_time', v, e.ok);
      add('request', [...e.groups, e.name].join('/'), 'response_time', v, e.ok);
    } else if (e.type === 'group') {
      if (isWarmup(e.startMs)) continue;
      const path = e.groups.join('/');
      add('group', path, 'group_cumulated', observed(e.cumulatedResponseTimeMs), e.ok);
      add('group', path, 'group_duration', observed(e.endMs - e.startMs), e.ok);
    }
  }

  // ONE window for every row: from the later of the first request and the end
  // of warm-up, to the last request's end.
  const windowMs =
    sawRequest && lastMs !== 0 ? Math.max(0, lastMs - Math.max(firstMs, opts.runStartMs + opts.warmupMs)) : 0;

  const stats: ExpectedStat[] = [...rows.values()].map((acc) => statOf(acc, windowMs, opts.percentiles));
  stats.sort(
    (a, b) =>
      (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.family < b.family ? -1 : a.family > b.family ? 1 : 0),
  );

  return {
    stats,
    series: expectedSeries(events, opts),
    run: {
      durationMs: lastMs === 0 ? 0 : Math.max(0, lastMs - opts.runStartMs),
      activityMs: lastMs === 0 ? 0 : windowMs,
    },
  };
}

function statOf(acc: RowAcc, windowMs: number, percentiles: readonly number[]): ExpectedStat {
  const sorted = [...acc.values].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / n;
  let squares = 0;
  for (const v of sorted) squares += (v - mean) * (v - mean);

  const ranked: Record<string, number> = {};
  for (const p of percentiles) ranked[`p${String(p)}`] = sorted[nearestRankIndex(p, n)]!;

  const ko = n - acc.ok;
  return {
    scope: acc.scope,
    name: acc.name,
    family: acc.family,
    count: n,
    okCount: acc.ok,
    koCount: ko,
    errorRate: n === 0 ? 0 : ko / n,
    minMs: sorted[0]!,
    maxMs: sorted[n - 1]!,
    meanMs: mean,
    stddevMs: Math.sqrt(squares / n),
    throughputRps: windowMs === 0 ? 0 : (n / windowMs) * 1000,
    percentiles: ranked,
  };
}
