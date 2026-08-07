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
});
