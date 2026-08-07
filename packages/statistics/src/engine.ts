import { ingestError, type CanonicalEvent } from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { IndicatorCounter, isWarmup, type IndicatorBands } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';
import { scopeKey } from './scopes.js';

export interface EngineOptions {
  warmupMs?: number;
  lowerMs?: number;
  higherMs?: number;
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
}

export interface EngineResult {
  stats: StatRollup[];
  series: Map<string, Bucket[]>;
  indicators: IndicatorBands;
  errors: { message: string; count: number }[];
  endpointCount: number;
}

export function runEngine(events: Iterable<CanonicalEvent>, opts: EngineOptions = {}): EngineResult {
  const warmupMs = opts.warmupMs ?? 0;
  const percentiles = opts.percentiles ?? [50, 75, 95, 99];
  const maxEndpoints = opts.maxEndpoints ?? 2000;
  const maxBucketsRun = opts.maxBucketsRun ?? 1200;
  const maxBucketsEndpoint = opts.maxBucketsEndpoint ?? 300;

  let runStartMs = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;

  const rollups = new Map<string, RollupBuilder>();
  const series = new Map<string, BucketSeries>();
  const indicators = new IndicatorCounter({ lowerMs: opts.lowerMs ?? 800, higherMs: opts.higherMs ?? 1200 });
  const errors = new ErrorRollup();
  const endpoints = new Set<string>();

  const seriesFor = (key: string, max: number): BucketSeries => {
    let s = series.get(key);
    if (!s) { s = new BucketSeries({ startMs: runStartMs, maxBuckets: max }); series.set(key, s); }
    return s;
  };
  const rollupFor = (key: string): RollupBuilder => {
    let b = rollups.get(key);
    if (!b) { b = new RollupBuilder(); rollups.set(key, b); }
    return b;
  };

  for (const e of events) {
    if (e.type === 'meta') { runStartMs = e.startedAtMs; continue; }
    if (e.type !== 'request') continue;                     // group/user scopes: Task 11

    endpoints.add(e.name);
    if (endpoints.size > maxEndpoints) {
      throw ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
        message: `Run exceeds the endpoint cardinality cap: more than ${maxEndpoints} distinct request names.`,
        remediation: 'Request names appear to contain dynamic values such as IDs. Parameterize them in the simulation, or raise the limit in project settings.',
        detail: { limit: maxEndpoints, samples: [...endpoints].slice(0, 5) },
      });
    }

    const duration = e.endMs - e.startMs;
    firstMs = Math.min(firstMs, e.startMs);
    lastMs = Math.max(lastMs, e.endMs);

    // Series always includes warm-up (PRD 7.4).
    const runSeries = seriesFor(scopeKey('run', ''), maxBucketsRun);
    runSeries.add(e.startMs, duration, e.ok, 'start');
    runSeries.add(e.endMs, duration, e.ok, 'end');
    const epSeries = seriesFor(scopeKey('request', e.name), maxBucketsEndpoint);
    epSeries.add(e.startMs, duration, e.ok, 'start');
    epSeries.add(e.endMs, duration, e.ok, 'end');

    // Summary stats exclude warm-up.
    if (isWarmup(e.startMs, runStartMs, warmupMs)) continue;
    rollupFor(scopeKey('run', '')).add(duration, e.ok);
    rollupFor(scopeKey('request', e.name)).add(duration, e.ok);
    indicators.add(duration, e.ok);
    if (!e.ok && e.message) errors.add(e.message);
  }

  const windowMs = Math.max(0, lastMs - Math.max(firstMs, runStartMs + warmupMs));
  const stats: StatRollup[] = [];
  for (const [key, b] of rollups) {
    const [scope, name] = key.split(':') as ['run' | 'request', string];
    stats.push(b.finish({ scope, name, family: 'response_time', windowMs, percentiles }));
  }

  return {
    stats,
    series: new Map([...series].map(([k, v]) => [k, v.buckets()])),
    indicators: indicators.bands(),
    errors: errors.top(200),
    endpointCount: endpoints.size,
  };
}
