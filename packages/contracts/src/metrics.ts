import { z } from 'zod';
/**
 * IMPORTED, NOT RESTATED. A run's verdict is one vocabulary, and a second
 * `z.enum(['passed', 'failed', 'not_evaluated'])` here would be free to drift
 * from the one `RunResponse` uses the day a fourth value is added. `run.ts`
 * imports nothing but zod, so this direction cannot cycle.
 */
import { RunVerdictSchema } from './run.js';

export const MetricScopeSchema = z.enum(['run', 'scenario', 'group', 'request']);
export const MetricFamilySchema = z.enum([
  'response_time',
  'latency',
  'group_cumulated',
  'group_duration',
]);

export const IndicatorBandsSchema = z.object({
  under: z.number().int(),
  between: z.number().int(),
  over: z.number().int(),
  failed: z.number().int(),
});

export const StatRowSchema = z.object({
  scope: MetricScopeSchema,
  name: z.string(),
  family: MetricFamilySchema,
  count: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  errorRate: z.number(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  stddevMs: z.number(),
  throughputRps: z.number(),
  /** Keys are p<number>: p50, p95, p99.9. */
  percentiles: z.record(z.number()),
  /** Folded from this row's stored histogram at the project's current bounds. */
  indicators: IndicatorBandsSchema,
});
export type StatRow = z.infer<typeof StatRowSchema>;

export const WindowSchema = z.object({
  /** Elapsed ms from run start, inclusive. */
  fromMs: z.number().int().nonnegative(),
  /** Elapsed ms from run start, EXCLUSIVE — adjacent windows never overlap. */
  toMs: z.number().int().positive(),
  /**
   * The bucket width the window was snapped to.
   *
   * A brush that cuts a bucket in half cannot be answered exactly at any
   * storage cost — the bucket is the finest thing stored — so the range is
   * widened OUTWARD to bucket boundaries and reported here. A page header must
   * state this range, not the one the reader dragged, or it claims a precision
   * the numbers underneath do not have.
   */
  bucketWidthMs: z.number().int().positive(),
});
export type Window = z.infer<typeof WindowSchema>;

export const StatsResponseSchema = z.object({
  runId: z.string().uuid(),
  stats: z.array(StatRowSchema),
  /**
   * The window these statistics were computed over, or `null` when the whole
   * run was used. Non-null values are SNAPPED — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  indicators: z.object({
    under: z.number().int(),
    between: z.number().int(),
    over: z.number().int(),
    failed: z.number().int(),
  }),
  /**
   * False for runs ingested before the parity migration, which have no
   * histogram: their bands come from frozen values and do not respond to a
   * bounds change. Reported rather than silently pretended.
   */
  configurable: z.boolean(),
  /** The bounds these bands were folded at, so a client never has to guess. */
  bounds: z.object({ lowerMs: z.number().int(), higherMs: z.number().int() }),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const SeriesBucketSchema = z.object({
  startOffsetMs: z.number().int(),
  startedCount: z.number().int(),
  endedCount: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  /** START-edge outcome split (G-23). Null for runs ingested before the
   *  migration that added it; see startedSplitAvailable. */
  startedOkCount: z.number().int().nullable(),
  startedKoCount: z.number().int().nullable(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  percentiles: z.record(z.number()),
  /** OK-only. Gatling's percentiles-over-time chart uses this, not the combined set. */
  percentilesOk: z.record(z.number()),
  /** KO-only. Empty for a bucket with no failures. */
  percentilesKo: z.record(z.number()),
});

export const SeriesResponseSchema = z.object({
  runId: z.string().uuid(),
  scope: MetricScopeSchema,
  name: z.string(),
  family: MetricFamilySchema,
  /**
   * The width of every bucket in this response. NOT always 1000: BucketSeries
   * halves resolution in place once a run exceeds its bucket cap, and the
   * width is not stored, so the server recovers it with inferBucketWidthMs.
   *
   * Sent because requests/s and responses/s are RATES. A client that assumed
   * 1000ms would scale every point by a power of two on a long run — and
   * because every bucket scales equally, the curve's shape is unchanged and
   * nothing looks wrong.
   */
  bucketWidthMs: z.number().int().positive(),
  /**
   * False for runs ingested before the start-edge split existed. Their
   * requests/s chart draws the All series alone and says why — it never draws
   * two zero lines, which would read as "no failures" rather than "not
   * recorded". Mirrors StatsResponse.configurable.
   */
  startedSplitAvailable: z.boolean(),
  /**
   * Only meaningful at group scope. False when this run has no group-scope
   * series at all — it was ingested before the platform recorded them. An
   * empty `buckets` array is ALSO what a group with no traffic returns, so the
   * two are indistinguishable without this; drawing empty axes would claim the
   * group was measured and found idle.
   *
   * A run-level question, unlike `startedSplitAvailable`, which reads the rows:
   * there the columns are nullable and the rows exist; here the rows are absent.
   *
   * `false` at any other scope, WITHOUT being consulted there: the extra
   * `EXISTS` this needs is only worth issuing for the group page, the one
   * reader of this flag, so a run- or request-scope call gets `false` as a
   * fixed default rather than a real answer to a question it never asked.
   */
  groupSeriesAvailable: z.boolean(),
  /**
   * The window this payload was computed over, or `null` for the whole run.
   * Non-null values are SNAPPED to bucket boundaries — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  buckets: z.array(SeriesBucketSchema),
});
export type SeriesResponse = z.infer<typeof SeriesResponseSchema>;

export const ErrorsResponseSchema = z.object({
  runId: z.string().uuid(),
  errors: z.array(
    z.object({
      /**
       * `null` is the folded remainder — every message outside the top 200,
       * summed — and is rendered as "Other errors", the same words the
       * errors-over-time chart uses for the same thing.
       *
       * Deliberately not the string `'other'`. That was a reserved word inside
       * the data, it collided with a genuine error message of that name, and
       * `run_error`'s unique key turned the collision into a failed ingest.
       */
      message: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});
export type ErrorsResponse = z.infer<typeof ErrorsResponseSchema>;

export const ErrorSeriesResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The width of every bucket in `series`, STORED rather than inferred. Errors
   * are sparse, and `inferBucketWidthMs` reads the smallest gap between
   * offsets — three failures 35s apart would infer a 35000ms width.
   *
   * EQUAL TO `/series`' `bucketWidthMs` WHENEVER ANY FAILURE WAS RECORDED,
   * because the engine coalesces the error buckets up to the run series' final
   * width before persisting them.
   *
   * A run with NO failures is the one exception, and it is a placeholder
   * rather than a measurement: the width lives on the rows, so a run with no
   * rows has nowhere to carry it and this reports 1000 while `/series` may
   * report far more on a long run. Nothing is drawn in that state — `series`
   * is empty and the chart says so — but do not scale anything by this without
   * checking `series` first.
   */
  bucketWidthMs: z.number().int().positive(),
  /**
   * False ONLY for a run ingested before failures were recorded over time. A
   * run that genuinely had no failures is `true` with an empty `series` — the
   * two are otherwise indistinguishable, and drawing empty axes for the first
   * would claim the run succeeded. Mirrors `groupSeriesAvailable`'s job on
   * SeriesResponse.
   */
  available: z.boolean(),
  /**
   * The window this payload was computed over, or `null` for the whole run.
   * Non-null values are SNAPPED to bucket boundaries — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  /**
   * At most six in practice: the five most frequent messages plus the folded
   * remainder, which is what the categorical palette can draw without leaving
   * a series undrawn. Most frequent first.
   *
   * THAT BOUND IS ENFORCED SERVER-SIDE, by `ERROR_SERIES_KEEP` in
   * `@perfportal/statistics`, and is deliberately NOT a `.max(6)` here. This
   * schema also runs in the browser through `apiFetch`, so a bound would turn
   * a seventh series — a cosmetic problem `assignPalette` already handles by
   * drawing six and saying so — into a rejected payload and a chart that fails
   * to load. Degrading gracefully beats failing loudly for a server-side
   * invariant the client cannot repair. (The `.max()` calls elsewhere in these
   * contracts are all on ingest INPUTS, where rejecting really is the point.)
   *
   * INCLUDES WARM-UP, unlike `/errors`. Series do (PRD 7.4), so on a project
   * with a warm-up window these counts exceed the errors table's totals.
   */
  series: z.array(
    z.object({
      /** `null` is the folded remainder, NOT a message that failed to load. */
      message: z.string().nullable(),
      total: z.number().int(),
      points: z.array(
        z.object({ startOffsetMs: z.number().int(), count: z.number().int() }),
      ),
    }),
  ),
});
export type ErrorSeriesResponse = z.infer<typeof ErrorSeriesResponseSchema>;

export const DistributionResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The window this payload was computed over, or `null` for the whole run.
   * Non-null values are SNAPPED to bucket boundaries — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  scope: MetricScopeSchema,
  name: z.string(),
  family: MetricFamilySchema,
  /** Bucket MIDPOINTS, matching Gatling's category labels. */
  labels: z.array(z.number()),
  okCount: z.array(z.number().int()),
  koCount: z.array(z.number().int()),
  /** Percent of the COMBINED OK+KO count. The two series together sum to 100. */
  okPercent: z.array(z.number()),
  koPercent: z.array(z.number()),
  /** True when the range was narrow enough that Gatling skips bucketing. */
  exactValues: z.boolean(),
  /** Non-zero means observations exceeded the histogram cap and bins are incomplete above it. */
  overflowCount: z.number().int(),
});
export type DistributionResponse = z.infer<typeof DistributionResponseSchema>;

export const UsersResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The window this payload was computed over, or `null` for the whole run.
   * Non-null values are SNAPPED to bucket boundaries — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  scenarios: z.array(
    z.object({
      scenario: z.string(),
      buckets: z.array(
        z.object({
          startOffsetMs: z.number().int(),
          started: z.number().int(),
          ended: z.number().int(),
          maxConcurrent: z.number().int(),
        }),
      ),
    }),
  ),
  /**
   * The per-scenario sum at each offset. Gatling's own 'All users' series is
   * exactly this sum in both charts, verified across all 63 fixture buckets -
   * so summing per-scenario maxima is REQUIRED for parity here, even though
   * max(a+b) != max(a)+max(b) in general.
   */
  total: z.array(
    z.object({
      startOffsetMs: z.number().int(),
      started: z.number().int(),
      ended: z.number().int(),
      maxConcurrent: z.number().int(),
    }),
  ),
});
export type UsersResponse = z.infer<typeof UsersResponseSchema>;

export const ScatterResponseSchema = z.object({
  runId: z.string().uuid(),
  name: z.string(),
  /**
   * The window this payload was computed over, or `null` for the whole run.
   * Non-null values are SNAPPED to bucket boundaries — see WindowSchema.
   */
  window: WindowSchema.nullable(),
  /** [global requests/s, this request's truncated p95 in that bucket]. */
  ok: z.array(z.tuple([z.number().int(), z.number().int()])),
  ko: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type ScatterResponse = z.infer<typeof ScatterResponseSchema>;

/**
 * One run in a cohort, as `GET /v1/runs/:id/trends` reports it: run identity
 * plus the run-scope `StatRow` already stored for it.
 *
 * NOT A `StatRow` WITH EXTRA FIELDS, deliberately. `StatRow` carries `scope`,
 * `name`, `family` and `indicators`, and every one of those is either constant
 * across this whole response — `scope: 'run'`, `name: ''`, `family:
 * 'response_time'`, which is what the endpoint's join pins — or, in
 * `indicators`' case, a fold at project settings this endpoint does not read.
 * Reusing the schema would ship four fields per run that mean nothing here,
 * one of which would be an outright lie.
 *
 * `stddevMs` is likewise absent: nothing on the three trend figures plots it,
 * and a field carried "in case" is a field a later reader has to work out the
 * provenance of.
 */
export const TrendRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  /** The tool's own start. Null until the worker parses the run header. */
  toolStartedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
  verdict: RunVerdictSchema.nullable(),
  count: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  errorRate: z.number(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  throughputRps: z.number(),
  /** Keys are p<number>, exactly as `StatRow.percentiles` are. */
  percentiles: z.record(z.number()),
});
export type TrendRun = z.infer<typeof TrendRunSchema>;

/**
 * `GET /v1/runs/:id/trends` — the asked-about run in the context of its
 * cohort.
 *
 * THE COHORT IS (project, simulation), WITH NULL AS ITS OWN EQUIVALENCE CLASS
 * rather than a wildcard. Two runs that both lack a simulation name are
 * grouped because they match by the same rule — and the UI says the grouping
 * is by absence, rather than claiming they are the same test.
 *
 * `runs` IS NEWEST FIRST, matching `/v1/runs` so the two cannot disagree about
 * what "most recent" means. A trend reads left-to-right in time, so the chart
 * transform reverses it; that is stated in both places precisely so the
 * reversal cannot end up applied twice or not at all.
 *
 * `cohortSize` IS NOT `runs.length`, and the difference is the point: a reader
 * looking at twenty of sixty runs has to be told, rather than shown a
 * truncated history that looks complete.
 *
 * THE ASKED-ABOUT RUN IS ALWAYS IN `runs` when it is terminal, and this is a
 * guarantee the server works for rather than one that falls out. The window is
 * the newest `limit` runs; a run older than that is ADDED BACK, so `runs` holds
 * at most `limit + 1` entries and the last of them may not be adjacent in time
 * to the rest. Consumers must key off `id` and the timestamps rather than
 * assuming consecutive entries are consecutive runs.
 *
 * A non-terminal run has no stat row and so appears in neither `runs` nor
 * `cohortSize`; a gap in a trend reads as a regression, which is the one thing
 * an unparsed run must not look like.
 */
export const TrendsResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * What the tool called the simulation, as this run reported it. Captured
   * execution metadata — NOT the cohort key any more.
   */
  simulation: z.string().nullable(),
  /**
   * THE COHORT, and what it is called.
   *
   * Null means this run belongs to no test, which is a different fact from
   * the null `simulation` beside it: the run may well have a simulation name
   * and simply not have been grouped yet. A null test is a cohort of exactly
   * one — this run — rather than the "every run that could not say what it
   * was" bucket the old string cohort produced.
   */
  test: z
    .object({ id: z.string().uuid(), slug: z.string(), name: z.string() })
    .nullable(),
  /** Total runs matching the cohort, which may exceed `runs.length`. */
  cohortSize: z.number().int(),
  runs: z.array(TrendRunSchema),
});
export type TrendsResponse = z.infer<typeof TrendsResponseSchema>;

/**
 * One sample as an agent sends it. Field names match the Go struct tags in
 * `agent/internal/collect/collect.go` exactly — the two are one wire format,
 * and a rename on either side must be a rename on both.
 *
 * EVERY CUMULATIVE FIELD IS THE RAW COUNTER. There is deliberately no
 * `cpuPercent` and no `rxBytesPerSec`: the sampling interval is the agent's and
 * it drifts, so a rate computed against an assumed interval is wrong by exactly
 * that drift — and a counter reset is detectable in raw values
 * (`current < previous`) and invisible in a rate, where it arrives as a
 * plausible enormous spike that is indistinguishable from a real traffic burst.
 *
 * `.int().nonnegative()` on every counter: a negative since-boot counter is not
 * a reading, and rejecting it at the edge means the delta arithmetic downstream
 * only ever has to consider a RESET, never a negative.
 */
const counter = () => z.number().int().nonnegative();

export const TelemetrySampleSchema = z.object({
  /** ISO 8601, the AGENT's clock. The server stamps its own separately. */
  sampledAt: z.string().datetime(),
  cpuUserMs: counter(),
  cpuSystemMs: counter(),
  cpuIdleMs: counter(),
  cpuIowaitMs: counter(),
  memUsedBytes: counter(),
  memTotalBytes: counter(),
  netRxBytes: counter(),
  netTxBytes: counter(),
  tcpInSegs: counter(),
  tcpOutSegs: counter(),
  tcpRetransSegs: counter(),
  tcpInErrs: counter(),
  tcpActiveOpens: counter(),
  tcpPassiveOpens: counter(),
  /** Kernel TCP state → count, absent when zero. The state set is the OS's. */
  tcpStates: z.record(z.string(), z.number().int().nonnegative()),
});
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;

/**
 * The body of POST /v1/telemetry.
 *
 * ═══ THERE IS NO orgId AND NO projectId, ON PURPOSE ═══
 *
 * Both come from the bearer token. An agent runs on a load generator — a
 * machine an attacker is far likelier to reach than the API — and a
 * payload-supplied tenant would let a token minted for one project write
 * telemetry into another, which the read path would then serve without a
 * murmur. `.strict()` is what makes that a REJECTION rather than a silently
 * ignored field, so a future agent that starts sending one fails loudly on its
 * first request instead of appearing to work.
 */
export const TelemetryBatchSchema = z
  .object({
    /**
     * The generator's label. Free text, NOT a foreign key: hostnames collide
     * and change on ephemeral generators, which is why the agent takes
     * `--host-label`. It is the dimension every telemetry chart groups by.
     */
    host: z.string().min(1).max(255),
    /**
     * Bounded so one request cannot pin the event loop. The agent batches at
     * 30; 500 leaves generous headroom for a backlog flush after an outage
     * while keeping the worst-case body small.
     */
    samples: z.array(TelemetrySampleSchema).min(1).max(500),
  })
  .strict();
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

/** GET /v1/runs/:id/telemetry — one bucket for one host, on the run's own
 *  elapsed axis. See toTelemetrySeries (@perfportal/statistics) for how a
 *  wall-clock sample becomes one of these. */
export const TelemetryPointSchema = z.object({
  startOffsetMs: z.number().int(),
  /**
   * `null` means THIS INTERVAL CANNOT BE MEASURED — the first sample of a
   * host, or an interval spanning a counter reset. Never zero for that: zero
   * would claim the generator did nothing.
   */
  cpuTotalPct: z.number().nullable(),
  cpuUserPct: z.number().nullable(),
  cpuSystemPct: z.number().nullable(),
  /** Gauges. Not nullable — instantaneous readings survive a restart. */
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  rxBytesPerSec: z.number().nullable(),
  txBytesPerSec: z.number().nullable(),
  inSegsPerSec: z.number().nullable(),
  outSegsPerSec: z.number().nullable(),
  retransSegsPerSec: z.number().nullable(),
  inErrsPerSec: z.number().nullable(),
  activeOpensPerSec: z.number().nullable(),
  passiveOpensPerSec: z.number().nullable(),
  tcpStates: z.record(z.string(), z.number().int().nonnegative()),
});
export type TelemetryPoint = z.infer<typeof TelemetryPointSchema>;

export const TelemetryResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * False when no agent reported for this run's window — either because
   * `toolStartedAt` is null (the run never finished parsing, so it HAS no
   * window) or because nothing overlapped it.
   *
   * There is no "the generator was idle" state to confuse this with: an agent
   * that ran produced samples. The UI must say "no telemetry was recorded"
   * rather than draw empty axes, which would read as a quiet machine.
   */
  available: z.boolean(),
  /** The run's own width, so these buckets line up with every other chart. */
  bucketWidthMs: z.number().int().positive(),
  /** The window this payload was computed over, or null for the whole run.
   *  Non-null values are SNAPPED to bucket boundaries — see WindowSchema. */
  window: WindowSchema.nullable(),
  hosts: z.array(
    z.object({
      host: z.string(),
      /**
       * `receivedAt - sampledAt` where that gap was largest, SIGNED. A large
       * negative value means this generator's clock is AHEAD of the server's,
       * and every point below is misaligned on the run's axis by roughly that
       * much — with nothing about the chart looking wrong. The UI warns above
       * CLOCK_SKEW_WARN_MS rather than quietly misaligning.
       */
      clockSkewMs: z.number().int(),
      points: z.array(TelemetryPointSchema),
    }),
  ),
});
export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;
