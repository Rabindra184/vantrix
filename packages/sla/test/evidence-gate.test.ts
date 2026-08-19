import { describe, expect, it } from 'vitest';
import { evaluateRules, liveEvidenceFloor, type EvaluableRule, type EvaluableStat } from '../src/index.js';

const RULE: EvaluableRule = {
  id: 'r1', scope: 'run', targetName: null, family: 'response_time',
  metric: 'p99', comparator: 'lte', threshold: 100,
};

function stat(count: number): EvaluableStat {
  return {
    scope: 'run', name: '', family: 'response_time',
    count, okCount: count, koCount: 0, errorRate: 0,
    minMs: 1, maxMs: 900, meanMs: 400, stddevMs: 10, throughputRps: 1,
    percentiles: { p99: 900 },
  };
}

describe('the evidence gate', () => {
  // The whole point: 900ms against a 100ms threshold is a blatant breach, and
  // on 40 samples a p99 is one observation deep in the tail. Reporting it
  // would teach readers to ignore the banner.
  it('does not report a breach on too little data', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.outcome).toBe('not_applicable');
    expect(assertions[0]!.message).toMatch(/observations/i);
  });

  it('reports the value it could not trust, rather than discarding it', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.actualValue).toBe(900);
  });

  it('breaches once the same rule and data clear the floor', () => {
    const floor = liveEvidenceFloor(RULE);
    const { assertions, verdict } = evaluateRules([RULE], [stat(floor)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.outcome).toBe('failed');
    expect(verdict).toBe('failed');
  });

  // Deeper in the tail needs more evidence: p99 reads 1 observation in 100.
  it('demands more observations the deeper in the tail the metric reads', () => {
    const p50 = liveEvidenceFloor({ ...RULE, metric: 'p50' });
    const p95 = liveEvidenceFloor({ ...RULE, metric: 'p95' });
    const p99 = liveEvidenceFloor({ ...RULE, metric: 'p99' });
    expect(p50).toBeLessThan(p95);
    expect(p95).toBeLessThan(p99);
  });

  it('uses a flat floor for a scalar metric', () => {
    expect(liveEvidenceFloor({ ...RULE, metric: 'error_rate' })).toBe(100);
  });

  // The batch path passes no options and must be untouched.
  it('is absent unless asked for', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)]);
    expect(assertions[0]!.outcome).toBe('failed');
  });
});
