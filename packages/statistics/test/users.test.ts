import { describe, expect, it } from 'vitest';
import { UserSeries } from '../src/users.js';

describe('UserSeries', () => {
  it('counts starts and ends per scenario per one-second bucket', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'start', 0);
    s.add('Browse', 'start', 500);
    s.add('Browse', 'end', 1_200);
    s.add('Checkout', 'start', 1_800);
    const byScenario = new Map(s.scenarios().map((e) => [e.scenario, e.buckets]));
    expect(byScenario.get('Browse')?.[0]).toEqual({
      startOffsetMs: 0, started: 2, ended: 0, maxConcurrent: 2,
    });
    expect(byScenario.get('Browse')?.[1]).toEqual({
      startOffsetMs: 1_000, started: 0, ended: 1, maxConcurrent: 2,
    });
    expect(byScenario.get('Checkout')?.[0]).toEqual({
      startOffsetMs: 1_000, started: 1, ended: 0, maxConcurrent: 1,
    });
  });

  it('tracks the PEAK concurrency inside a bucket, not the closing value', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 5; i++) s.add('Browse', 'start', 100 + i);
    for (let i = 0; i < 4; i++) s.add('Browse', 'end', 200 + i);
    const b = s.scenarios()[0]?.buckets[0];
    expect(b?.maxConcurrent).toBe(5);
    expect(b?.started).toBe(5);
    expect(b?.ended).toBe(4);
  });

  it('sorts out-of-order events before sweeping concurrency', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'end', 900);
    s.add('Browse', 'start', 100);
    s.add('Browse', 'start', 200);
    const b = s.scenarios()[0]?.buckets[0];
    expect(b?.maxConcurrent).toBe(2);
  });

  it('carries concurrency across bucket boundaries', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'start', 100);
    s.add('Browse', 'start', 200);
    s.add('Browse', 'end', 5_500);
    const buckets = s.scenarios()[0]?.buckets ?? [];
    expect(buckets.find((b) => b.startOffsetMs === 3_000)?.maxConcurrent).toBe(2);
    expect(buckets.find((b) => b.startOffsetMs === 5_000)?.maxConcurrent).toBe(2);
    expect(buckets.find((b) => b.startOffsetMs === 5_000)?.ended).toBe(1);
  });

  it('coalesces losslessly when the bucket cap is exceeded', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 2 });
    s.add('Browse', 'start', 0);
    s.add('Browse', 'start', 1_000);
    s.add('Browse', 'end', 2_000);
    s.add('Browse', 'start', 3_000);
    const buckets = s.scenarios()[0]?.buckets ?? [];
    expect(buckets.length).toBeLessThanOrEqual(2);
    expect(buckets.reduce((n, b) => n + b.started, 0)).toBe(3);
    expect(buckets.reduce((n, b) => n + b.ended, 0)).toBe(1);
    expect(Math.max(...buckets.map((b) => b.maxConcurrent))).toBe(2);
  });

  it('is empty when no user events were seen', () => {
    expect(new UserSeries({ startMs: 0, maxBuckets: 100 }).scenarios()).toEqual([]);
  });
});
