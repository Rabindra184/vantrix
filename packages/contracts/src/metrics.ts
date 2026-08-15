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

export const StatsResponseSchema = z.object({
  runId: z.string().uuid(),
  stats: z.array(StatRowSchema),
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
  buckets: z.array(SeriesBucketSchema),
});
export type SeriesResponse = z.infer<typeof SeriesResponseSchema>;

export const ErrorsResponseSchema = z.object({
  runId: z.string().uuid(),
  errors: z.array(z.object({ message: z.string(), count: z.number().int() })),
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
  /** The cohort key. Null is a real cohort, not "unknown". */
  simulation: z.string().nullable(),
  /** Total runs matching the cohort, which may exceed `runs.length`. */
  cohortSize: z.number().int(),
  runs: z.array(TrendRunSchema),
});
export type TrendsResponse = z.infer<typeof TrendsResponseSchema>;
