import { z } from 'zod';

/**
 * Summary statistics included in a delta, updated by the fold engine on each
 * tick. These are the aggregates across all requests in the run so far.
 */
export const LiveSummarySchema = z.object({
  count: z.number(),
  okCount: z.number(),
  koCount: z.number(),
  /**
   * A ratio: errorRate ranges [0, 1]. Matching how `StatRollup.errorRate` is
   * computed upstream, never a percentage or a raw count that the reader
   * has to know the formula for.
   */
  errorRate: z.number().min(0).max(1),
  /**
   * Percentile latencies as a record map: { 'p50': 123, 'p95': 456, ... }.
   * Keys are string labels like 'p50', 'p99', etc.
   */
  percentiles: z.record(z.string(), z.number()),
  maxUsers: z.number(),
  durationMs: z.number(),
});
export type LiveSummary = z.infer<typeof LiveSummarySchema>;

/**
 * A single bucket in a response-time or user-count series, one bucket-width
 * window aligned to the start of the run.
 */
export const LiveSeriesBucketSchema = z.object({
  /**
   * Milliseconds since the run started. Multiple buckets in one series always
   * have unique offsets, and they are sorted in ascending order.
   */
  startOffsetMs: z.number(),
  startedCount: z.number(),
  endedCount: z.number(),
  okCount: z.number(),
  koCount: z.number(),
});
export type LiveSeriesBucket = z.infer<typeof LiveSeriesBucketSchema>;

/**
 * A delta published by the fold engine to Redis on a timer, carrying the
 * incremental update to a run's statistics since the last delta.
 *
 * The consumer — the browser client in part 2b — detects a dropped message by
 * comparing consecutive `seq` values. A fractional or negative sequence number
 * would make that comparison meaningless, so both are rejected. Same for
 * `bucketWidthMs`: downstream divides by it to convert an offset into a rate,
 * so zero is a division-by-zero and negative is nonsense.
 *
 * `replacesSeries` is required with no default. A missing flag defaulting to
 * `false` would make a full series replacement (when the statistics engine
 * rebalances its buckets partway through a long run) look like an append --
 * which is precisely the silent corruption the flag exists to prevent. See the
 * design's section 3.3.
 */
export const LiveDeltaSchema = z.object({
  runId: z.string(),
  /**
   * A counter the consumer uses to detect dropped messages by comparing
   * consecutive values. Fractional or negative values are meaningless for this
   * purpose, so reject them here rather than leaving it to downstream code.
   */
  seq: z.number().int().min(0),
  /**
   * The width of each bucket in the series, in milliseconds. All buckets in
   * the delta use this width. Downstream divides by this value to convert
   * offsets into rates, so zero is a division-by-zero and negative is
   * nonsense.
   */
  bucketWidthMs: z.number().int().positive(),
  /**
   * Whether this delta replaces the entire series or appends to it. The
   * statistics engine halves its bucket resolution in place partway through
   * long runs, producing deltas that rewrite every bucket's offset. This flag
   * has NO DEFAULT: a missing value throws. A default of `false` would make
   * a replacement look like an append, creating the exact silent failure this
   * schema exists to prevent.
   */
  replacesSeries: z.boolean(),
  summary: LiveSummarySchema,
  responseTime: z.array(LiveSeriesBucketSchema),
  users: z.array(
    z.object({
      scenario: z.string(),
      startOffsetMs: z.number(),
      active: z.number(),
    }),
  ),
});
export type LiveDelta = z.infer<typeof LiveDeltaSchema>;
