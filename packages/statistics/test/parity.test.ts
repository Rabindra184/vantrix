import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { runEngine } from '../src/engine.js';

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

  it('PT-G-06..09 indicator bands', () => {
    expect(result.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
  });

  it('PT-G-12 max, mean, stddev match Gatling exactly', () => {
    expect(run.maxMs).toBe(2503);
    expect(Math.round(run.meanMs)).toBe(228);
    expect(Math.round(run.stddevMs)).toBe(370);
  });

  it('PT-G-29 error table', () => {
    expect(result.errors).toEqual([
      { message: 'status.find.is(200), found 500', count: 15 },
      { message: 'status.find.is(200), found 503', count: 9 },
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
});
