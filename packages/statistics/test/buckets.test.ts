import { describe, expect, it } from 'vitest';
import { BucketSeries } from '../src/buckets.js';
import { Sketch } from '../src/sketch.js';

const sample = (i: number) => 20 + ((i * 37) % 500);

describe('BucketSeries coalescing (AC-STAT-2)', () => {
  // Replays BucketSeries's own bucketing/coalescing arithmetic (nearest-round
  // at the live width, then floor(idx/2) folding on coalesce) against a raw
  // sample stream, tracking which raw sample indices truly end up in each
  // final bucket. This is a parallel derivation, not a call into
  // BucketSeries — it exists because, unlike floor, nearest-bucket rounding
  // is not scale-consistent (round(round(t/w)/2) != round(t/(2w)) in
  // general — e.g. t=1499, w=1000: folding an already-assigned bucket 1
  // gives 0, but computing fresh at width 2000 gives 1). Because
  // BucketSeries coalesces incrementally — folding buckets built at the OLD
  // width rather than recomputing every raw sample at the new one — final
  // membership depends on insertion history, not on `tsMs` alone, so a
  // bucket's members can no longer be read off as [startOffsetMs,
  // startOffsetMs + widthMs).
  function replayTrueMembership(maxBuckets: number, n: number): Map<number, number[]> {
    let width = 1000;
    let live = new Map<number, number[]>(); // idx at current width -> raw sample indices
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(i / width + 0.5);
      const arr = live.get(idx);
      if (arr) arr.push(i); else live.set(idx, [i]);
      while (live.size > maxBuckets) {
        const next = new Map<number, number[]>();
        for (const [idx2, members] of live) {
          const ni = Math.floor(idx2 / 2);
          const arr2 = next.get(ni);
          if (arr2) arr2.push(...members); else next.set(ni, [...members]);
        }
        live = next;
        width *= 2;
      }
    }
    const byOffset = new Map<number, number[]>();
    for (const [idx, members] of live) byOffset.set(idx * width, members);
    return byOffset;
  }

  it('coalesces losslessly — each bucket equals a sketch built from its true members directly', () => {
    const coalesced = new BucketSeries({ startMs: 0, maxBuckets: 4 });   // forces 1s -> 2s -> 4s -> 8s
    const values: number[] = [];
    for (let i = 0; i < 16_000; i++) {
      const v = sample(i);
      values.push(v);
      // Mirror engine.ts: one add() per edge, same value/ok on both. The
      // sketch is fed on 'start' (bucketed by request start, as Gatling
      // does); 'end' only drives endedCount here.
      coalesced.add(i, v, true, 'start');
      coalesced.add(i, v, true, 'end');   // 1 event per ms over 16 s
    }
    // With floor-based bucketing this run coalesced 1s -> 2s -> 4s (two
    // doublings). Nearest-bucket rounding covers a narrower span in its first
    // (edge-clipped) bucket at every width, so the same 16s/maxBuckets=4 run
    // now needs a third doubling.
    expect(coalesced.widthMs).toBe(8000);

    const merged = coalesced.buckets();
    expect(merged.length).toBe(3);

    // THE INVARIANT: a coalesced bucket must be indistinguishable from one built
    // directly from exactly the values that fall in it. If this fails, percentiles
    // are being degraded by re-aggregation and the product is lying. "Exactly the
    // values that fall in it" is now the replayed true membership above, not a
    // [startOffsetMs, startOffsetMs + widthMs) window — see the comment there.
    const trueMembership = replayTrueMembership(4, 16_000);
    expect(trueMembership.size).toBe(3);
    for (const b of merged) {
      const members = trueMembership.get(b.startOffsetMs);
      expect(members).toBeDefined();
      const direct = new Sketch();
      for (const i of members!) direct.accept(values[i]!);
      expect(b.sketch.count).toBe(direct.count);
      for (const q of [0.5, 0.95, 0.99]) {
        expect(b.sketch.quantile(q)).toBe(direct.quantile(q));
      }
    }

    expect(merged.reduce((n, b) => n + b.endedCount, 0)).toBe(16_000);
  });

  it('never exceeds maxBuckets', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 8 });
    for (let i = 0; i < 100_000; i++) s.add(i * 10, sample(i), true, 'end');
    expect(s.buckets().length).toBeLessThanOrEqual(8);
  });

  it('counts start and end edges separately', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 64 });
    s.add(0, 100, true, 'start');
    s.add(0, 100, true, 'end');
    s.add(0, 100, false, 'end');
    const b = s.buckets()[0]!;
    expect(b.startedCount).toBe(1);
    expect(b.endedCount).toBe(2);
    expect(b.koCount).toBe(1);
  });

  it('enforces maxBuckets cap even with start-only edges, which alone carry the sketch', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 4 });
    // Feed many start edges spread over a wide time range
    for (let i = 0; i < 1000; i++) {
      s.add(i * 1000, 100, true, 'start');  // one event per second, over 1000 seconds
    }
    // The cap must hold
    expect(s.buckets().length).toBeLessThanOrEqual(4);

    // Start edges carry the response time (bucketed by request start, per
    // Gatling's startBucket) but never the responses-per-second counters —
    // those belong to 'end', which was never called here.
    for (const b of s.buckets()) {
      expect(b.startedCount).toBeGreaterThan(0);
      expect(b.endedCount).toBe(0);
      expect(b.okCount).toBe(0);
      expect(b.koCount).toBe(0);
      expect(b.sketch.count).toBe(b.startedCount);
    }
  });
});

describe('BucketSeries per-status sketches', () => {
  // The sketches are fed on 'start' (bucketed by request start, per Gatling's
  // startBucket) — see the "buckets by request START" describe block below.
  it('routes observations to the OK or KO sketch by status', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 100, true, 'start');
    s.add(0, 100, true, 'start');
    s.add(0, 900, false, 'start');
    const b = s.buckets()[0];
    expect(b?.sketchOk.count).toBe(2);
    expect(b?.sketchKo.count).toBe(1);
    expect(b?.sketch.count).toBe(3);          // combined still spans both
  });

  // Gatling's over-time chart is OK-only and its scatter is two independent
  // series; a combined-status percentile is a different number whenever a
  // bucket mixes statuses, which is exactly when it matters.
  it('gives a different OK percentile than the combined one for a mixed bucket', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 10; i++) s.add(0, 100, true, 'start');
    for (let i = 0; i < 10; i++) s.add(0, 5000, false, 'start');
    const b = s.buckets()[0];
    expect(b!.sketchOk.quantile(0.95)).toBeLessThan(200);
    expect(b!.sketch.quantile(0.95)).toBeGreaterThan(1000);
  });

  it('coalesces all three sketches together', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 2 });
    s.add(0, 10, true, 'start');
    s.add(1000, 20, false, 'start');
    s.add(2000, 30, true, 'start');
    s.add(3000, 40, true, 'start');
    const total = s.buckets().reduce((n, b) => n + b.sketch.count, 0);
    const ok = s.buckets().reduce((n, b) => n + b.sketchOk.count, 0);
    const ko = s.buckets().reduce((n, b) => n + b.sketchKo.count, 0);
    expect(total).toBe(4);
    expect(ok).toBe(3);
    expect(ko).toBe(1);
  });

  it('populates the status sketches on the start edge, and leaves them alone on end', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 100, true, 'start');
    const afterStart = s.buckets()[0];
    expect(afterStart?.startedCount).toBe(1);
    expect(afterStart?.sketchOk.count).toBe(1);
    expect(afterStart?.sketchKo.count).toBe(0);

    // A same-bucket 'end' for the same request must not double-count the sketch.
    s.add(0, 100, true, 'end');
    const afterEnd = s.buckets()[0];
    expect(afterEnd?.endedCount).toBe(1);
    expect(afterEnd?.sketchOk.count).toBe(1);
  });
});

describe('BucketSeries buckets by request START, not end (parity with Gatling)', () => {
  // Gatling's RequestPercentilesBuffers.updateRequestPercentilesBuffers (from
  // gatling-charts, buffers/RequestPercentilesBuffers.scala) files every
  // percentile/scatter observation under `startBucket`, derived from the
  // request's START time — never an end-derived bucket. Bucketing is by
  // NEAREST index (see buckets.ts), so bucket 0 covers [-500, 500) and bucket
  // 1 covers [500, 1500) — a request that starts at 300ms and ends at 700ms
  // therefore belongs to Gatling's bucket 0, not bucket 1. If our sketches
  // were still fed on the `end` edge, this same request would land one
  // bucket later than Gatling's, shifting every percentiles-over-time and
  // scatter point that straddles a boundary — which is exactly the parity
  // defect this test pins.
  it('puts the response time in the bucket containing the start timestamp, not the end timestamp', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    // A single request: starts at 300ms (bucket 0, [-500,500)), ends at 700ms
    // (bucket 1, [500,1500)). Mirrors engine.ts: add() called once per edge
    // with the same value/ok, once with 'start' and once with 'end'.
    s.add(300, 400, true, 'start');
    s.add(700, 400, true, 'end');

    const buckets = s.buckets();
    const b0 = buckets.find((b) => b.startOffsetMs === 0);
    const b1 = buckets.find((b) => b.startOffsetMs === 1000);

    // The response time belongs to the START bucket.
    expect(b0?.sketch.count).toBe(1);
    expect(b0?.sketch.quantile(0.5)).toBe(400);
    expect(b0?.sketchOk.count).toBe(1);
    expect(b0?.startedCount).toBe(1);
    // The start edge carries no response yet, so it must not bump the
    // responses-per-second counters.
    expect(b0?.endedCount).toBe(0);
    expect(b0?.okCount).toBe(0);

    // The END bucket gets the responses-per-second counters (it's when the
    // response was observed) but its sketch must stay empty — the value
    // already landed in the start bucket above.
    expect(b1?.sketch.count).toBe(0);
    expect(b1?.sketchOk.count).toBe(0);
    expect(b1?.endedCount).toBe(1);
    expect(b1?.okCount).toBe(1);
    expect(b1?.startedCount).toBe(0);
  });
});
