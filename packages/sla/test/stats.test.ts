import { describe, expect, it } from 'vitest';
import { Histogram, Sketch, type StatRollup } from '@perfportal/statistics';
import { toEvaluableStats } from '../src/index.js';

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
});

/**
 * ═══ WHERE THE BATCH/LIVE AGREEMENT TEST LIVES, AND WHY NOT HERE ═══
 *
 * This file used to end with a case titled "produces assertions identical to a
 * second caller of the same two functions", whose two sides were the IDENTICAL
 * expression:
 *
 *     const viaBatch = evaluateRules(rules, toEvaluableStats(result.stats));
 *     const viaLive  = evaluateRules(rules, toEvaluableStats(result.stats));
 *
 * That is `f(x) === f(x)` for a pure function. It could not fail for any
 * implementation of either caller, and it imported neither — its comment
 * claimed it "will fail the day someone gives one of them its own mapping",
 * and it did not. It stayed green through five reviews while `LiveFoldOwner`
 * built its engine with NO options and `PipelineService` built its own from
 * `run.engineOptions`, which made the two paths report `count 6, max 4000` and
 * `count 3, max 50` for the same bytes (whole-branch review, A1/A2).
 *
 * A test of that claim has to reach both CALL SITES. `packages/sla` is the
 * leaf both of them import and depends on neither app, so it cannot: the
 * agreement test lives at `apps/worker/test/sla-agreement.integration.test.ts`,
 * where `LiveFoldOwner` and `PipelineService` are both in scope, and it
 * compares the delta the browser would receive against the `run_assertion`
 * rows the pipeline committed for one seeded run.
 *
 * The three cases above are what this package can honestly pin on its own: the
 * shape of the mapping both call sites go through.
 */
