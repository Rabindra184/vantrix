import { bucketLatency, type BucketLatency } from './bucket-latency.js';
import { inferBucketWidthMs } from './buckets.js';
import { Histogram } from './histogram.js';

/**
 * One stored bucket of one member's series, as the reader hands it over: the
 * persisted counts beside that bucket's own OK and KO histograms.
 *
 * `okCount`/`koCount` are the END-edge outcome split and the two started
 * counts the START-edge split, exactly as `Bucket` carries them — except that
 * a started count is `null` for a row written before its column existed.
 */
export interface MemberBucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  startedOkCount: number | null;
  startedKoCount: number | null;
  histogramOk: Histogram;
  histogramKo: Histogram;
}

export interface MergedSeries {
  /** The width every merged bucket spans: a real one, 1000 x 2^k. */
  widthMs: number;
  /** Ascending by offset, each with the fields the engine's writer stores. */
  buckets: Array<Omit<MemberBucket, 'histogramOk' | 'histogramKo'> & BucketLatency>;
  /**
   * Each merged bucket's OK and KO histograms, keyed by its offset, so a
   * caller can answer extra ranks (`/series?percentiles=`) from them.
   */
  histograms: Map<number, { ok: Histogram; ko: Histogram }>;
}

interface Accumulator {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  startedOkCount: number | null;
  startedKoCount: number | null;
  ok: Histogram;
  ko: Histogram;
}

/**
 * Several request series as ONE: every request of a group, merged exactly from
 * the members' stored per-bucket histograms.
 *
 * Each request series coalesces on its own, so two members can carry
 * different widths. Every real width is 1000 x 2^k from offset 0, so a finer
 * bucket falls inside exactly one coarser one — re-bucketing to the coarsest
 * member width by `floor(offset / width) * width` and merging histograms is
 * therefore exact, the same argument that makes `BucketSeries`' own coalescing
 * lossless. The latency fields come from `bucketLatency`, the function the
 * engine writes them with, so a merged bucket cannot disagree with a series
 * the engine would have built from the union.
 *
 * ═══ THE WIDTH IS ROUNDED UP TO A REAL ONE ═══
 *
 * A member's width is read with `inferBucketWidthMs`, its smallest positive
 * gap — which is an upper bound on the real width, and not always a real
 * width itself: a request called every 3 s at 1 s buckets has no gap under
 * 3000. Merged at 3000, a 2 s member's bucket [2000, 4000) would land whole in
 * [0, 3000), carrying everything from 3000 to 4000 into the wrong bucket. The
 * next 1000 x 2^k at or above the largest gap is divisible by every member's
 * real width, so no member bucket straddles a merged one. On a member set
 * whose gaps are already real widths this changes nothing.
 *
 * A started count is `null` when any contributor's is, column by column: a
 * sum over an unknown is unknown, while the other column's sum stays exact.
 * The histograms merge into fresh `Histogram`s — a member's are the reader's,
 * and writing into the first would change what every other reader of it sees.
 */
export function mergeMemberSeries(members: readonly (readonly MemberBucket[])[]): MergedSeries {
  let largestGapMs = 0;
  for (const member of members) {
    if (member.length === 0) continue;
    // Sorted first: the smallest positive gap is only that between NEIGHBOURS.
    const offsets = member.map((b) => b.startOffsetMs).sort((x, y) => x - y);
    largestGapMs = Math.max(largestGapMs, inferBucketWidthMs(offsets));
  }
  const widthMs = realWidthAtLeast(largestGapMs);

  const byOffset = new Map<number, Accumulator>();
  for (const member of members) {
    for (const b of member) {
      const startOffsetMs = Math.floor(b.startOffsetMs / widthMs) * widthMs;
      let acc = byOffset.get(startOffsetMs);
      if (!acc) {
        acc = {
          startOffsetMs, startedCount: 0, endedCount: 0, okCount: 0, koCount: 0,
          startedOkCount: 0, startedKoCount: 0, ok: new Histogram(), ko: new Histogram(),
        };
        byOffset.set(startOffsetMs, acc);
      }
      acc.startedCount += b.startedCount;
      acc.endedCount += b.endedCount;
      acc.okCount += b.okCount;
      acc.koCount += b.koCount;
      acc.startedOkCount = sumOrNull(acc.startedOkCount, b.startedOkCount);
      acc.startedKoCount = sumOrNull(acc.startedKoCount, b.startedKoCount);
      acc.ok.merge(b.histogramOk);
      acc.ko.merge(b.histogramKo);
    }
  }

  const merged = [...byOffset.values()].sort((x, y) => x.startOffsetMs - y.startOffsetMs);
  return {
    widthMs,
    buckets: merged.map((acc) => ({
      startOffsetMs: acc.startOffsetMs,
      startedCount: acc.startedCount,
      endedCount: acc.endedCount,
      okCount: acc.okCount,
      koCount: acc.koCount,
      startedOkCount: acc.startedOkCount,
      startedKoCount: acc.startedKoCount,
      ...bucketLatency({ histogramOk: acc.ok, histogramKo: acc.ko }),
    })),
    histograms: new Map(merged.map((acc) => [acc.startOffsetMs, { ok: acc.ok, ko: acc.ko }])),
  };
}

/** The smallest real bucket width, 1000 x 2^k, at or above `ms`. */
function realWidthAtLeast(ms: number): number {
  let width = 1000;
  while (width < ms) width *= 2;
  return width;
}

function sumOrNull(total: number | null, add: number | null): number | null {
  return total === null || add === null ? null : total + add;
}
