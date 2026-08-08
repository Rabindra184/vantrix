import { describe, expect, it } from 'vitest';
import { Histogram, HISTOGRAM_KIND } from '../src/histogram.js';

describe('Histogram', () => {
  it('counts exact integer-millisecond observations', () => {
    const h = new Histogram();
    for (const v of [10, 10, 20, 30, 30, 30]) h.accept(v);
    expect(h.total).toBe(6);
    expect(h.min).toBe(10);
    expect(h.max).toBe(30);
    expect(h.sum).toBe(130);
    expect(h.countAt(10)).toBe(2);
    expect(h.countAt(30)).toBe(3);
    expect(h.countAt(15)).toBe(0);
  });

  it('countBelow is a strict less-than, exact at any bound', () => {
    const h = new Histogram();
    for (const v of [799, 800, 801, 1199, 1200, 1201]) h.accept(v);
    expect(h.countBelow(800)).toBe(1);
    expect(h.countBelow(1200)).toBe(4);
    expect(h.countBelow(0)).toBe(0);
    expect(h.countBelow(Number.POSITIVE_INFINITY)).toBe(6);
  });

  it('merges exactly', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [5, 5, 9]) a.accept(v);
    for (const v of [9, 12]) b.accept(v);
    a.merge(b);
    expect(a.total).toBe(5);
    expect(a.countAt(5)).toBe(2);
    expect(a.countAt(9)).toBe(2);
    expect(a.countAt(12)).toBe(1);
    expect(a.min).toBe(5);
    expect(a.max).toBe(12);
    expect(a.sum).toBe(40);
  });

  // The regression the Sketch round-trip bug taught us: assert EVERY derived
  // quantity survives serialization, not just the bin counts.
  it('round-trips losslessly, including min, max, sum and count', () => {
    const h = new Histogram();
    for (const v of [1, 1, 7, 400, 400, 400, 119_999]) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    expect(back.total).toBe(h.total);
    expect(back.min).toBe(h.min);
    expect(back.max).toBe(h.max);
    expect(back.sum).toBe(h.sum);
    expect(back.countAt(400)).toBe(3);
    expect(back.countAt(119_999)).toBe(1);
    expect(back.countBelow(400)).toBe(h.countBelow(400));
    expect([...back.entries()]).toEqual([...h.entries()]);
  });

  it('round-trips an empty histogram', () => {
    const back = Histogram.deserialize(new Histogram().serialize());
    expect(back.total).toBe(0);
    expect(back.min).toBe(0);
    expect(back.max).toBe(0);
    expect(back.sum).toBe(0);
    expect([...back.entries()]).toEqual([]);
  });

  it('folds values above the cap into one overflow bin, keeping count, sum and max exact', () => {
    const h = new Histogram({ capMs: 1000 });
    h.accept(500);
    h.accept(5_000);
    h.accept(9_000);
    expect(h.total).toBe(3);
    expect(h.overflowCount).toBe(2);
    expect(h.sum).toBe(14_500);
    expect(h.max).toBe(9_000);
    expect(h.countBelow(1_000)).toBe(1);
    // Above the cap, countBelow cannot be exact — it must not silently claim to be.
    expect(() => h.countBelow(6_000)).toThrow(/overflow/i);
    const back = Histogram.deserialize(h.serialize());
    expect(back.overflowCount).toBe(2);
    expect(back.sum).toBe(14_500);
    expect(back.max).toBe(9_000);
  });

  it('declares its wire format', () => {
    expect(HISTOGRAM_KIND).toBe('sparse-ms-v1');
  });
});
