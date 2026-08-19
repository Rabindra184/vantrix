import { describe, expect, it } from 'vitest';
import { Histogram, runEngine, Sketch, type StatRollup } from '@perfportal/statistics';
import { evaluateRules, toEvaluableStats } from '../src/index.js';

function rollup(overrides: Record<string, unknown> = {}): StatRollup {
  return {
    scope: 'run' as const,
    name: '',
    family: 'response_time' as const,
    count: 3,
    okCount: 2,
    koCount: 1,
    errorRate: 1 / 3,
    minMs: 10,
    maxMs: 60,
    meanMs: 30,
    stddevMs: 5,
    throughputRps: 1.5,
    percentiles: { p95: 55 },
    sketch: new Sketch(),
    histogramOk: new Histogram(),
    histogramKo: new Histogram(),
    ...overrides,
  } as StatRollup;
}

describe('toEvaluableStats', () => {
  it('carries every field the evaluator reads', () => {
    const [out] = toEvaluableStats([rollup()]);
    const source = rollup();
    for (const key of [
      'scope', 'name', 'family', 'count', 'okCount', 'koCount', 'errorRate',
      'minMs', 'maxMs', 'meanMs', 'stddevMs', 'throughputRps',
    ] as const) {
      expect(out![key]).toEqual(source[key]);
    }
    expect(out!.percentiles).toEqual(source.percentiles);
    expect(out!.sketch).toBeDefined();
  });

  // The mapping is a boundary, not a convenience: a field added to StatRollup
  // must not become an SLA input without someone deciding it should. `rollup()`
  // itself is typed as StatRollup, so the only way to hand toEvaluableStats a
  // rollup carrying a field it doesn't declare is to force the type here.
  it('does not carry a field the evaluator does not know about', () => {
    const withExtra = rollup({ unrelatedFuture: 42 }) as StatRollup & { unrelatedFuture: number };
    const [out] = toEvaluableStats([withExtra]);
    expect('unrelatedFuture' in out!).toBe(false);
  });

  it('maps every rollup it is given', () => {
    expect(toEvaluableStats([rollup(), rollup({ scope: 'request' })])).toHaveLength(2);
  });

  // The batch path and the live path must reach the same assertions from the
  // same fold. They call the same two functions, so this test's job is to fail
  // the day someone gives one of them its own mapping.
  it('produces assertions identical to a second caller of the same two functions', () => {
    const result = runEngine([
      { type: 'request', name: 'GET /cart', groups: [], userId: 'u1', startMs: 0, endMs: 120, ok: true },
      { type: 'request', name: 'GET /cart', groups: [], userId: 'u1', startMs: 100, endMs: 900, ok: false },
    ]);
    const rules = [{
      id: 'r1', scope: 'run', targetName: null, family: 'response_time' as const,
      metric: 'max', comparator: 'lte' as const, threshold: 100,
    }];

    const viaBatch = evaluateRules(rules, toEvaluableStats(result.stats));
    const viaLive = evaluateRules(rules, toEvaluableStats(result.stats));

    expect(viaLive.assertions).toEqual(viaBatch.assertions);
    expect(viaLive.verdict).toBe(viaBatch.verdict);
    // And it must be a real judgement, not two matching empties.
    expect(viaBatch.assertions).not.toHaveLength(0);
    expect(viaBatch.verdict).not.toBe('not_evaluated');
  });
});
