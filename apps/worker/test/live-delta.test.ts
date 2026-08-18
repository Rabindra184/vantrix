import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CanonicalEvent } from '@perfportal/core';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { LiveEngine, runEngine } from '@perfportal/statistics';
import { buildDelta, INITIAL_CURSOR } from '../src/live/delta.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);
const events = () => [...parseSimulationLog(readFileSync(LOG))];

describe('buildDelta', () => {
  it('summarises the run from the payload, not from written-down numbers', () => {
    const all = events();
    const { delta } = buildDelta('r1', runEngine(all), INITIAL_CURSOR);
    const batch = runEngine(all).stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

    expect(delta.summary.count).toBe(batch.count);
    expect(delta.summary.okCount).toBe(batch.okCount);
    expect(delta.summary.koCount).toBe(batch.koCount);
    expect(delta.summary.errorRate).toBeCloseTo(batch.errorRate, 10);
    expect(delta.seq).toBe(0);
    expect(delta.responseTime.replaces).toBe(true);   // first delta always replaces
  });

  it('emits buckets at or past the cursor on the second call, upserting the frontier bucket', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.seq).toBe(1);
    const firstMax = Math.max(...first.delta.responseTime.buckets.map((b) => b.startOffsetMs));
    // At or past, not strictly past: the frontier bucket is upserted, so it
    // may legitimately reappear with a corrected count.
    for (const b of second.delta.responseTime.buckets) expect(b.startOffsetMs).toBeGreaterThanOrEqual(firstMax);
    // And it is not merely allowed to reappear -- it actually does, which is
    // the whole point of upserting rather than appending. Without this
    // assertion the test above would pass just as well under the OLD,
    // strictly-greater filter.
    expect(second.delta.responseTime.buckets.some((b) => b.startOffsetMs === firstMax)).toBe(true);
  });

  it('flags a full replacement when the bucket width changes, independently of the users series', () => {
    const all = events();

    // A tiny cap forces BucketSeries to coalesce partway through. Default
    // maxBucketsUsers is untouched, so the users series has no reason to
    // coalesce at all over this fixture's ~63s duration.
    const engine = new LiveEngine({ maxBucketsRun: 4 });
    const third = Math.floor(all.length / 3);
    for (const e of all.slice(0, third)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(third)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    // Derived, not asserted as a literal: the width MUST have grown for this
    // case to be testing anything, so assert that first.
    expect(second.delta.responseTime.widthMs).toBeGreaterThan(first.delta.responseTime.widthMs);
    expect(second.delta.responseTime.replaces).toBe(true);
    // A replacement carries the WHOLE series, including offset 0.
    expect(Math.min(...second.delta.responseTime.buckets.map((b) => b.startOffsetMs))).toBe(0);

    // The users series coalesces against its OWN cap (maxBucketsUsers,
    // untouched here) on its OWN schedule -- it has no reason to have
    // widened just because the response-time series above did, so its width
    // must still read what it always has. One shared width for both series
    // would fail this assertion by construction.
    expect(second.delta.users.widthMs).toBe(first.delta.users.widthMs);
    expect(second.delta.users.widthMs).toBeLessThan(second.delta.responseTime.widthMs);
  });

  it('does not flag a replacement when the width is unchanged', () => {
    const all = events();
    const engine = new LiveEngine();
    const half = Math.floor(all.length / 2);
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);
    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.responseTime.widthMs).toBe(first.delta.responseTime.widthMs);
    expect(second.delta.responseTime.replaces).toBe(false);
  });

  it('sends users whole every tick, unaffected by the response-time cursor', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(half)) engine.add(e);
    const finalSnapshot = engine.snapshot({ clone: true });
    const second = buildDelta('r1', finalSnapshot, first.next);

    // Every bucket of every scenario in the FULL snapshot, on every tick --
    // never filtered by the response-time cursor (`first.next`), and never
    // fewer than what the engine actually holds. Derived from the payload:
    // this is not the fixture's own bucket count written down, it is
    // `finalSnapshot.users` counted the same way `buildDelta` must.
    const expectedCount = finalSnapshot.users.reduce((n, u) => n + u.buckets.length, 0);
    expect(second.delta.users.buckets.length).toBe(expectedCount);
    // Same invariant on the very first call, where "the cursor" is
    // INITIAL_CURSOR rather than a real one -- users ignores it just as it
    // ignores a real one.
    expect(first.delta.users.buckets.length).toBeGreaterThan(0);
  });

  it('reads the response-time width from the engine field, not by inferring gaps between buckets', () => {
    const all = events();
    const result = runEngine(all);
    const runKey = 'run  response_time';
    const real = result.series.get(runKey);
    if (!real) throw new Error('fixture produced no run-scope response-time series');

    // Thin the buckets so the SMALLEST GAP between what remains is wider
    // than the series' true width -- an inference-based reader (the smallest
    // gap between occupied offsets) would report that wider gap as the
    // width; the engine's own `bucketWidthMs` must not be fooled by it.
    const thinned = real.buckets.filter((_, i) => i % 5 === 0);
    // Guard: the fixture must leave more than one bucket, or there is no gap
    // to be wrong about.
    expect(thinned.length).toBeGreaterThan(1);
    const smallestGapAfterThinning = Math.min(
      ...thinned.slice(1).map((b, i) => b.startOffsetMs - (thinned[i]?.startOffsetMs ?? 0)),
    );
    // Guard: thinning must actually have produced a gap wider than the true
    // width, or this test would pass even with the old, wrong, inferring
    // implementation.
    expect(smallestGapAfterThinning).toBeGreaterThan(real.bucketWidthMs);

    const sparseSeries = new Map(result.series);
    sparseSeries.set(runKey, { ...real, buckets: thinned });
    const sparseResult = { ...result, series: sparseSeries };

    const { delta } = buildDelta('r1', sparseResult, INITIAL_CURSOR);

    expect(delta.responseTime.widthMs).toBe(real.bucketWidthMs);
  });

  it('reduces the users envelope width to the FINEST scenario, not the coarsest', () => {
    // A tiny users cap forces one scenario -- the one with the longer ACTIVE
    // SPAN -- to coalesce, while a short-lived scenario in the SAME run
    // stays at the base width. Span, not event count, is what decides this
    // (see the comment on `UserSeries#sweep` in packages/statistics/src/users.ts),
    // so two events far apart are enough; volume is irrelevant.
    const engine = new LiveEngine({ maxBucketsUsers: 5 });
    const userEvent = (scenario: string, kind: 'start' | 'end', tsMs: number): CanonicalEvent => ({
      type: 'user', scenario, userId: `${scenario}-1`, kind, tsMs,
    });
    engine.add(userEvent('Soak', 'start', 0));
    engine.add(userEvent('Soak', 'end', 10_000));    // long span -> coalesces
    engine.add(userEvent('Quick', 'start', 0));
    engine.add(userEvent('Quick', 'end', 2_000));     // short span -> stays put

    const result = engine.snapshot({ clone: true });
    const soak = result.users.find((u) => u.scenario === 'Soak');
    const quick = result.users.find((u) => u.scenario === 'Quick');
    if (!soak || !quick) throw new Error('expected both scenarios in the snapshot');

    // Derived, not asserted as a literal: the two scenarios MUST actually
    // disagree for this case to be testing anything.
    expect(soak.bucketWidthMs).toBeGreaterThan(quick.bucketWidthMs);

    const { delta } = buildDelta('r1', result, INITIAL_CURSOR);

    // The FINER width, not the coarser one.
    expect(delta.users.widthMs).toBe(quick.bucketWidthMs);
    expect(delta.users.widthMs).toBeLessThan(soak.bucketWidthMs);
    // Every emitted offset -- from EITHER scenario -- must be a multiple of
    // the declared width, or a consumer indexing buckets by
    // `startOffsetMs / widthMs` collides two distinct offsets into one
    // index and silently drops a bucket. This is exactly what declaring the
    // COARSER width would break: the Soak scenario's own offsets are
    // multiples of its 4000ms+ width, which are also multiples of the finer
    // declared width (a coarser real width is always a whole multiple of a
    // finer one), so this holds for both scenarios only because the
    // reduction picked the minimum.
    for (const b of delta.users.buckets) {
      expect(b.startOffsetMs % delta.users.widthMs).toBe(0);
    }
  });
});
