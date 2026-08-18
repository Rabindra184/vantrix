import { z } from 'zod';

/**
 * Summary statistics included in a delta, updated by the fold engine on each
 * tick. These are the aggregates across all requests in the run so far.
 *
 * Count fields match `StatRowSchema` from `metrics.ts` exactly, which is built
 * from the same `StatRollup` upstream. Identical fields crossing the batch wire
 * and the live wire must have identical constraints, so both reject fractional
 * values.
 */
export const LiveSummarySchema = z.object({
  count: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
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
 * A single bucket in the response-time series, one bucket-width window
 * aligned to the start of the run.
 *
 * All count and offset fields match `SeriesBucketSchema` from `metrics.ts`
 * exactly, which is built from the same `Bucket` upstream. Identical fields
 * crossing the batch wire and the live wire must have identical constraints, so
 * both reject fractional values.
 *
 * The SAME shape `SeriesBucketSchema` uses (`metrics.ts`), field for field and
 * nullability for nullability -- so a live bucket and a persisted one are
 * indistinguishable to `toPercentiles` and the chart transforms need no live
 * branch. The nullable started splits are nullable in the REST schema because
 * old persisted rows may lack them; a live bucket always sends a number.
 */
export const LiveSeriesBucketSchema = z.object({
  /**
   * Milliseconds since the run started. Multiple buckets in one series always
   * have unique offsets, and they are sorted in ascending order.
   */
  startOffsetMs: z.number().int(),
  startedCount: z.number().int(),
  endedCount: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  startedOkCount: z.number().int().nullable(),
  startedKoCount: z.number().int().nullable(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  percentiles: z.record(z.string(), z.number()),
  percentilesOk: z.record(z.string(), z.number()),
  percentilesKo: z.record(z.string(), z.number()),
});
export type LiveSeriesBucket = z.infer<typeof LiveSeriesBucketSchema>;

/**
 * The response-time series, WITH its own width and its own replacement flag.
 *
 * This is deliberately a separate envelope from `users` below rather than one
 * shared width/flag pair on the delta as a whole: `BucketSeries` (response
 * time) and `UserSeries` (users) coalesce on independent schedules -- each
 * halves its own resolution against its own bucket cap, on its own timeline
 * -- so the two are routinely at DIFFERENT widths at the same instant (16000ms
 * for responses against 1000ms for users has been measured under one test
 * configuration). A single width would be a false statement about whichever
 * series didn't just coalesce, and a single flag derived from one series
 * would let the OTHER series' coalesce rewrite every one of its offsets while
 * the message claims nothing changed.
 */
export const LiveResponseTimeSchema = z.object({
  /**
   * The width of each bucket in THIS series, in milliseconds. Read straight
   * from the statistics engine's own `BucketSeries.widthMs`, never inferred
   * from the gaps between offsets -- a sparse series' smallest gap is not its
   * width. Downstream divides by this value to convert an offset into a
   * rate, so zero is a division-by-zero and negative is nonsense.
   */
  widthMs: z.number().int().positive(),
  /**
   * Whether `buckets` replaces the consumer's whole accumulated series, or
   * upserts into it by `startOffsetMs`. The statistics engine halves its
   * bucket resolution in place partway through long runs, rewriting every
   * bucket's offset -- when that happens, "buckets past the cursor" stops
   * meaning the same thing, and only a full replacement keeps the consumer
   * correct. This flag has NO DEFAULT: a missing value throws. A default of
   * `false` would make a replacement look like an ordinary upsert, creating
   * the exact silent corruption the flag exists to prevent. See the design's
   * section 3.3.
   */
  replaces: z.boolean(),
  /**
   * Buckets at or past the fold owner's cursor, keyed by `startOffsetMs` --
   * the consumer UPSERTS each one rather than appending, because the newest
   * bucket is still filling when it is first published and is re-sent,
   * corrected, on a later tick until a newer bucket exists.
   */
  buckets: z.array(LiveSeriesBucketSchema),
});
export type LiveResponseTime = z.infer<typeof LiveResponseTimeSchema>;

/**
 * A single bucket in a per-scenario user-concurrency series.
 *
 * `startOffsetMs` matches `UsersResponseSchema` from `metrics.ts` in requiring
 * an integer, for the same reason as `LiveSeriesBucketSchema.startOffsetMs`
 * above: it is built from the same integer `UserBucket.startOffsetMs`
 * upstream and can never legitimately be fractional.
 */
export const LiveUserBucketSchema = z.object({
  scenario: z.string(),
  startOffsetMs: z.number().int(),
  active: z.number(),
});
export type LiveUserBucket = z.infer<typeof LiveUserBucketSchema>;

/**
 * The user-concurrency series, sent WHOLE on every tick -- unlike
 * `responseTime`, this carries no cursor and no replacement flag, because
 * there is no partial form of it to send.
 *
 * Three reasons upserting-by-cursor was tried and dropped for this series:
 * it is bounded by `maxBucketsUsers` regardless of run length, so a whole
 * copy is never large; `UserSeries` gap-fills every bucket across a standing
 * plateau (so it is dense, not sparse, and cheap to re-send in full); and it
 * materialises that plateau only up to the last user EVENT, so it lags the
 * response series during a steady phase and then fills in BEHIND any shared
 * cursor -- which a cursor-based filter would drop permanently rather than
 * catch up on. Sending the whole series removes that failure mode instead of
 * chasing it.
 */
export const LiveUsersSchema = z.object({
  /**
   * The width of each bucket in THIS series. Read from the statistics
   * engine's own per-scenario width, for the same reason `responseTime.widthMs`
   * is -- never inferred.
   */
  widthMs: z.number().int().positive(),
  buckets: z.array(LiveUserBucketSchema),
});
export type LiveUsers = z.infer<typeof LiveUsersSchema>;

/**
 * A delta published by the fold engine to Redis on a timer, carrying the
 * incremental update to a run's statistics since the last delta.
 *
 * The consumer — the browser client in part 2b — detects a dropped message by
 * comparing consecutive `seq` values. A fractional or negative sequence number
 * would make that comparison meaningless, so both are rejected.
 */
export const LiveDeltaSchema = z.object({
  runId: z.string().uuid(),
  /**
   * A counter the consumer uses to detect dropped messages by comparing
   * consecutive values. Fractional or negative values are meaningless for this
   * purpose, so reject them here rather than leaving it to downstream code.
   */
  seq: z.number().int().min(0),
  summary: LiveSummarySchema,
  responseTime: LiveResponseTimeSchema,
  users: LiveUsersSchema,
});
export type LiveDelta = z.infer<typeof LiveDeltaSchema>;
