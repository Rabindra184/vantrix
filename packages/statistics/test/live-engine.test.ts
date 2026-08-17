import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { LiveEngine, runEngine } from '../src/index.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

/** Sketches and histograms are class instances; compare their observable numbers. */
const comparable = (r: ReturnType<typeof runEngine>) => ({
  stats: r.stats.map((s) => ({
    scope: s.scope, name: s.name, family: s.family,
    count: s.count, okCount: s.okCount, koCount: s.koCount,
    minMs: s.minMs, maxMs: s.maxMs, meanMs: s.meanMs, stddevMs: s.stddevMs,
    percentiles: s.percentiles, throughputRps: s.throughputRps,
    histogramOkTotal: s.histogramOk.total, histogramKoTotal: s.histogramKo.total,
  })),
  series: [...r.series.entries()].map(([k, v]) => [k, v.buckets.map((b) => ({
    startOffsetMs: b.startOffsetMs, startedCount: b.startedCount,
    endedCount: b.endedCount, okCount: b.okCount, koCount: b.koCount,
  }))]),
  users: r.users,
  errors: r.errors,
  errorSeries: r.errorSeries,
  endpointCount: r.endpointCount,
  runStartedAtMs: r.runStartedAtMs,
  simulation: r.simulation,
  description: r.description,
  durationMs: r.durationMs,
  toolAssertions: r.toolAssertions,
});

describe('LiveEngine', () => {
  it('folded event-by-event, equals runEngine over the same events', () => {
    const events = [...parseSimulationLog(readFileSync(LOG))];

    const engine = new LiveEngine();
    for (const e of events) engine.add(e);

    expect(comparable(engine.snapshot())).toEqual(comparable(runEngine(events)));
  });

  it('snapshot is non-destructive — folding continues after it', () => {
    const events = [...parseSimulationLog(readFileSync(LOG))];
    const half = Math.floor(events.length / 2);

    const engine = new LiveEngine();
    for (const e of events.slice(0, half)) engine.add(e);
    const mid = engine.snapshot();
    for (const e of events.slice(half)) engine.add(e);
    const end = engine.snapshot();

    // Derived from the payload, never written down: the run's total request
    // count must grow between the two snapshots, and the second must equal a
    // batch fold of everything.
    const runCount = (r: ReturnType<typeof runEngine>) =>
      r.stats.find((s) => s.scope === 'run' && s.family === 'response_time')?.count ?? 0;

    expect(runCount(mid)).toBeGreaterThan(0);
    expect(runCount(end)).toBeGreaterThan(runCount(mid));
    expect(comparable(end)).toEqual(comparable(runEngine(events)));
  });

  it('a cloned snapshot does not move when more events are folded in', () => {
    const events = [...parseSimulationLog(readFileSync(LOG))];
    const half = Math.floor(events.length / 2);

    const engine = new LiveEngine();
    for (const e of events.slice(0, half)) engine.add(e);

    const snap = engine.snapshot({ clone: true });
    const runStat = snap.stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    if (!runStat) throw new Error('fixture produced no run-scope response_time rollup');

    // Read the sketch and histogram BEFORE folding the rest in.
    const p95Before = runStat.sketch.quantile(0.95);
    const okTotalBefore = runStat.histogramOk.total;

    for (const e of events.slice(half)) engine.add(e);

    // The snapshot is a value, not a view: nothing about it may have changed.
    expect(runStat.sketch.quantile(0.95)).toBe(p95Before);
    expect(runStat.histogramOk.total).toBe(okTotalBefore);

    // And the engine really did keep going, so the test is not vacuously true.
    const after = engine.snapshot({ clone: true })
      .stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    expect(after?.histogramOk.total).toBeGreaterThan(okTotalBefore);
  });
});
