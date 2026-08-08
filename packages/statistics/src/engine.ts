import { ingestError, type CanonicalEvent, type MetricFamily, type MetricScope } from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { isWarmup } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';
import { UserSeries, type UserBucket } from './users.js';

/**
 * The per-bucket percentile bands, FIXED rather than configurable.
 *
 * A bucket persists percentiles as plain numbers - the ingest spine stores
 * summary sketches only - so a bucket's percentiles can never be recomputed at
 * read time. A configurable per-bucket set would therefore mean "whatever the
 * project happened to be configured as on ingest day". This is exactly the set
 * Gatling's own percentiles-over-time chart renders, so K-04's band selector is
 * a choice among stored series rather than a recomputation.
 *
 * p95 is load-bearing beyond the chart: Gatling's response-time-vs-throughput
 * scatter hardcodes quantile(0.95), so removing it would break RQ-09.
 */
export const BUCKET_PERCENTILES = [25, 50, 75, 80, 85, 90, 95, 99] as const;

export interface EngineOptions {
  warmupMs?: number;
  /**
   * The statistics-table percentile columns (K-03). Read from project settings
   * at REQUEST time in production; this option exists so tests and the SLA path
   * can ask for a set directly. Indicator bounds are deliberately absent - the
   * engine no longer counts bands.
   */
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
  maxBucketsUsers?: number;
}

export interface EngineResult {
  stats: StatRollup[];
  series: Map<string, { scope: MetricScope; name: string; buckets: Bucket[] }>;
  users: { scenario: string; buckets: UserBucket[] }[];
  errors: { scope: MetricScope; name: string; message: string; count: number }[];
  endpointCount: number;
  /**
   * The load test's own start, from the 'meta' event's startedAtMs — the
   * tool's run header, not when the bundle was uploaded. Null when no meta
   * event was seen, rather than defaulting to epoch 0, so a caller can tell
   * "genuinely unknown" apart from "started at the Unix epoch".
   */
  runStartedAtMs: number | null;
  /** From the meta event. Null when the tool reported none. */
  simulation: string | null;
  description: string | null;
  /** Run start to last response. Gatling's header renders this to whole seconds. */
  durationMs: number;
}

export function runEngine(events: Iterable<CanonicalEvent>, opts: EngineOptions = {}): EngineResult {
  const warmupMs = opts.warmupMs ?? 0;
  const percentiles = opts.percentiles ?? [50, 75, 95, 99];
  const maxEndpoints = opts.maxEndpoints ?? 2000;
  const maxBucketsRun = opts.maxBucketsRun ?? 1200;
  const maxBucketsEndpoint = opts.maxBucketsEndpoint ?? 300;

  let runStartMs = 0;
  let sawMeta = false;
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
  // Constructed lazily, exactly like seriesFor's BucketSeries: runStartMs is 0
  // until the meta event is handled below, and a UserSeries built against 0
  // would report absolute epoch offsets while every request bucket is
  // run-relative.
  let users: UserSeries | null = null;
  const usersFor = (): UserSeries => {
    users ??= new UserSeries({ startMs: runStartMs, maxBuckets: opts.maxBucketsUsers ?? 1200 });
    return users;
  };
  // One rollup per (scope, name), keyed the same opaque way as `rollups`: the
  // key is never parsed back, so a request name containing a space is safe.
  const errorsByKey = new Map<string, { scope: MetricScope; name: string; rollup: ErrorRollup }>();
  const errorsFor = (scope: MetricScope, name: string): ErrorRollup => {
    const key = `${scope} ${name}`;
    let entry = errorsByKey.get(key);
    if (!entry) { entry = { scope, name, rollup: new ErrorRollup() }; errorsByKey.set(key, entry); }
    return entry.rollup;
  };
  let simulation: string | null = null;
  let description: string | null = null;
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
    if (e.type === 'meta') {
      runStartMs = e.startedAtMs;
      sawMeta = true;
      simulation = e.simulation;
      description = e.description ?? null;
      continue;
    }
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
    if (e.type === 'user') {
      // Always recorded, warm-up included: the user charts show the ramp.
      usersFor().add(e.scenario, e.kind, e.tsMs);
      continue;
    }
    if (e.type !== 'request') continue;

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
    // A message-less failure still contributes to the KO count; route it into an
    // explicit bucket so sum(errors[].count) always reconciles instead of
    // silently undercounting.
    if (!e.ok) {
      const message = e.message && e.message.length > 0 ? e.message : '(no message)';
      errorsFor('run', '').add(message);
      errorsFor('request', e.name).add(message);
    }
  }

  const windowMs = Math.max(0, lastMs - Math.max(firstMs, runStartMs + warmupMs));
  const stats: StatRollup[] = [];
  for (const { scope, name, family, builder } of rollups.values()) {
    stats.push(builder.finish({ scope, name, family, windowMs, percentiles }));
  }

  const errors: EngineResult['errors'] = [];
  for (const { scope, name, rollup } of errorsByKey.values()) {
    for (const e of rollup.top(200)) errors.push({ scope, name, message: e.message, count: e.count });
  }

  return {
    stats,
    series: new Map([...series].map(([k, v]) => [k, { scope: v.scope, name: v.name, buckets: v.series.buckets() }])),
    users: users?.scenarios() ?? [],
    errors,
    endpointCount: endpoints.size,
    runStartedAtMs: sawMeta ? runStartMs : null,
    simulation,
    description,
    durationMs: lastMs === 0 ? 0 : Math.max(0, lastMs - runStartMs),
  };
}
