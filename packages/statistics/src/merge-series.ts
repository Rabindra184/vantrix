import { bucketLatency, type BucketLatency } from './bucket-latency.js';
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
 * bucket falls inside exactly one coarser one — re-bucketing to a width every
 * member's real width divides, by `floor(offset / width) * width`, and merging
 * histograms is therefore exact, the same argument that makes `BucketSeries`'
 * own coalescing lossless. The latency fields come from `bucketLatency`, the
 * function the engine writes them with, so a merged bucket cannot disagree
 * with a series the engine would have built from the union at that width.
 *
 * ═══ THE WIDTH: 1000 FOR A MEMBER THAT NEVER COALESCED, ELSE THE LARGEST
 *     REAL WIDTH ITS OFFSETS ALLOW ═══
 *
 * Nothing stores a series' width; it has to be read off its offsets — and
 * off the cap the series was coalesced against, `maxBucketsEndpoint`, which
 * is why the caller must pass it (the run's FROZEN engine option).
 *
 * A request series coalesces only once its occupied bucket count EXCEEDS the
 * cap (`BucketSeries.add`), and a halving leaves at least half of what it
 * halved, rounded up: so a coalesced series holds at least
 * `ceil((cap + 1) / 2)` buckets, and adding requests never lowers that. A
 * member with FEWER distinct offsets than that never coalesced: its width is
 * exactly 1000, whatever its offsets happen to be divisible by.
 *
 * That rule is what keeps a SPARSE member from coarsening its group. A
 * request called only at 8 s and 16 s, beside one called every second, has
 * offsets all divisible by 8000; read by divisor alone the group merged at
 * 8000, and under `from=10000&to=20000` the series selected [16000, 24000)
 * — four requests after the window — while windowed `/stats` (each member's
 * own 1 s buckets) counted the window's eleven. The final review measured it.
 *
 * A member with at least that many offsets may have coalesced. Its offsets
 * are then all `idx * w` for its real width `w = 1000 x 2^j`, so the largest
 * `1000 x 2^k` dividing EVERY offset is at least `w` — never smaller, so
 * merging at the maximum over the members puts no member bucket across two
 * merged ones. It can be larger than `w` for a member whose occupied buckets
 * happen to sit on a wider grid, and the merge is then coarser than needed:
 * still exact, never splitting a bucket. Nothing else in the offsets can
 * tell those apart.
 *
 * The smallest gap itself (`inferBucketWidthMs`) is not safe to merge at: a
 * request called every 3 s at 1 s buckets has no gap under 3000, and merged
 * at 3000 a 2 s member's bucket [2000, 4000) lands whole in [0, 3000). Rounding
 * that gap up to a real width is safe but coarser than it needs to be — the
 * same 3 s request beside a dense 1 s one would merge the whole group at 4000
 * where 1000 is exact. Each width is a power-of-two multiple of 1000, so the
 * divisor rule reads the 3 s request as 1000 and keeps the group at 1 s.
 *
 * KNOWN LIMIT, NOW ONLY FOR A CAP OF 1: there `ceil(2 / 2)` is 1, so every
 * member may have coalesced, and a member with ONE bucket says nothing about
 * its width — it is read as 1000 (`widestDividingWidth`), wrong whenever that
 * lone bucket is a coalesced one. A cap of 1 is a project's unvalidated
 * `maxBucketsEndpoint`; at any other cap a lone bucket never coalesced.
 *
 * The cap is read as `BucketSeries` reads it: below 1 is 1, a fraction counts
 * by its integer part (a series coalesces at `floor(cap) + 1` buckets), and a
 * NaN never triggers a coalesce, so every member is then 1000.
 *
 * A started count is `null` when any contributor's is, column by column: a
 * sum over an unknown is unknown, while the other column's sum stays exact.
 * The histograms merge into fresh `Histogram`s — a member's are the reader's,
 * and writing into the first would change what every other reader of it sees.
 */
export function mergeMemberSeries(
  members: readonly (readonly MemberBucket[])[],
  /**
   * The cap every member's series was coalesced against: the run's frozen
   * `maxBucketsEndpoint`, `DEFAULT_MAX_BUCKETS_ENDPOINT` when it set none.
   * REQUIRED, with no default: a wrong cap reads a sparse member as wide, or
   * a coalesced one as 1 s, and nothing would say so.
   */
  maxBucketsEndpoint: number,
): MergedSeries {
  const coalescedAtLeast = coalescedFloor(maxBucketsEndpoint);
  let widthMs = 1000;
  for (const member of members) {
    const offsets = member.map((b) => b.startOffsetMs);
    if (new Set(offsets).size < coalescedAtLeast) continue;   // never coalesced: 1000
    widthMs = Math.max(widthMs, widestDividingWidth(offsets));
  }

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

/**
 * The fewest buckets a series coalesced against `cap` can hold:
 * `ceil((cap + 1) / 2)`, with the cap read exactly as `BucketSeries` reads it
 * — `Math.max(1, cap)`, compared by `size > cap`, so a fraction coalesces at
 * `floor(cap) + 1` and a NaN never does (Infinity: no member coalesced).
 */
function coalescedFloor(cap: number): number {
  const effective = Math.max(1, cap);
  if (Number.isNaN(effective)) return Number.POSITIVE_INFINITY;
  return Math.ceil((Math.floor(effective) + 1) / 2);
}

/**
 * The largest real bucket width, 1000 x 2^k, dividing every one of a member's
 * offsets — 1000 when there are fewer than two distinct offsets to read one
 * from. Order-free: divisibility needs no neighbours, unlike a smallest gap.
 */
function widestDividingWidth(offsets: readonly number[]): number {
  const nonZero = [...new Set(offsets)].filter((o) => o !== 0);
  if (new Set(offsets).size < 2) return 1000;
  let width = 1000;
  // Terminates: there is a non-zero offset, and no width above it divides it.
  while (nonZero.every((o) => o % (width * 2) === 0)) width *= 2;
  return width;
}

function sumOrNull(total: number | null, add: number | null): number | null {
  return total === null || add === null ? null : total + add;
}
