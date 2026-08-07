import { ingestError, type CanonicalEvent, type MetricFamily, type MetricScope } from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { IndicatorCounter, isWarmup, type IndicatorBands } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';

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
  series: Map<string, { scope: MetricScope; name: string; buckets: Bucket[] }>;
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

  // Keyed by (scope, name, family) so the same group name can hold a group_cumulated
  // AND a group_duration entry at once. The key is an opaque lookup token only — scope,
  // name and family are always read back from the stored fields, never recovered by
  // parsing the key, so a name containing the delimiter can never be truncated or
  // collide with another entry (see the "map delimiter" regression test).
  const rollups = new Map<string, { scope: MetricScope; name: string; family: MetricFamily; builder: RollupBuilder }>();
  // Keyed by (scope, name) the same way `rollups` is keyed by (scope, name, family): the
  // key is an opaque lookup token only, never parsed back — scope and name are always
  // read from the stored entry fields, so a request name containing a space or colon can
  // never be truncated or collide with another entry.
  const series = new Map<string, { scope: MetricScope; name: string; series: BucketSeries }>();
  const indicators = new IndicatorCounter({ lowerMs: opts.lowerMs ?? 800, higherMs: opts.higherMs ?? 1200 });
  const errors = new ErrorRollup();
  const endpoints = new Set<string>();

  const seriesFor = (scope: MetricScope, name: string, max: number): BucketSeries => {
    const key = `${scope} ${name}`;
    let entry = series.get(key);
    if (!entry) { entry = { scope, name, series: new BucketSeries({ startMs: runStartMs, maxBuckets: max }) }; series.set(key, entry); }
    return entry.series;
  };
  // Space-joined lookup token. A group/request name may itself contain spaces, but
  // that can never fold two distinct (scope, name, family) triples onto one key:
  // scope and family are always drawn from a few fixed literals, and no MetricFamily
  // literal is a suffix of another, so the trailing " <family>" segment is always
  // unambiguous. finish() reads scope/name/family back from the stored entry fields
  // below, never by parsing this key.
  const rollupKey = (scope: MetricScope, name: string, family: MetricFamily): string =>
    `${scope} ${name} ${family}`;
  const rollupFor = (scope: MetricScope, name: string, family: MetricFamily): RollupBuilder => {
    const key = rollupKey(scope, name, family);
    let entry = rollups.get(key);
    if (!entry) { entry = { scope, name, family, builder: new RollupBuilder() }; rollups.set(key, entry); }
    return entry.builder;
  };

  for (const e of events) {
    if (e.type === 'meta') { runStartMs = e.startedAtMs; continue; }
    if (e.type === 'group') {
      // Group name is the hierarchy joined with '/' (e.g. 'Catalog/Recommendations').
      // cumulatedResponseTimeMs and (endMs - startMs) are deliberately tracked as two
      // separate families — they diverge whenever requests inside the group overlap,
      // so one must never be derived from the other.
      const name = e.groups.join('/');
      // Summary stats exclude warm-up, same as the request path (PRD 7.4).
      if (isWarmup(e.startMs, runStartMs, warmupMs)) continue;
      rollupFor('group', name, 'group_cumulated').add(e.cumulatedResponseTimeMs, e.ok);
      rollupFor('group', name, 'group_duration').add(e.endMs - e.startMs, e.ok);
      continue;
    }
    if (e.type !== 'request') continue;                     // user scopes: out of scope for Task 11

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
    const runSeries = seriesFor('run', '', maxBucketsRun);
    runSeries.add(e.startMs, duration, e.ok, 'start');
    runSeries.add(e.endMs, duration, e.ok, 'end');
    const epSeries = seriesFor('request', e.name, maxBucketsEndpoint);
    epSeries.add(e.startMs, duration, e.ok, 'start');
    epSeries.add(e.endMs, duration, e.ok, 'end');

    // Summary stats exclude warm-up.
    if (isWarmup(e.startMs, runStartMs, warmupMs)) continue;
    rollupFor('run', '', 'response_time').add(duration, e.ok);
    rollupFor('request', e.name, 'response_time').add(duration, e.ok);
    indicators.add(duration, e.ok);
    // A message-less failure still contributes to indicators.failed above; route it into
    // an explicit bucket so `sum(errors[].count)` always reconciles with `failed` instead
    // of silently undercounting.
    if (!e.ok) errors.add(e.message && e.message.length > 0 ? e.message : '(no message)');
  }

  const windowMs = Math.max(0, lastMs - Math.max(firstMs, runStartMs + warmupMs));
  const stats: StatRollup[] = [];
  for (const { scope, name, family, builder } of rollups.values()) {
    stats.push(builder.finish({ scope, name, family, windowMs, percentiles }));
  }

  return {
    stats,
    series: new Map([...series].map(([k, v]) => [k, { scope: v.scope, name: v.name, buckets: v.series.buckets() }])),
    indicators: indicators.bands(),
    errors: errors.top(200),
    endpointCount: endpoints.size,
  };
}
