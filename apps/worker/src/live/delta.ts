import { bucketLatency, type EngineResult } from '@perfportal/statistics';
import type { LiveDelta } from '@perfportal/contracts';

export interface DeltaCursor {
  seq: number;
  /**
   * -1 before the first delta: bucket 0 is a real bucket and must be sent.
   *
   * Tracks the RESPONSE-TIME series only. `users` has no cursor of its own —
   * see "WHY `users` HAS NO CURSOR" below — so there is nothing else for this
   * field to track.
   */
  lastPublishedOffsetMs: number;
  /**
   * 0 before the first delta: no real bucket width is ever 0.
   *
   * Tracks the RESPONSE-TIME series' width only, for the same reason.
   */
  lastBucketWidthMs: number;
}

export const INITIAL_CURSOR: DeltaCursor = {
  seq: 0,
  lastPublishedOffsetMs: -1,
  lastBucketWidthMs: 0,
};

/**
 * One tick's message, plus the cursor the next tick needs.
 *
 * PURE, and deliberately so: the coalesce rule below is the one part of this
 * sub-project that fails silently, and keeping it out of the owner means it
 * can be tested without Redis, blob storage, or a claimed run.
 *
 * ═══ THE COALESCE RULE (response-time series only) ═══
 * `BucketSeries` (packages/statistics/src/buckets.ts) halves its resolution
 * IN PLACE once a run passes `maxBucketsRun`, rewriting every bucket's
 * `startOffsetMs` to fit the new, wider buckets. "Buckets past offset N"
 * therefore stops meaning the same thing across that event: a consumer that
 * has been accumulating buckets by offset has no way to know the ruler it
 * was measuring against just changed size. Nothing throws and nothing logs
 * when this happens — the consumer's picture is just quietly wrong from
 * that tick on, forever, unless it is told.
 *
 * So: whenever the emitted width differs from the width the PREVIOUS delta
 * reported, `responseTime` is a REPLACEMENT. It carries the whole series
 * (from offset 0, not from the cursor) and `responseTime.replaces` is set so
 * the consumer knows to discard whatever it had accumulated and start over
 * from this message.
 *
 * The very first delta is a replacement for the same mechanism, not as a
 * bolted-on special case: `INITIAL_CURSOR.lastBucketWidthMs` is 0, and no
 * real bucket width is ever 0, so the width comparison below is already
 * unequal on the first call.
 *
 * ═══ AND THAT DOES NOT HELP A LATE SUBSCRIBER — READ THIS BEFORE PART 2b ═══
 * An earlier version of this comment claimed the same mechanism "makes a
 * subscriber that joins mid-run correct for free — its first delta,
 * whenever it arrives, replaces rather than appends." IT IS FALSE, and it
 * is the kind of false that a consumer built on top of it would not
 * notice.
 *
 * `replaces` is keyed to THE OWNER'S cursor, not to any subscriber's
 * arrival. Only the RUN's first delta replaces. A subscriber that joins at
 * tick 300 receives delta 300, which is an ordinary upsert window —
 * `responseTime.buckets` covers the frontier and the lookback and nothing
 * before them — so it holds a handful of recent buckets and believes it
 * holds the series.
 *
 * The asymmetry matters and is not an accident: `users` IS correct for a
 * late subscriber, because it is sent WHOLE every tick and has no cursor
 * (see "WHY `users` HAS NO CURSOR" below). Only `responseTime` has this
 * gap, so a consumer can trust one envelope and not the other.
 *
 * PART 2b MUST BOOTSTRAP `responseTime` ON JOIN. Either from the existing
 * REST series endpoint, or by reading `live:{runId}:deltas` back far enough
 * to reach the delta with `seq: 0` — that one, and only that one, carries
 * the series from offset 0. Note the replay stream is capped by an entry
 * count AND a byte budget (`fold-owner.ts`'s `REPLAY_BUDGET_BYTES`), so on
 * a long or a large run `seq: 0` will have been trimmed away and REST is
 * the only option left.
 *
 * Do not "simplify" this into filtering buckets by `since > 0` on every
 * call, or into treating `since` as `0` on a replacement — offset 0 is a
 * real bucket, and a replacement is defined as "no cursor", not "the same
 * cursor filtered differently".
 *
 * ═══ UPSERT, NOT APPEND ═══
 * The newest bucket is still filling when it is first published: a request
 * that lands in it one tick from now has not happened yet. Filtering
 * STRICTLY past the cursor (`>`) publishes that bucket once, at whatever
 * partial count it held at that instant, and then — because its offset never
 * again exceeds the cursor — never sends it again. At the default 5s tick
 * against 1000ms buckets that is one bucket in five, permanently
 * undercounted; at a 1s tick it is every bucket. So the filter below is
 * `>=`: the bucket AT the cursor is re-sent, corrected, on every tick until
 * a strictly newer bucket exists to move the cursor past it. The consumer
 * UPSERTS incoming buckets by `startOffsetMs` rather than appending them, so
 * a re-sent bucket overwrites its own prior, more-partial value instead of
 * duplicating a row.
 *
 * ═══ LOOKBACK: THE FRONTIER IS NOT THE ONLY BUCKET STILL FILLING ═══
 * `engine.ts` folds a request into BOTH its start bucket and its end bucket
 * (see the request branch of `LiveEngine#add`), and the tool's log is
 * ordered by END time. So a request whose duration exceeds one bucket width
 * can increment `startedCount` on a bucket that is ALREADY BEHIND the
 * frontier by the time that request's log line is finally processed — a
 * fast neighbor with a similar end time but a much later start time can
 * advance the frontier past a slow request's start bucket before that slow
 * request's own line (positioned by ITS end time) is even read. `>= since`
 * alone only re-visits the bucket AT the frontier, so it never catches this:
 * requests/s on that earlier bucket is undercounted forever. Not
 * hypothetical for this project — the reference fixture's own p99 exceeds
 * 2400ms against 1000ms buckets, more than two bucket-widths of possible
 * lag.
 *
 * So the re-send window is a LOOKBACK, not just the frontier: buckets are
 * emitted from `since - lookbackMs` onward, where `lookbackMs` is derived
 * from `maxMs` on the run-scope rollup — the slowest response the run has
 * shown SO FAR — rounded UP to a whole number of bucket-widths so the
 * lookback always reaches as far back as a max-latency request's start edge
 * could land. Self-scaling by what the run has actually demonstrated, not a
 * guessed constant, and bounded: `ceil(maxMs / widthMs)` extra buckets
 * re-sent per tick, one per bucket-width of observed tail latency. Upsert
 * (above) is what makes re-sending them safe: each is a correction, not a
 * duplicate.
 *
 * ═══ WHY THE RESPONSE-TIME AND USERS SERIES EACH GET THEIR OWN WIDTH ═══
 * `UserSeries` coalesces against its own `maxBucketsUsers` cap, independent
 * of `maxBucketsRun`, and on its own per-SCENARIO schedule (see
 * `EngineResult.users` in packages/statistics/src/engine.ts). So the two
 * series — and even two scenarios within `users` — are routinely at
 * DIFFERENT widths at the same instant. One shared width, or one flag
 * derived from only one of the series, would be a false statement about
 * whichever series didn't just coalesce. Each series' width is therefore
 * read from the statistics engine's own authoritative field
 * (`series` / `users` entries' `bucketWidthMs`) rather than inferred from
 * gaps between offsets — inference is wrong on a sparse series (a small gap
 * between two occupied buckets is not necessarily the true width) and both
 * mis-scales downstream rate math and fires spurious replacements when the
 * inferred value drifts without any real coalesce.
 *
 * ═══ WHY `users` HAS NO CURSOR ═══
 * `users` is sent WHOLE on every tick, never filtered by a since-cursor.
 * Three reasons: it is bounded by `maxBucketsUsers` regardless of run
 * length, so a whole copy is never large; `UserSeries` gap-fills every
 * bucket across a standing-concurrency plateau, so it is dense rather than
 * sparse and cheap to resend; and it materialises that plateau only up to
 * the last user EVENT, so during a steady phase it lags the response-time
 * series and then fills in BEHIND wherever a shared cursor would have
 * settled — a cursor-based filter drops that catch-up permanently rather
 * than merely delaying it. Sending the whole series removes the failure
 * mode instead of chasing it.
 */
export function buildDelta(
  runId: string,
  result: EngineResult,
  prev: DeltaCursor,
): { delta: LiveDelta; next: DeltaCursor } {
  // The run-scope response-time series is keyed `${scope} ${name} ${family}`
  // with an EMPTY name, so the key is 'run' + ' ' + '' + ' ' + 'response_time'
  // -- two spaces back to back. Getting this wrong returns `undefined` from
  // the Map, silently: no throw, just an always-empty series. See the
  // matching comment on `#runResponseSeries` in packages/statistics/src/engine.ts.
  const runSeries = result.series.get('run  response_time');
  const buckets = runSeries?.buckets ?? [];
  // AUTHORITATIVE: the BucketSeries' own width, never inferred. See "WHY THE
  // RESPONSE-TIME AND USERS SERIES EACH GET THEIR OWN WIDTH" above.
  const responseWidthMs = runSeries?.bucketWidthMs ?? 1000;
  const runStat = result.stats.find((s) => s.scope === 'run' && s.family === 'response_time');

  // See "THE COALESCE RULE" above.
  const replaces = responseWidthMs !== prev.lastBucketWidthMs;
  const since = replaces ? -1 : prev.lastPublishedOffsetMs;

  // See "LOOKBACK: THE FRONTIER IS NOT THE ONLY BUCKET STILL FILLING" above.
  // `maxMs` is 0 before any response has been observed, which makes
  // `lookbackMs` 0 too -- no lookback with nothing yet to look back for.
  const maxMs = runStat?.maxMs ?? 0;
  const lookbackMs = Math.ceil(maxMs / responseWidthMs) * responseWidthMs;
  const emitFloor = since - lookbackMs;

  // `>=`, not `>` -- see "UPSERT, NOT APPEND" above. `emitFloor`, not
  // `since` -- see "LOOKBACK" above: the bucket AT `since` is not the only
  // one that may still need correcting.
  const freshBuckets = buckets.filter((b) => b.startOffsetMs >= emitFloor);
  const responseTimeBuckets: LiveDelta['responseTime']['buckets'] = freshBuckets.map((b) => ({
    startOffsetMs: b.startOffsetMs,
    startedCount: b.startedCount,
    endedCount: b.endedCount,
    okCount: b.okCount,
    koCount: b.koCount,
    startedOkCount: b.startedOkCount,
    startedKoCount: b.startedKoCount,
    // Spread last: bucketLatency owns every latency field, and listing them
    // individually here would be the second copy Task 1 exists to prevent.
    ...bucketLatency(b),
  }));

  // The high-water mark for NEXT tick's `since` must be the max offset this
  // tick actually EMITTED, not the max offset present in the snapshot: the
  // newest bucket can be absent from `buckets()` entirely if it has not yet
  // received an observation (BucketSeries only materialises a bucket on its
  // first `add`). Taking the snapshot's max in that case would set the
  // cursor past a bucket that was never sent, and that bucket would then
  // never be sent -- even under upsert semantics this only reaches buckets
  // already in the snapshot, so a cursor set past one that never existed
  // would keep excluding it forever. When nothing fresh was emitted this
  // tick, the cursor simply does not move.
  //
  // Falls back to `since`, the true (non-widened) frontier, NOT `emitFloor`:
  // the lookback widens what gets RE-SENT, it does not change what counts as
  // the newest bucket actually seen. Using `emitFloor` here would make the
  // cursor retreat every tick that had a lookback, and the lookback would
  // then grow without bound instead of covering a fixed multiple of the
  // observed tail.
  const lastPublishedOffsetMs =
    freshBuckets.length > 0 ? Math.max(...freshBuckets.map((b) => b.startOffsetMs)) : since;

  // Peak concurrent users across the whole run so far. Scenarios run
  // concurrently, so the run's own peak is the per-scenario PEAKS SUMMED at
  // each offset, not the largest single-scenario peak -- the same rule
  // UsersResponse's `total` series applies in apps/api/src/metrics/parity.controller.ts
  // ("Gatling's own 'All users' series is exactly this sum"). Built from the
  // whole snapshot: this is a cumulative run-so-far summary field, like
  // `summary.count` and `summary.durationMs` beside it, not a per-tick delta.
  const concurrencyByOffset = new Map<number, number>();
  for (const { buckets: userBuckets } of result.users) {
    for (const b of userBuckets) {
      concurrencyByOffset.set(b.startOffsetMs, (concurrencyByOffset.get(b.startOffsetMs) ?? 0) + b.maxConcurrent);
    }
  }
  const maxUsers = concurrencyByOffset.size === 0 ? 0 : Math.max(...concurrencyByOffset.values());

  // The users envelope's OWN width. Each scenario carries its own
  // `bucketWidthMs` (they coalesce independently, BY SPAN not volume -- see
  // the comment on `UserSeries#sweep` in packages/statistics/src/users.ts --
  // so two scenarios of very different duration in the same run routinely
  // disagree), and the wire shape has one `widthMs` for the whole envelope.
  //
  // This must be the MINIMUM of the per-scenario widths, not the maximum.
  // Every real width is `1000 * 2^k`, so the FINEST width divides every
  // COARSER scenario's offsets exactly, while a coarser width does not
  // divide a finer scenario's. Declaring anything but the minimum leaves
  // some scenario's real offsets (1000, 3000, 5000, ...) as non-multiples of
  // the declared width -- and a consumer that indexes buckets by
  // `floor(startOffsetMs / widthMs)`, which the batch path
  // (apps/api/src/metrics/parity.controller.ts) does exactly, collides two
  // distinct offsets into one index and silently drops a bucket. Declaring
  // the minimum only makes a coarser scenario's series read as sparse
  // against that finer grid, which is true rather than wrong.
  const usersWidthMs =
    result.users.length === 0 ? 1000 : Math.min(...result.users.map((u) => u.bucketWidthMs));

  // WHOLE, not filtered by `since` -- see "WHY `users` HAS NO CURSOR" above.
  const usersBuckets: LiveDelta['users']['buckets'] = result.users.flatMap(
    ({ scenario, buckets: userBuckets }) =>
      userBuckets.map((b) => ({ scenario, startOffsetMs: b.startOffsetMs, active: b.maxConcurrent })),
  );

  const delta: LiveDelta = {
    runId,
    seq: prev.seq,
    summary: {
      count: runStat?.count ?? 0,
      okCount: runStat?.okCount ?? 0,
      koCount: runStat?.koCount ?? 0,
      errorRate: runStat?.errorRate ?? 0,
      percentiles: runStat?.percentiles ?? {},
      maxUsers,
      durationMs: result.durationMs,
    },
    responseTime: {
      widthMs: responseWidthMs,
      replaces,
      buckets: responseTimeBuckets,
    },
    users: {
      widthMs: usersWidthMs,
      buckets: usersBuckets,
    },
  };

  const next: DeltaCursor = {
    seq: prev.seq + 1,
    lastPublishedOffsetMs,
    lastBucketWidthMs: responseWidthMs,
  };

  return { delta, next };
}
