import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { runEngine } from '../src/engine.js';
import { bandsFrom } from '../src/indicators.js';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';
const events = [...parseSimulationLog(readFileSync(FIXTURE))];
const result = runEngine(events);
const run = result.stats.find((s) => s.scope === 'run')!;

/** Values Gatling PRINTS. Exact quantities only — never its percentiles (PRD A.9 F-6). */
describe('PT-G: global page exact quantities', () => {
  it('PT-G-11/12 total, OK, KO', () => {
    expect(run.count).toBe(895);
    expect(run.okCount).toBe(871);
    expect(run.koCount).toBe(24);
  });

  /**
   * TWO SPANS, AND THE ARITHMETIC THAT MADE THEM NECESSARY.
   *
   * `durationMs` is anchored at the run HEADER because that is where every
   * bucket `startOffsetMs` is anchored — a time axis spanning anything less
   * drops the final bucket. `activityMs` is anchored at the FIRST EVENT,
   * which is what `throughputRps` divides by and what Gatling's own report
   * calls the duration.
   *
   * Using one for the other made the run page contradict itself, so the
   * binding assertion is the RECONCILIATION: the throughput this engine
   * reports, multiplied by the span it reports, must return the count it
   * reports. Every number is read back off the result rather than written
   * down, so a re-captured fixture moves all of them together.
   */
  it('PT-G-04 reports a header-anchored series span and a first-event activity span', () => {
    // The lead-in is real on this fixture, so the two are genuinely different
    // numbers and the reconciliation below is not trivially satisfied.
    expect(result.durationMs).toBeGreaterThan(result.activityMs);

    const firstStart = Math.min(...events.filter((e) => e.type === 'request').map((e) => e.startMs));
    const lastEnd = Math.max(...events.filter((e) => e.type === 'request').map((e) => e.endMs));
    const meta = events.find((e) => e.type === 'meta')!;

    expect(result.durationMs).toBe(lastEnd - meta.startedAtMs);
    expect(result.activityMs).toBe(lastEnd - firstStart);
  });

  it('PT-G-13 throughput divides by the activity span, so the two reconcile to the count', () => {
    expect(Math.abs(run.throughputRps * (result.activityMs / 1000) - run.count)).toBeLessThan(0.5);
    // And NOT by the series span — the mismatch this pair exists to prevent.
    expect(Math.abs(run.throughputRps * (result.durationMs / 1000) - run.count)).toBeGreaterThan(1);
  });

  it('PT-G-06..09 indicator bands', () => {
    // Bands are now folded from the run's OK histogram at read time rather
    // than counted by the engine during ingest (see indicators.ts).
    expect(bandsFrom(run.histogramOk, run.koCount, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 848, between: 0, over: 23, failed: 24,
    });
  });

  it('PT-G-12 max, mean, stddev match Gatling exactly', () => {
    expect(run.maxMs).toBe(2503);
    expect(Math.round(run.meanMs)).toBe(228);
    expect(Math.round(run.stddevMs)).toBe(370);
  });

  it('PT-G-29 error table', () => {
    // Errors are now scoped per (scope, name); the global page's table is the run scope.
    expect(result.errors.filter((e) => e.scope === 'run')).toEqual([
      { scope: 'run', name: '', message: 'status.find.is(200), found 500', count: 15 },
      { scope: 'run', name: '', message: 'status.find.is(200), found 503', count: 9 },
    ]);
  });

  it('PT-G-11 all seven endpoints present as request scopes', () => {
    expect(result.stats.filter((s) => s.scope === 'request').length).toBe(7);
  });
});

/** Percentiles are compared to GROUND TRUTH, not to Gatling's histogram estimate. */
describe('PT-G-12 percentiles vs ground truth', () => {
  const durations = events
    .filter((e): e is Extract<typeof e, { type: 'request' }> => e.type === 'request')
    .map((e) => e.endMs - e.startMs)
    .sort((a, b) => a - b);
  const truth = (q: number) => durations[Math.min(durations.length - 1, Math.ceil(q * durations.length) - 1)]!;

  it('is within 1% relative of the true percentile', () => {
    for (const p of [50, 75, 95, 99]) {
      const got = run.percentiles[`p${p}`]!;
      const want = truth(p / 100);
      expect(Math.abs(got - want) / want).toBeLessThanOrEqual(0.01);
    }
  });

  it('does NOT reproduce Gatling\'s p99, which is a histogram artifact', () => {
    // Gatling prints 2369; no request took that long. True p99 is 2501.
    expect(durations.includes(2369)).toBe(false);
    expect(run.percentiles.p99!).toBeGreaterThan(2400);
  });

  /**
   * THE WHOLE SET, NOT THE FOUR PERCENTILES NAMED ABOVE.
   *
   * `minMs` and `maxMs` are exactly tracked and a percentile is an estimate, so a
   * percentile outside its own row's range is known to be wrong — and the run page
   * puts the two in adjacent columns, where a reader sees it.
   *
   * MEASURED BEFORE THE CLAMP: eight of this run's percentile values sat above
   * their own maximum, across the run scope, `Catalog/Recommendations/Related
   * Items`, `Catalog/Recommendations` in both families, and `Catalog` — worst
   * +12.46 ms. On the nine real Gatling runs in the developer database it was 24
   * of 436 values. So this is not a theoretical bound being asserted for tidiness.
   *
   * IT ASSERTS THE WHOLE SET so a scope or family added later joins the check by
   * being produced rather than by somebody remembering a new `expect` — the shape
   * the runner-retry case settled on for the same reason. The list carries the row
   * and the number, so a failure names which one rather than reporting `false`.
   */
  it('reports no percentile outside the range reported beside it, on any row', () => {
    const outside = result.stats.flatMap((s) =>
      Object.entries(s.percentiles)
        .filter(([, v]) => v > s.maxMs || v < s.minMs)
        .map(([k, v]) => `${s.scope}/${s.family} ${s.name || '(run)'} ${k}=${v} outside [${s.minMs}, ${s.maxMs}]`),
    );
    expect(outside).toEqual([]);
  });
});
