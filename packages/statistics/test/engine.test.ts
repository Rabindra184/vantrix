import { describe, expect, it } from 'vitest';
import { runEngine, BUCKET_PERCENTILES } from '../src/engine.js';
import { inferBucketWidthMs } from '../src/buckets.js';
import type { CanonicalEvent } from '@perfportal/core';

describe('engine — parity additions', () => {
  const events = (): CanonicalEvent[] => [
    { type: 'meta', simulation: 'ParitySimulation', toolVersion: '3.15.1', startedAtMs: 1_000, description: 'a run' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'start', tsMs: 1_000 },
    { type: 'user', scenario: 'Checkout', userId: '2', kind: 'start', tsMs: 1_500 },
    { type: 'request', name: 'list', groups: [], scenario: 'Browse', userId: '1', startMs: 1_000, endMs: 1_100, ok: true },
    { type: 'request', name: 'buy', groups: ['Checkout'], scenario: 'Checkout', userId: '2', startMs: 1_500, endMs: 2_400, ok: false, message: 'boom' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'end', tsMs: 2_000 },
  ];

  it('no longer discards user events', () => {
    const r = runEngine(events());
    const names = r.users.map((u) => u.scenario);
    expect(names).toEqual(['Browse', 'Checkout']);
    expect(r.users[0]?.buckets[0]?.started).toBe(1);
  });

  it('captures simulation name and description from the meta event', () => {
    const r = runEngine(events());
    expect(r.simulation).toBe('ParitySimulation');
    expect(r.description).toBe('a run');
  });

  it('reports duration as the span from run start to the last response', () => {
    expect(runEngine(events()).durationMs).toBe(1_400);   // 2_400 - 1_000
  });

  it('scopes errors so a request page can show its own', () => {
    const r = runEngine(events());
    expect(r.errors).toContainEqual({ scope: 'run', name: '', message: 'boom', count: 1 });
    expect(r.errors).toContainEqual({ scope: 'request', name: 'Checkout/buy', message: 'boom', count: 1 });
  });

  it('stores a FIXED per-bucket percentile band set, not the project’s columns', () => {
    // Buckets persist numbers, not sketches, so a configurable per-bucket set
    // would make history depend on ingest-day configuration. p95 in particular
    // must always exist: Gatling's scatter hardcodes quantile(0.95).
    expect(BUCKET_PERCENTILES).toContain(95);
    expect([...BUCKET_PERCENTILES]).toEqual([25, 50, 75, 80, 85, 90, 95, 99]);
  });

  it('no longer returns an indicators field', () => {
    expect('indicators' in runEngine(events())).toBe(false);
  });

  it('still enforces the endpoint cardinality cap', () => {
    const many: CanonicalEvent[] = [];
    for (let i = 0; i < 12; i++) {
      many.push({ type: 'request', name: `r${i}`, groups: [], userId: 'u', startMs: 0, endMs: 1, ok: true });
    }
    expect(() => runEngine(many, { maxEndpoints: 10 })).toThrow(/cardinality/i);
  });

  it('reports user bucket offsets relative to the run start, not the epoch', () => {
    // The meta event arrives first and sets the run start to 1_000. A UserSeries
    // built before that sees runStartMs = 0 and emits absolute offsets, putting
    // the user charts on a different x-axis from every request series.
    const r = runEngine(events());
    const browse = r.users.find((u) => u.scenario === 'Browse');
    expect(browse?.buckets[0]?.startOffsetMs).toBe(0);
    for (const u of r.users) {
      for (const b of u.buckets) {
        expect(b.startOffsetMs).toBeLessThan(60_000);
      }
    }
  });
});

describe('errors over time', () => {
  const BASE = 1_000;
  const meta: CanonicalEvent = {
    type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: BASE,
  };
  const failed = (startMs: number, endMs: number, message?: string): CanonicalEvent => ({
    type: 'request', name: 'r', groups: [], userId: 'u', startMs, endMs, ok: false, message,
  });
  const passed = (startMs: number, endMs: number): CanonicalEvent => ({
    type: 'request', name: 'r', groups: [], userId: 'u', startMs, endMs, ok: true,
  });

  it('buckets a failure at its END, where koCount is counted', () => {
    // Starts in bucket 0 (offset 900) and fails in bucket 1 (offset 1200), so
    // the two edges disagree and this assertion can tell them apart. It belongs
    // with its own KO, which the run series records on the 'end' edge.
    const r = runEngine([meta, failed(BASE + 900, BASE + 1_200, 'boom')]);
    expect(r.errorSeries.rows).toEqual([{ startOffsetMs: 1_000, message: 'boom', count: 1 }]);
  });

  it('reports the same bucket width as the run-scope response-time series', () => {
    // The alignment the whole design exists for: two charts on one page at one
    // resolution. Derived from the run series, never written down.
    //
    // 4000 one-second requests against a 100-bucket cap forces the run series
    // to halve repeatedly, while the 80 failures never exceed the cap on their
    // own — so this exercises the coalesce rather than a no-op.
    const events: CanonicalEvent[] = [meta];
    for (let i = 0; i < 4_000; i += 1) {
      const startMs = BASE + i * 1_000;
      events.push(i % 50 === 0 ? failed(startMs, startMs + 10, 'boom') : passed(startMs, startMs + 10));
    }
    const r = runEngine(events, { maxBucketsRun: 100 });
    const runSeries = [...r.series.values()].find((s) => s.scope === 'run');
    expect(r.errorSeries.bucketWidthMs).toBe(
      inferBucketWidthMs(runSeries!.buckets.map((b) => b.startOffsetMs)),
    );
  });

  it('INCLUDES warm-up, unlike the flat errors rollup', () => {
    // Series include warm-up (PRD 7.4). If this one did not, a bucket inside
    // the warm-up window would show koCount > 0 on the responses chart and
    // nothing at all here, on the same axis at the same instant.
    const r = runEngine([meta, failed(BASE + 100, BASE + 200, 'boom')], { warmupMs: 5_000 });
    expect(r.errors).toHaveLength(0);
    expect(r.errorSeries.rows).toHaveLength(1);
  });

  it('labels a message-less failure exactly as the flat rollup does', () => {
    const r = runEngine([meta, failed(BASE, BASE + 10)]);
    const flat = r.errors.find((e) => e.scope === 'run');
    expect(r.errorSeries.rows[0]?.message).toBe(flat?.message);
  });

  it('sums to the run series koCount in every bucket', () => {
    // The invariant that makes the two charts reconcile, and the reason the
    // feed is on the end edge. Four distinct messages, so nothing folds.
    const events: CanonicalEvent[] = [meta];
    for (let i = 0; i < 40; i += 1) {
      const startMs = BASE + i * 100;
      events.push(
        i % 3 === 0 ? failed(startMs, startMs + 50, `m${i % 4}`) : passed(startMs, startMs + 50),
      );
    }
    const r = runEngine(events);
    const runSeries = [...r.series.values()].find((s) => s.scope === 'run');

    const drawn = new Map<number, number>();
    for (const row of r.errorSeries.rows) {
      drawn.set(row.startOffsetMs, (drawn.get(row.startOffsetMs) ?? 0) + row.count);
    }
    for (const bucket of runSeries!.buckets) {
      expect(drawn.get(bucket.startOffsetMs) ?? 0).toBe(bucket.koCount);
    }
  });

  it('is empty for a run with no failures', () => {
    expect(runEngine([meta, passed(BASE, BASE + 10)]).errorSeries.rows).toEqual([]);
  });
});
