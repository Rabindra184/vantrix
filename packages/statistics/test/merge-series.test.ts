import { describe, expect, it } from 'vitest';
import {
  BucketSeries, Histogram, bucketLatency, mergeMemberSeries,
  type Bucket, type MemberBucket,
} from '../src/index.js';

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

    const merged = mergeMemberSeries([a, b]);

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
    // member buckets went into it.
    const n = (k: number) => Array.from({ length: k }, (_, i) => 10 + i);
    const a = [bucketAt(0, n(1)), bucketAt(1000, n(2)), bucketAt(2000, n(4)), bucketAt(3000, n(8))];
    const b = [bucketAt(0, n(16)), bucketAt(2000, n(32))];

    const merged = mergeMemberSeries([a, b]);

    expect(merged.widthMs).toBe(2000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 2000]);
    // Bucket 0 holds A's 0 and 1000 plus B's 0; bucket 2000 the rest.
    expect(merged.buckets[0]!.startedCount).toBe(1 + 2 + 16);
    expect(merged.buckets[1]!.startedCount).toBe(4 + 8 + 32);
    expect(merged.histograms.get(0)!.ok.total).toBe(19);
    expect(merged.histograms.get(2000)!.ok.total).toBe(44);
  });

  it('is exact against one series built from the union', () => {
    // A is a request that stayed at 1 s buckets; B coalesced to 2 s, the way
    // a busy request does once its own series passes its bucket cap. Some of
    // each fail, and some end in a later bucket than they start.
    const aRequests: Request[] = Array.from({ length: 40 }, (_, i) => ({
      startMs: i * 97, endMs: i * 97 + 40 + ((i * 53) % 700), ok: i % 7 !== 0,
    }));
    const bRequests: Request[] = Array.from({ length: 60 }, (_, i) => ({
      startMs: i * 113, endMs: i * 113 + 30 + ((i * 71) % 900), ok: i % 5 !== 3,
    }));
    const a = seriesOf(aRequests, 100);
    const b = seriesOf(bRequests, 4);
    const union = seriesOf([...aRequests, ...bRequests], 4);
    // The fixture really has the shape the case is about.
    expect(a.widthMs).toBe(1000);
    expect(b.widthMs).toBe(2000);
    expect(union.widthMs).toBe(2000);
    expect(union.buckets().some((x) => x.startedCount !== x.endedCount)).toBe(true);
    expect(aRequests.some((r) => !r.ok) && bRequests.some((r) => !r.ok)).toBe(true);

    const merged = mergeMemberSeries([a.buckets(), b.buckets()]);

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

    const merged = mergeMemberSeries([a, b]);

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
      const merged = mergeMemberSeries(members);
      expect({ widthMs: merged.widthMs, buckets: merged.buckets }).toEqual({ widthMs: 1000, buckets: [] });
      expect(merged.histograms.size).toBe(0);
    }
  });

  it('merges into fresh histograms, leaving the members untouched', () => {
    const a = [bucketAt(0, [10, 20], [300])];
    const b = [bucketAt(0, [30], [400])];

    const merged = mergeMemberSeries([a, b]);

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
    // smallest positive gap is 4000, not its real 2000.
    const late = [bucketAt(2000, [10]), bucketAt(0, [20]), bucketAt(4000, [30])];
    const early = [bucketAt(0, [40]), bucketAt(1000, [50])];

    const merged = mergeMemberSeries([late, early]);

    expect(merged.widthMs).toBe(2000);
    expect(merged.buckets.map((x) => x.startOffsetMs)).toEqual([0, 2000, 4000]);
    expect(merged.buckets.map((x) => x.startedCount)).toEqual([3, 1, 1]);
  });

  it('stays exact when a sparse member\'s smallest gap is not a real bucket width', () => {
    // A request called every 3 s at 1 s buckets: its smallest gap is 3000,
    // which is not 1000 x 2^k. B coalesced to 2 s, and its bucket [2000, 4000)
    // holds a request starting at 3500. Merged at 3000, that bucket would land
    // in [0, 3000) and carry the 3500 request with it.
    const aRequests: Request[] = [0, 3000, 6000].map((t) => ({ startMs: t + 100, endMs: t + 300, ok: true }));
    const bRequests: Request[] = [100, 1100, 2100, 3500, 4100, 5100, 6100, 7100].map((t, i) => ({
      startMs: t, endMs: t + 150 + i * 10, ok: i !== 3,
    }));
    const a = seriesOf(aRequests, 100);
    const b = seriesOf(bRequests, 4);
    expect(a.buckets().map((x) => x.startOffsetMs)).toEqual([0, 3000, 6000]);
    expect(b.widthMs).toBe(2000);

    const merged = mergeMemberSeries([a.buckets(), b.buckets()]);

    // A real width, at least every member's.
    expect(merged.widthMs).toBe(4000);
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
});
