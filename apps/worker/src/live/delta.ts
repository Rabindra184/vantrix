import { inferBucketWidthMs, type EngineResult } from '@perfportal/statistics';
import type { LiveDelta, LiveSeriesBucket } from '@perfportal/contracts';

export interface DeltaCursor {
  seq: number;
  /** -1 before the first delta: bucket 0 is a real bucket and must be sent. */
  lastPublishedOffsetMs: number;
  /** 0 before the first delta: no real bucket width is ever 0. */
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
 * ═══ THE COALESCE RULE ═══
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
 * reported, this delta is a REPLACEMENT. It carries the whole series (from
 * offset 0, not from the cursor) and `replacesSeries` is set so the consumer
 * knows to discard whatever it had accumulated and start over from this
 * message.
 *
 * The very first delta is a replacement for the same mechanism, not as a
 * bolted-on special case: `INITIAL_CURSOR.lastBucketWidthMs` is 0, and no
 * real bucket width is ever 0, so the width comparison below is already
 * unequal on the first call. That is also what makes a subscriber that
 * joins mid-run correct for free — its first delta, whenever it arrives,
 * replaces rather than appends.
 *
 * Do not "simplify" this into filtering buckets by `since > 0` on every
 * call, or into treating `since` as `0` on a replacement — offset 0 is a
 * real bucket, and a replacement is defined as "no cursor", not "the same
 * cursor filtered differently".
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

  // The width this SNAPSHOT's buckets were coalesced to. `|| 1000` is belt
  // and suspenders: inferBucketWidthMs already falls back to 1000 when there
  // are fewer than two buckets to measure a gap between.
  const bucketWidthMs = inferBucketWidthMs(buckets.map((b) => b.startOffsetMs)) || 1000;

  // See "THE COALESCE RULE" above.
  const replacesSeries = bucketWidthMs !== prev.lastBucketWidthMs;
  const since = replacesSeries ? -1 : prev.lastPublishedOffsetMs;

  const freshBuckets = buckets.filter((b) => b.startOffsetMs > since);
  const responseTime: LiveSeriesBucket[] = freshBuckets.map((b) => ({
    startOffsetMs: b.startOffsetMs,
    startedCount: b.startedCount,
    endedCount: b.endedCount,
    okCount: b.okCount,
    koCount: b.koCount,
  }));

  // The high-water mark for NEXT tick's `since` must be the max offset this
  // tick actually EMITTED, not the max offset present in the snapshot: the
  // newest bucket can be absent from `buckets()` entirely if it has not yet
  // received an observation (BucketSeries only materialises a bucket on its
  // first `add`). Taking the snapshot's max in that case would set the
  // cursor past a bucket that was never sent, and that bucket would then
  // never be sent -- `> since` would keep excluding it even once it does
  // gain observations, because its offset never changes. When nothing fresh
  // was emitted this tick, the cursor simply does not move.
  const lastPublishedOffsetMs =
    freshBuckets.length > 0 ? Math.max(...freshBuckets.map((b) => b.startOffsetMs)) : since;

  const runStat = result.stats.find((s) => s.scope === 'run' && s.family === 'response_time');

  // Peak concurrent users across the whole run so far. Scenarios run
  // concurrently, so the run's own peak is the per-scenario PEAKS SUMMED at
  // each offset, not the largest single-scenario peak -- the same rule
  // UsersResponse's `total` series applies in apps/api/src/metrics/parity.controller.ts
  // ("Gatling's own 'All users' series is exactly this sum"). Built from the
  // whole snapshot, not from `freshBuckets`/`since`: this is a cumulative
  // run-so-far summary field, like `summary.count` and `summary.durationMs`
  // beside it, not a per-tick delta.
  const concurrencyByOffset = new Map<number, number>();
  for (const { buckets: userBuckets } of result.users) {
    for (const b of userBuckets) {
      concurrencyByOffset.set(b.startOffsetMs, (concurrencyByOffset.get(b.startOffsetMs) ?? 0) + b.maxConcurrent);
    }
  }
  const maxUsers = concurrencyByOffset.size === 0 ? 0 : Math.max(...concurrencyByOffset.values());

  // Flattened per-scenario buckets, filtered by the SAME cursor as the
  // response-time series: `startOffsetMs` is a real millisecond offset from
  // run start regardless of which series produced it, so "past the cursor"
  // means the same thing here as it does above, even though the user series
  // coalesces independently (its own `maxBucketsUsers` cap) and so is not
  // guaranteed to share a width with the response-time series.
  const users: LiveDelta['users'] = result.users.flatMap(({ scenario, buckets: userBuckets }) =>
    userBuckets
      .filter((b) => b.startOffsetMs > since)
      .map((b) => ({ scenario, startOffsetMs: b.startOffsetMs, active: b.maxConcurrent })),
  );

  const delta: LiveDelta = {
    runId,
    seq: prev.seq,
    bucketWidthMs,
    replacesSeries,
    summary: {
      count: runStat?.count ?? 0,
      okCount: runStat?.okCount ?? 0,
      koCount: runStat?.koCount ?? 0,
      errorRate: runStat?.errorRate ?? 0,
      percentiles: runStat?.percentiles ?? {},
      maxUsers,
      durationMs: result.durationMs,
    },
    responseTime,
    users,
  };

  const next: DeltaCursor = {
    seq: prev.seq + 1,
    lastPublishedOffsetMs,
    lastBucketWidthMs: bucketWidthMs,
  };

  return { delta, next };
}
