import {
  ingestError,
  type CanonicalEvent, type MetricFamily, type MetricScope, type ToolAssertion,
} from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { ErrorSeries, type ErrorSeriesResult } from './errors-series.js';
import { isWarmup } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';
import { evaluateToolAssertions, type EvaluatedToolAssertion } from './tool-assertions.js';
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

/**
 * The label a failure is filed under.
 *
 * SHARED by the flat rollup and the time series deliberately. The two are read
 * side by side on the errors tab, and a failure that appeared as `(no message)`
 * in one and as an empty string in the other would look like two different
 * failures.
 */
const errorMessageOf = (message: string | undefined): string =>
  message !== undefined && message.length > 0 ? message : '(no message)';

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
  maxBucketsGroup?: number;
  maxBucketsUsers?: number;
}

export interface EngineResult {
  stats: StatRollup[];
  series: Map<string, { scope: MetricScope; name: string; family: MetricFamily; buckets: Bucket[] }>;
  users: { scenario: string; buckets: UserBucket[] }[];
  /** `message: null` is the folded remainder — see `ErrorTally`. */
  errors: { scope: MetricScope; name: string; message: string | null; count: number }[];
  /**
   * Failures over time, run scope. Coalesced to the run-scope response-time
   * series' width so both charts share one resolution — see `errors-series.ts`.
   *
   * INCLUDES WARM-UP, unlike `errors` above. Series do (PRD 7.4), and a bucket
   * inside the warm-up window that showed `koCount > 0` on the responses chart
   * and nothing here would be two contradictory answers on one axis.
   */
  errorSeries: ErrorSeriesResult;
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
  /**
   * The tool's OWN assertions, re-evaluated against the rollups above —
   * Appendix A G-05. Empty for a tool that declares none, and for a tool with
   * no such concept.
   *
   * Distinct from this platform's SLA rules, which are evaluated elsewhere,
   * carry a rule id, and drive the 200/422 verdict. See `ToolAssertion`.
   */
  toolAssertions: EvaluatedToolAssertion[];
}

export class LiveEngine {
  readonly #warmupMs: number;
  readonly #percentiles: number[];
  readonly #maxEndpoints: number;
  readonly #maxBucketsRun: number;
  readonly #maxBucketsEndpoint: number;
  readonly #maxBucketsGroup: number;
  readonly #maxBucketsUsers: number;

  #runStartMs = 0;
  #sawMeta = false;
  #firstMs = Number.POSITIVE_INFINITY;
  #lastMs = 0;

  // Keyed by (scope, name, family) so the same group name can hold a group_cumulated
  // AND a group_duration entry at once. The key is an opaque lookup token only — scope,
  // name and family are always read back from the stored fields, never recovered by
  // parsing the key, so a name containing the delimiter can never be truncated or
  // collide with another entry (see the "map delimiter" regression test).
  #rollups = new Map<string, { scope: MetricScope; name: string; family: MetricFamily; builder: RollupBuilder }>();
  // Keyed by (scope, name, family) the same way `rollups` is: the key is an
  // opaque lookup token only, never parsed back — scope, name and family are
  // always read from the stored entry fields, so a name containing a space can
  // never truncate or collide.
  #series = new Map<string, { scope: MetricScope; name: string; family: MetricFamily; series: BucketSeries }>();
  // Buffered, then built after the loop: runStartMs is 0 until the meta event
  // is handled below, and a UserSeries constructed against 0 reports absolute
  // epoch offsets while every request bucket is run-relative. UserSeries
  // computes nothing until scenarios(), so deferring costs only this array.
  #userEvents: { scenario: string; kind: 'start' | 'end'; tsMs: number }[] = [];
  // One rollup per (scope, name), keyed the same opaque way as `rollups`: the
  // key is never parsed back, so a request name containing a space is safe.
  #errorsByKey = new Map<string, { scope: MetricScope; name: string; rollup: ErrorRollup }>();
  #errorsFor(scope: MetricScope, name: string): ErrorRollup {
    const key = `${scope} ${name}`;
    let entry = this.#errorsByKey.get(key);
    if (!entry) { entry = { scope, name, rollup: new ErrorRollup() }; this.#errorsByKey.set(key, entry); }
    return entry.rollup;
  }
  // LAZY, exactly like `seriesFor`'s BucketSeries instances and for the reason
  // `userEvents` is buffered: `runStartMs` is 0 until the meta event is handled
  // below, and a series constructed against 0 files every failure at an
  // absolute epoch offset while every request bucket is run-relative.
  //
  // `maxBucketsRun` is not a free choice. The coalesce in `finish` can only
  // merge, never split, and what guarantees that is the error series never
  // halving before the run series does — which holds because their timestamps
  // are a subset and their caps are the SAME.
  // Constructed at the first failure in the loop body rather than behind a
  // `seriesFor`-style closure: a `let` assigned only inside a nested function
  // is not narrowed by control-flow analysis, so `errorSeries.finish()` after
  // the loop would not typecheck.
  #errorSeries: ErrorSeries | null = null;
  // Captured rather than looked up by key after the loop: `series` is keyed by
  // `${scope} ${name} ${family}`, so the run-scope entry's key contains a
  // DOUBLE SPACE, and a lookup that got the spacing wrong would silently fall
  // back to 1000ms and misalign the chart it exists to align.
  #runResponseSeries: BucketSeries | null = null;
  #simulation: string | null = null;
  #description: string | null = null;
  #declaredAssertions: readonly ToolAssertion[] = [];
  #endpoints = new Set<string>();

  constructor(opts: EngineOptions = {}) {
    this.#warmupMs = opts.warmupMs ?? 0;
    this.#percentiles = opts.percentiles ?? [50, 75, 95, 99];
    this.#maxEndpoints = opts.maxEndpoints ?? 2000;
    this.#maxBucketsRun = opts.maxBucketsRun ?? 1200;
    this.#maxBucketsEndpoint = opts.maxBucketsEndpoint ?? 300;
    this.#maxBucketsGroup = opts.maxBucketsGroup ?? 300;
    this.#maxBucketsUsers = opts.maxBucketsUsers ?? 1200;
  }

  #seriesFor(
    scope: MetricScope, name: string, family: MetricFamily, max: number,
  ): BucketSeries {
    const key = `${scope} ${name} ${family}`;
    let entry = this.#series.get(key);
    if (!entry) {
      entry = { scope, name, family, series: new BucketSeries({ startMs: this.#runStartMs, maxBuckets: max }) };
      this.#series.set(key, entry);
    }
    return entry.series;
  }
  // Space-joined lookup token. A group/request name may itself contain spaces, but
  // that can never fold two distinct (scope, name, family) triples onto one key:
  // scope and family are always drawn from a few fixed literals, and no MetricFamily
  // literal is a suffix of another, so the trailing " <family>" segment is always
  // unambiguous. finish() reads scope/name/family back from the stored entry fields
  // below, never by parsing this key.
  #rollupKey(scope: MetricScope, name: string, family: MetricFamily): string {
    return `${scope} ${name} ${family}`;
  }
  #rollupFor(scope: MetricScope, name: string, family: MetricFamily): RollupBuilder {
    const key = this.#rollupKey(scope, name, family);
    let entry = this.#rollups.get(key);
    if (!entry) { entry = { scope, name, family, builder: new RollupBuilder() }; this.#rollups.set(key, entry); }
    return entry.builder;
  }

  add(e: CanonicalEvent): void {
    if (e.type === 'meta') {
      this.#runStartMs = e.startedAtMs;
      this.#sawMeta = true;
      this.#simulation = e.simulation;
      this.#description = e.description ?? null;
      // Definitions only. Evaluated after the loop, because judging them needs
      // the rollups this loop is still building.
      this.#declaredAssertions = e.assertions ?? [];
      return;
    }
    if (e.type === 'group') {
      // Group name is the hierarchy joined with '/' (e.g. 'Catalog/Recommendations').
      // cumulatedResponseTimeMs and (endMs - startMs) are deliberately tracked as two
      // separate families — they diverge whenever requests inside the group overlap,
      // so one must never be derived from the other.
      const name = e.groups.join('/');

      // GR-04 and GR-06. Two series, not one: cumulated response time and
      // wall-clock duration diverge whenever requests inside the group overlap,
      // which is the same reason `rollupFor` is called twice below.
      //
      // Both edges, matching the request path — the percentiles chart reads the
      // END edge, but a series that only recorded one edge could not later feed
      // a rate chart without a re-ingest.
      //
      // Series always includes warm-up (PRD 7.4), so these run BEFORE the
      // warm-up `continue` below, mirroring the request branch's split between
      // series (:172-177) and summary stats (:180-182).
      const cumulated = this.#seriesFor('group', name, 'group_cumulated', this.#maxBucketsGroup);
      cumulated.add(e.startMs, e.cumulatedResponseTimeMs, e.ok, 'start');
      cumulated.add(e.endMs, e.cumulatedResponseTimeMs, e.ok, 'end');
      const duration = this.#seriesFor('group', name, 'group_duration', this.#maxBucketsGroup);
      duration.add(e.startMs, e.endMs - e.startMs, e.ok, 'start');
      duration.add(e.endMs, e.endMs - e.startMs, e.ok, 'end');

      // Summary stats exclude warm-up, same as the request path (PRD 7.4).
      if (isWarmup(e.startMs, this.#runStartMs, this.#warmupMs)) return;
      this.#rollupFor('group', name, 'group_cumulated').add(e.cumulatedResponseTimeMs, e.ok);
      this.#rollupFor('group', name, 'group_duration').add(e.endMs - e.startMs, e.ok);
      return;
    }
    if (e.type === 'user') {
      // Always recorded, warm-up included: the user charts show the ramp.
      this.#userEvents.push({ scenario: e.scenario, kind: e.kind, tsMs: e.tsMs });
      return;
    }
    if (e.type === 'error') {
      // ═══ THE FLAT TABLE ONLY, AND RUN SCOPE ONLY ═══
      //
      // Run scope, because there is no request to attribute it to — that is
      // what makes it an `ErrorEvent` rather than a failed `RequestEvent`. It
      // is also what Gatling does: these appear in the global errors table and
      // on no request page, which is the same rule RQ-11 states from the other
      // side ("a request page shows only its own errors").
      //
      // NOT into `errorSeries`, deliberately. That series is documented to
      // reconcile against `koCount` — the drawn series plus the folded
      // remainder sum to each bucket's KO total — and these are not request
      // failures, so feeding them in would make a stated invariant false. The
      // errors-over-time chart is beyond parity (there is no such chart in the
      // Gatling report) so nothing is owed there; the flat table is the G-17
      // surface and it is the one that has to be exact.
      //
      // Warm-up is excluded on the same terms as a request's error below, so
      // one run cannot count two kinds of failure by two different rules.
      if (isWarmup(e.tsMs, this.#runStartMs, this.#warmupMs)) return;
      this.#errorsFor('run', '').add(errorMessageOf(e.message));
      return;
    }
    if (e.type !== 'request') return;

    // D-10. A request's identity is its FULL PATH, joined exactly as :133 joins
    // a group's — `Catalog/Recommendations/List Products`. Without this the
    // statistics tree cannot nest requests under their groups: `buildTree`
    // parents by '/'-prefix, and a bare name has no prefix to parent by.
    //
    // COUNTED HERE TOO, not just rolled up (D-12). The cap bounds STORED
    // ROLLUPS, and after this change one bare name under four groups is four
    // rollups. A cap still counting bare names would stop bounding the thing
    // it exists for.
    const name = [...e.groups, e.name].join('/');

    this.#endpoints.add(name);
    if (this.#endpoints.size > this.#maxEndpoints) {
      throw ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
        message: `Run exceeds the endpoint cardinality cap: more than ${this.#maxEndpoints} distinct request paths.`,
        remediation: 'Request names appear to contain dynamic values such as IDs. Parameterize them in the simulation, or raise the limit in project settings.',
        detail: { limit: this.#maxEndpoints, samples: [...this.#endpoints].slice(0, 5) },
      });
    }

    const duration = e.endMs - e.startMs;
    this.#firstMs = Math.min(this.#firstMs, e.startMs);
    this.#lastMs = Math.max(this.#lastMs, e.endMs);

    // Series always includes warm-up (PRD 7.4).
    const runSeries = this.#seriesFor('run', '', 'response_time', this.#maxBucketsRun);
    this.#runResponseSeries = runSeries;
    runSeries.add(e.startMs, duration, e.ok, 'start');
    runSeries.add(e.endMs, duration, e.ok, 'end');
    const epSeries = this.#seriesFor('request', name, 'response_time', this.#maxBucketsEndpoint);
    epSeries.add(e.startMs, duration, e.ok, 'start');
    epSeries.add(e.endMs, duration, e.ok, 'end');

    // BEFORE the warm-up guard below, unlike the flat `errorsFor` calls after
    // it: this is a series, and series include warm-up.
    //
    // At `endMs`, which is where `koCount` is counted — so within a bucket the
    // drawn series plus the folded remainder sum to that bucket's koCount. At
    // `startMs` a request beginning at 10.9s and failing at 11.2s would sit in
    // a different bucket from its own KO.
    if (!e.ok) {
      this.#errorSeries ??= new ErrorSeries({ startMs: this.#runStartMs, maxBuckets: this.#maxBucketsRun });
      this.#errorSeries.add(e.endMs, errorMessageOf(e.message));
    }

    // Summary stats exclude warm-up.
    if (isWarmup(e.startMs, this.#runStartMs, this.#warmupMs)) return;
    this.#rollupFor('run', '', 'response_time').add(duration, e.ok);
    this.#rollupFor('request', name, 'response_time').add(duration, e.ok);
    // A message-less failure still contributes to the KO count; route it into an
    // explicit bucket so sum(errors[].count) always reconciles instead of
    // silently undercounting.
    if (!e.ok) {
      const message = errorMessageOf(e.message);
      this.#errorsFor('run', '').add(message);
      this.#errorsFor('request', name).add(message);
    }
  }

  snapshot(): EngineResult {
    const windowMs = Math.max(0, this.#lastMs - Math.max(this.#firstMs, this.#runStartMs + this.#warmupMs));
    const stats: StatRollup[] = [];
    for (const { scope, name, family, builder } of this.#rollups.values()) {
      stats.push(builder.finish({ scope, name, family, windowMs, percentiles: this.#percentiles }));
    }

    const errors: EngineResult['errors'] = [];
    for (const { scope, name, rollup } of this.#errorsByKey.values()) {
      for (const e of rollup.top(200)) errors.push({ scope, name, message: e.message, count: e.count });
    }

    // The run series' final width, which the error series is lifted to match.
    // 1000 when there is no run series at all, which implies no requests and so
    // no failures either — nothing is drawn at any width.
    const runWidthMs = this.#runResponseSeries?.widthMs ?? 1000;
    const errorSeriesResult: ErrorSeriesResult =
      this.#errorSeries === null ? { bucketWidthMs: runWidthMs, rows: [] } : this.#errorSeries.finish(runWidthMs);

    const users = new UserSeries({ startMs: this.#runStartMs, maxBuckets: this.#maxBucketsUsers });
    for (const u of this.#userEvents) users.add(u.scenario, u.kind, u.tsMs);

    return {
      stats,
      series: new Map([...this.#series].map(([k, v]) => [k, { scope: v.scope, name: v.name, family: v.family, buckets: v.series.buckets() }])),
      users: users.scenarios(),
      errors,
      errorSeries: errorSeriesResult,
      endpointCount: this.#endpoints.size,
      runStartedAtMs: this.#sawMeta ? this.#runStartMs : null,
      simulation: this.#simulation,
      description: this.#description,
      durationMs: this.#lastMs === 0 ? 0 : Math.max(0, this.#lastMs - this.#runStartMs),
      // AFTER `stats`, necessarily: an assertion is judged against the very
      // rollups this call produced, so it cannot be evaluated while they are
      // still being accumulated.
      toolAssertions: evaluateToolAssertions(this.#declaredAssertions, stats),
    };
  }
}

export function runEngine(events: Iterable<CanonicalEvent>, opts: EngineOptions = {}): EngineResult {
  const engine = new LiveEngine(opts);
  for (const e of events) engine.add(e);
  return engine.snapshot();
}
