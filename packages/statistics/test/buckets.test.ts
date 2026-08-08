import { describe, expect, it } from 'vitest';
import { BucketSeries } from '../src/buckets.js';
import { Sketch } from '../src/sketch.js';

const sample = (i: number) => 20 + ((i * 37) % 500);

describe('BucketSeries coalescing (AC-STAT-2)', () => {
  it('coalesces losslessly — each 4s bucket equals a sketch built from that window directly', () => {
    const coalesced = new BucketSeries({ startMs: 0, maxBuckets: 4 });   // forces 1s -> 2s -> 4s
    const values: number[] = [];
    for (let i = 0; i < 16_000; i++) {
      const v = sample(i);
      values.push(v);
      coalesced.add(i, v, true, 'end');   // 1 event per ms over 16 s
    }
    expect(coalesced.widthMs).toBe(4000);

    const merged = coalesced.buckets();
    expect(merged.length).toBe(4);

    // THE INVARIANT: a coalesced bucket must be indistinguishable from one built
    // directly from exactly the values that fall in its window. If this fails,
    // percentiles are being degraded by re-aggregation and the product is lying.
    for (const b of merged) {
      const direct = new Sketch();
      for (let ms = b.startOffsetMs; ms < b.startOffsetMs + coalesced.widthMs; ms++) {
        const v = values[ms];
        if (v !== undefined) direct.accept(v);
      }
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

  it('enforces maxBuckets cap even with start-only edges', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 4 });
    // Feed many start edges spread over a wide time range
    for (let i = 0; i < 1000; i++) {
      s.add(i * 1000, 100, true, 'start');  // one event per second, over 1000 seconds
    }
    // The cap must hold
    expect(s.buckets().length).toBeLessThanOrEqual(4);

    // Verify start-only edges don't pollute sketch or end counts
    for (const b of s.buckets()) {
      expect(b.startedCount).toBeGreaterThan(0);
      expect(b.endedCount).toBe(0);
      expect(b.okCount).toBe(0);
      expect(b.koCount).toBe(0);
      expect(b.sketch.count).toBe(0);
    }
  });
});

describe('BucketSeries per-status sketches', () => {
  it('routes observations to the OK or KO sketch by status', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 100, true, 'end');
    s.add(0, 100, true, 'end');
    s.add(0, 900, false, 'end');
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
    for (let i = 0; i < 10; i++) s.add(0, 100, true, 'end');
    for (let i = 0; i < 10; i++) s.add(0, 5000, false, 'end');
    const b = s.buckets()[0];
    expect(b!.sketchOk.quantile(0.95)).toBeLessThan(200);
    expect(b!.sketch.quantile(0.95)).toBeGreaterThan(1000);
  });

  it('coalesces all three sketches together', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 2 });
    s.add(0, 10, true, 'end');
    s.add(1000, 20, false, 'end');
    s.add(2000, 30, true, 'end');
    s.add(3000, 40, true, 'end');
    const total = s.buckets().reduce((n, b) => n + b.sketch.count, 0);
    const ok = s.buckets().reduce((n, b) => n + b.sketchOk.count, 0);
    const ko = s.buckets().reduce((n, b) => n + b.sketchKo.count, 0);
    expect(total).toBe(4);
    expect(ok).toBe(3);
    expect(ko).toBe(1);
  });

  it('leaves both status sketches empty for a start edge', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 100, true, 'start');
    const b = s.buckets()[0];
    expect(b?.startedCount).toBe(1);
    expect(b?.sketchOk.count).toBe(0);
    expect(b?.sketchKo.count).toBe(0);
  });
});
