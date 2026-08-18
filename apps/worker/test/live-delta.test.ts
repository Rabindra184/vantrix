import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
    expect(delta.replacesSeries).toBe(true);   // first delta always replaces
  });

  it('emits only buckets past the cursor on the second call', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.seq).toBe(1);
    const firstMax = Math.max(...first.delta.responseTime.map((b) => b.startOffsetMs));
    for (const b of second.delta.responseTime) expect(b.startOffsetMs).toBeGreaterThan(firstMax);
  });

  it('flags a full replacement when the bucket width changes', () => {
    const all = events();

    // A tiny cap forces BucketSeries to coalesce partway through.
    const engine = new LiveEngine({ maxBucketsRun: 4 });
    const third = Math.floor(all.length / 3);
    for (const e of all.slice(0, third)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(third)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    // Derived, not asserted as a literal: the width MUST have grown for this
    // case to be testing anything, so assert that first.
    expect(second.delta.bucketWidthMs).toBeGreaterThan(first.delta.bucketWidthMs);
    expect(second.delta.replacesSeries).toBe(true);
    // A replacement carries the WHOLE series, including offset 0.
    expect(Math.min(...second.delta.responseTime.map((b) => b.startOffsetMs))).toBe(0);
  });

  it('does not flag a replacement when the width is unchanged', () => {
    const all = events();
    const engine = new LiveEngine();
    const half = Math.floor(all.length / 2);
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);
    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.bucketWidthMs).toBe(first.delta.bucketWidthMs);
    expect(second.delta.replacesSeries).toBe(false);
  });
});
