import { z } from 'zod';

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
   * False when this run has no group-scope series at all — it was ingested
   * before the platform recorded them. An empty `buckets` array is ALSO what a
   * group with no traffic returns, so the two are indistinguishable without
   * this; drawing empty axes would claim the group was measured and found idle.
   *
   * A run-level question, unlike `startedSplitAvailable`, which reads the rows:
   * there the columns are nullable and the rows exist; here the rows are absent.
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
