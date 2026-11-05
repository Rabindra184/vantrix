import { describe, expect, it } from 'vitest';
import {
  BucketSeries, DEFAULT_MAX_BUCKETS_ENDPOINT, Histogram, bucketLatency, mergeMemberSeries,
  type Bucket, type MemberBucket,
} from '../src/index.js';

/**
 * The cap matters to the width (a series coalesced against `cap` holds at
 * least ceil((cap + 1) / 2) buckets, and only such a member is read by its
 * offsets' divisor), so every case names the one its members were built
 * under. 4 is the small one: ceil(5/2) = 3, so a member needs three buckets
 * before its offsets may speak for a wider width, and two do not.
 */
const DEFAULT = DEFAULT_MAX_BUCKETS_ENDPOINT;
const SMALL_CAP = 4;

const histOf = (values: readonly number[]): Histogram => {
  const h = new Histogram();
  for (const v of values) h.accept(v);
  return h;
};

/** A hand-built stored bucket: counts follow the observations unless overridden. */
function bucketAt(
  startOffsetMs: number,
  ok: readonly number[],
  ko: readonly number[] = [],
  counts: Partial<Omit<MemberBucket, 'startOffsetMs' | 'histogramOk' | 'histogramKo'>> = {},
): MemberBucket {
  return {
    startOffsetMs,
    startedCount: ok.length + ko.length,
    endedCount: ok.length + ko.length,
    okCount: ok.length,
    koCount: ko.length,
    startedOkCount: ok.length,
    startedKoCount: ko.length,
    histogramOk: histOf(ok),
    histogramKo: histOf(ko),
    ...counts,
  };
}

interface Request { startMs: number; endMs: number; ok: boolean }

/**
 * One request series, written by the production writer the way the engine
 * writes a request's (`LiveEngine`'s `epSeries`): one `add` per edge, the same
 * duration and outcome on both, the histogram fed on the start edge.
 */
function seriesOf(requests: readonly Request[], maxBuckets: number): BucketSeries {
  const s = new BucketSeries({ startMs: 0, maxBuckets });
  for (const r of requests) {
    const duration = r.endMs - r.startMs;
    s.add(r.startMs, duration, r.ok, 'start');
    s.add(r.endMs, duration, r.ok, 'end');
  }
  return s;
}

/** What a merged bucket must equal: the stored fields plus `bucketLatency`. */
const expectedOf = (b: Bucket) => ({
  startOffsetMs: b.startOffsetMs,
  startedCount: b.startedCount,
  endedCount: b.endedCount,
  okCount: b.okCount,
  koCount: b.koCount,
  startedOkCount: b.startedOkCount,
  startedKoCount: b.startedKoCount,
  ...bucketLatency(b),
});

describe('mergeMemberSeries', () => {
  it('merges two members of one width bucket by bucket', () => {
    // Every count distinct per field and per member, so a field summed into
    // the wrong one, or a member dropped, shows as a wrong number.
    const a = [
      bucketAt(0, [10, 20, 30], [400], { startedCount: 4, endedCount: 3, okCount: 2, koCount: 1, startedOkCount: 3, startedKoCount: 1 }),
      bucketAt(1000, [15], [], { startedCount: 1, endedCount: 2, okCount: 2, koCount: 0, startedOkCount: 1, startedKoCount: 0 }),
    ];
    const b = [
      bucketAt(0, [12, 90], [700, 800], { startedCount: 40, endedCount: 30, okCount: 20, koCount: 10, startedOkCount: 20, startedKoCount: 20 }),
      bucketAt(1000, [50, 60], [], { startedCount: 200, endedCount: 300, okCount: 100, koCount: 200, startedOkCount: 150, startedKoCount: 50 }),
    ];

    const merged = mergeMemberSeries([a, b], DEFAULT);

    expect(merged.widthMs).toBe(1000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 1000]);
    const [first, second] = merged.buckets;
    expect(first).toMatchObject({ startedCount: 44, endedCount: 33, okCount: 22, koCount: 11, startedOkCount: 23, startedKoCount: 21 });
    expect(second).toMatchObject({ startedCount: 201, endedCount: 302, okCount: 102, koCount: 200, startedOkCount: 151, startedKoCount: 50 });

    // The latency fields are bucketLatency's over the two members' histograms
    // merged by hand — the function the engine writes them with.
    const byHand = bucketLatency({
      histogramOk: histOf([10, 20, 30, 12, 90]),
      histogramKo: histOf([400, 700, 800]),
    });
    expect(first!.percentiles.p95).toBe(byHand.percentiles.p95);
    expect(first).toMatchObject(byHand);
    expect(merged.histograms.get(0)!.ok.total).toBe(5);
    expect(merged.histograms.get(0)!.ko.total).toBe(3);
  });

  it('re-buckets a finer member into a coarser one', () => {
    // Observation counts are powers of two, so every merged total says which
    // member buckets went into it. Under a cap of 4, B's three buckets are
    // enough to have coalesced, and A's four (at most the cap) are at 1 s.
    const n = (k: number) => Array.from({ length: k }, (_, i) => 10 + i);
    const a = [bucketAt(0, n(1)), bucketAt(1000, n(2)), bucketAt(2000, n(4)), bucketAt(3000, n(8))];
    const b = [bucketAt(0, n(16)), bucketAt(2000, n(32)), bucketAt(4000, n(64))];

    const merged = mergeMemberSeries([a, b], SMALL_CAP);

    expect(merged.widthMs).toBe(2000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 2000, 4000]);
    // Bucket 0 holds A's 0 and 1000 plus B's 0; bucket 2000 A's 2000 and
    // 3000 plus B's 2000; bucket 4000 B's alone.
    expect(merged.buckets.map((x) => x.startedCount)).toEqual([1 + 2 + 16, 4 + 8 + 32, 64]);
    expect(merged.histograms.get(0)!.ok.total).toBe(19);
    expect(merged.histograms.get(2000)!.ok.total).toBe(44);
  });

  it('is exact against one series built from the union', () => {
    // A is a request that stayed at 1 s buckets; B coalesced to 2 s, the way
    // a busy request does once its own series passes its bucket cap. Some of
    // each fail, and some end in a later bucket than they start.
    // Thirty, so A's starts and ends fill four 1 s buckets: under the shared
    // cap of 4 it never coalesces, while B, busier, does.
    const aRequests: Request[] = Array.from({ length: 30 }, (_, i) => ({
      startMs: i * 97, endMs: i * 97 + 40 + ((i * 53) % 700), ok: i % 7 !== 0,
    }));
    const bRequests: Request[] = Array.from({ length: 60 }, (_, i) => ({
      startMs: i * 113, endMs: i * 113 + 30 + ((i * 71) % 900), ok: i % 5 !== 3,
    }));
    const a = seriesOf(aRequests, SMALL_CAP);
    const b = seriesOf(bRequests, SMALL_CAP);
    const union = seriesOf([...aRequests, ...bRequests], SMALL_CAP);
    // The fixture really has the shape the case is about.
    expect(a.widthMs).toBe(1000);
    expect(b.widthMs).toBe(2000);
    expect(union.widthMs).toBe(2000);
    expect(union.buckets().some((x) => x.startedCount !== x.endedCount)).toBe(true);
    expect(aRequests.some((r) => !r.ok) && bRequests.some((r) => !r.ok)).toBe(true);

    const merged = mergeMemberSeries([a.buckets(), b.buckets()], SMALL_CAP);

    expect(merged.widthMs).toBe(union.widthMs);
    expect(merged.buckets).toEqual(union.buckets().map(expectedOf));
    for (const u of union.buckets()) {
      const h = merged.histograms.get(u.startOffsetMs)!;
      expect(h.ok.total).toBe(u.histogramOk.total);
      expect(h.ko.total).toBe(u.histogramKo.total);
    }
  });

  it('keeps a started split null when any contributing bucket\'s is null', () => {
    const a = [
      bucketAt(0, [10], [], { startedOkCount: null, startedKoCount: null }),
      bucketAt(1000, [10], [20]),
      bucketAt(2000, [10], [20], { startedOkCount: null }),
    ];
    const b = [bucketAt(0, [30], [40]), bucketAt(1000, [30], [40]), bucketAt(2000, [30], [40, 50])];

    const merged = mergeMemberSeries([a, b], DEFAULT);

    // A row written before the column existed makes the sum unknowable.
    expect(merged.buckets[0]).toMatchObject({ startedOkCount: null, startedKoCount: null });
    // It does not leak into a bucket it did not contribute to.
    expect(merged.buckets[1]).toMatchObject({ startedOkCount: 2, startedKoCount: 2 });
    // Each column on its own: the schema lets them diverge, and a known KO
    // sum is still exact when the OK one is not.
    expect(merged.buckets[2]).toMatchObject({ startedOkCount: null, startedKoCount: 3 });
  });

  it('answers an empty series for no members', () => {
    const cases: (readonly MemberBucket[])[][] = [[], [[], []]];
    for (const members of cases) {
      const merged = mergeMemberSeries(members, DEFAULT);
      expect({ widthMs: merged.widthMs, buckets: merged.buckets }).toEqual({ widthMs: 1000, buckets: [] });
      expect(merged.histograms.size).toBe(0);
    }
  });

  it('merges into fresh histograms, leaving the members untouched', () => {
    const a = [bucketAt(0, [10, 20], [300])];
    const b = [bucketAt(0, [30], [400])];

    const merged = mergeMemberSeries([a, b], DEFAULT);

    expect(a[0]!.histogramOk.total).toBe(2);
    expect(a[0]!.histogramKo.total).toBe(1);
    expect(b[0]!.histogramOk.total).toBe(1);
    const h = merged.histograms.get(0)!;
    expect(h.ok.total).toBe(3);
    for (const input of [a[0]!.histogramOk, a[0]!.histogramKo, b[0]!.histogramOk, b[0]!.histogramKo]) {
      expect(h.ok).not.toBe(input);
      expect(h.ko).not.toBe(input);
    }
  });

  it('does not depend on the order members or their buckets arrive in', () => {
    // A 2 s member whose buckets arrive shuffled: read in that order its
    // smallest positive gap is 4000, not its real 2000. Three buckets under a
    // cap of 4 are enough to have coalesced.
    const late = [bucketAt(2000, [10]), bucketAt(0, [20]), bucketAt(4000, [30])];
    const early = [bucketAt(0, [40]), bucketAt(1000, [50])];

    const merged = mergeMemberSeries([late, early], SMALL_CAP);

    expect(merged.widthMs).toBe(2000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 2000, 4000]);
    expect(merged.buckets.map((x) => x.startedCount)).toEqual([3, 1, 1]);
  });

  it('stays exact when a sparse member\'s smallest gap is not a real bucket width', () => {
    // A request called every 3 s at 1 s buckets: its smallest gap is 3000,
    // which is not 1000 x 2^k. B coalesced to 2 s, and its bucket [2000, 4000)
    // holds a request starting at 3500. Merged at the gap, 3000, that bucket
    // would land in [0, 3000) and carry the 3500 request with it.
    const aRequests: Request[] = [0, 3000, 6000].map((t) => ({ startMs: t + 100, endMs: t + 300, ok: true }));
    const bRequests: Request[] = [100, 1100, 2100, 3500, 4100, 5100, 6100, 7100].map((t, i) => ({
      startMs: t, endMs: t + 150 + i * 10, ok: i !== 3,
    }));
    const a = seriesOf(aRequests, SMALL_CAP);
    const b = seriesOf(bRequests, SMALL_CAP);
    expect(a.buckets().map((x) => x.startOffsetMs)).toEqual([0, 3000, 6000]);
    expect(a.widthMs).toBe(1000);
    expect(b.widthMs).toBe(2000);

    const merged = mergeMemberSeries([a.buckets(), b.buckets()], SMALL_CAP);

    // The widest real width every member's offsets allow: A's 0/3000/6000 are
    // only all divisible by 1000, B's by 2000. Rounding A's 3000 gap up to a
    // real width would say 4000, coarser than anything requires.
    expect(merged.widthMs).toBe(2000);
    // Every merged bucket holds exactly the requests that started inside it.
    const all = [...aRequests, ...bRequests];
    for (const m of merged.buckets) {
      const inside = (t: number) => t >= m.startOffsetMs && t < m.startOffsetMs + merged.widthMs;
      const started = all.filter((r) => inside(r.startMs));
      expect(m.startedCount, `bucket ${m.startOffsetMs}`).toBe(started.length);
      expect(m.endedCount, `bucket ${m.startOffsetMs}`).toBe(all.filter((r) => inside(r.endMs)).length);
      expect(m).toMatchObject(bucketLatency({
        histogramOk: histOf(started.filter((r) => r.ok).map((r) => r.endMs - r.startMs)),
        histogramKo: histOf(started.filter((r) => !r.ok).map((r) => r.endMs - r.startMs)),
      }));
    }
    expect(merged.buckets.reduce((n, m) => n + m.startedCount, 0)).toBe(all.length);
  });

  it('keeps a group at 1 s when a sparse member is still at 1 s buckets', () => {
    // Every 3 s beside a dense request, both at 1 s buckets: the union is a
    // 1 s series, and nothing in either member's offsets calls for coarser.
    // A gap-based width, rounded up, would merge this whole group at 4 s.
    const sparse: Request[] = [0, 3000, 6000].map((t) => ({ startMs: t + 100, endMs: t + 300, ok: true }));
    const dense: Request[] = Array.from({ length: 7 }, (_, i) => ({
      startMs: i * 1000 + 200, endMs: i * 1000 + 450 + i * 20, ok: i !== 4,
    }));
    const a = seriesOf(sparse, 100);
    const b = seriesOf(dense, 100);
    const union = seriesOf([...sparse, ...dense], 100);
    expect(a.buckets().map((x) => x.startOffsetMs)).toEqual([0, 3000, 6000]);
    expect(union.widthMs).toBe(1000);

    const merged = mergeMemberSeries([a.buckets(), b.buckets()], 100);

    expect(merged.widthMs).toBe(1000);
    expect(merged.buckets).toEqual(union.buckets().map(expectedOf));
  });

  it('reads a member with enough buckets to have coalesced, all on a 2 s grid, at 2 s', () => {
    // A request every 10 s: 0, 10000, 20000 are all divisible by 2000, and
    // under a cap of 4 three buckets are enough to have coalesced, so its
    // series could really be at 2 s. Merging at 1 s would split a 2 s bucket,
    // so the group merges at 2 s — exact, if coarser than the dense member.
    // Exactly ceil((4 + 1) / 2) = 3 buckets: one fewer and it never coalesced.
    const tenSecond = [bucketAt(0, [10]), bucketAt(10000, [20]), bucketAt(20000, [30])];
    const dense = [bucketAt(0, [40]), bucketAt(1000, [50]), bucketAt(2000, [60])];

    const merged = mergeMemberSeries([tenSecond, dense], SMALL_CAP);

    expect(merged.widthMs).toBe(2000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 2000, 10000, 20000]);
    expect(merged.buckets.map((x) => x.startedCount)).toEqual([3, 1, 1, 1]);
  });

  it('reads a member with one bucket as 1 s, even away from offset 0', () => {
    // A request called once, four seconds in. Its offset alone allows a 4 s
    // series, but a series left with one bucket never coalesced (short of a
    // maxBucketsEndpoint of 1), and sizing it by that divisor would put the
    // whole group at 4 s for one call.
    const once = [bucketAt(4000, [10])];
    const dense = [bucketAt(0, [20]), bucketAt(1000, [30]), bucketAt(2000, [40])];

    const merged = mergeMemberSeries([once, dense], DEFAULT);

    expect(merged.widthMs).toBe(1000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 1000, 2000, 4000]);
  });

  it('keeps a group at 1 s beside a sparse member whose offsets sit on a wide grid', () => {
    // The final review's construction: one request every second from 0 to
    // 30 s, and one called only at 8 s and 16 s. Both offsets of the second
    // are divisible by 8000, and read by divisor alone the group merged at
    // 8000 — so a 10-20 s window selected [16000, 24000), four requests after
    // it. Two buckets under the default cap never coalesced: it is at 1 s.
    const dense = Array.from({ length: 31 }, (_, i) => bucketAt(i * 1000, [40 + i]));
    const sparse = [bucketAt(8000, [500]), bucketAt(16_000, [600])];

    const merged = mergeMemberSeries([dense, sparse], DEFAULT);

    expect(merged.widthMs).toBe(1000);
    const inWindow = merged.buckets.filter((b) => b.startOffsetMs >= 10_000 && b.startOffsetMs < 20_000);
    // Ten dense seconds and the 16 s call: what windowed /stats counts too.
    expect(inWindow.reduce((n, b) => n + b.startedCount, 0)).toBe(11);
  });

  it('reads a member one bucket short of the coalesced floor at 1 s, on any grid', () => {
    // Under a cap of 4 a coalesced series holds at least 3 buckets, so this
    // member's two — both on a 2 s grid — say it never coalesced.
    const twoOnGrid = [bucketAt(0, [10]), bucketAt(2000, [20])];
    const dense = [bucketAt(0, [40]), bucketAt(1000, [50]), bucketAt(3000, [60])];

    const merged = mergeMemberSeries([twoOnGrid, dense], SMALL_CAP);

    expect(merged.widthMs).toBe(1000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 1000, 2000, 3000]);
  });

  it('pins the known limit at a cap of 1: a lone, possibly coalesced bucket reads as 1 s', () => {
    // At a cap of 1 every series holds one bucket, and a lone bucket at 4 s
    // may be a coalesced one at least 4 s wide. Its offsets cannot say, so it
    // reads as 1000 — the recorded limit, not a claim it is right.
    const merged = mergeMemberSeries([[bucketAt(4000, [10])], [bucketAt(0, [20])]], 1);

    expect(merged.widthMs).toBe(1000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 4000]);
  });
});
