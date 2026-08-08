import { Sketch } from '@perfportal/statistics';
import { describe, expect, it } from 'vitest';
import { evaluateRules, resolveMetric, type EvaluableRule, type EvaluableStat } from '../src/index.js';

function sketchOf(values: number[]): Sketch {
  const s = new Sketch();
  for (const v of values) s.accept(v);
  return s;
}

function stat(over: Partial<EvaluableStat> = {}): EvaluableStat {
  return {
    scope: 'run',
    name: '',
    family: 'response_time',
    count: 1000,
    okCount: 990,
    koCount: 10,
    errorRate: 0.01,
    minMs: 1,
    maxMs: 2000,
    meanMs: 220,
    stddevMs: 300,
    throughputRps: 50,
    percentiles: { p50: 100, p95: 700, p99: 1800 },
    sketch: sketchOf(Array.from({ length: 1000 }, (_, i) => i + 1)),
    ...over,
  };
}

function rule(over: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'p95',
    comparator: 'lte',
    threshold: 800,
    ...over,
  };
}

describe('resolveMetric', () => {
  it('reads a stored percentile from the JSONB', () => {
    expect(resolveMetric(stat(), 'p95')).toBe(700);
  });

  it('answers a percentile that was never stored, from the sketch', () => {
    const v = resolveMetric(stat(), 'p99.9');
    expect(v).not.toBeNull();
    expect(Math.abs(v! - 999) / 999).toBeLessThanOrEqual(0.01);
  });

  it('resolves the scalar metrics', () => {
    expect(resolveMetric(stat(), 'mean')).toBe(220);
    expect(resolveMetric(stat(), 'max')).toBe(2000);
    expect(resolveMetric(stat(), 'error_rate')).toBe(0.01);
    expect(resolveMetric(stat(), 'throughput_rps')).toBe(50);
    expect(resolveMetric(stat(), 'count')).toBe(1000);
  });

  it('returns null for an unknown metric rather than guessing', () => {
    expect(resolveMetric(stat(), 'p95th')).toBeNull();
  });

  it('returns null for a percentile when there is no sketch to fall back to', () => {
    expect(resolveMetric(stat({ sketch: undefined }), 'p99.9')).toBeNull();
  });
});

describe('evaluateRules', () => {
  it('passes when the value is within an lte threshold', () => {
    const r = evaluateRules([rule({ threshold: 800 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('passed');
    expect(r.assertions[0]?.actualValue).toBe(700);
    expect(r.verdict).toBe('passed');
  });

  it('fails when the value exceeds an lte threshold', () => {
    const r = evaluateRules([rule({ threshold: 500 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('failed');
    expect(r.verdict).toBe('failed');
  });

  it('treats the boundary as passing — lte means less than or equal', () => {
    const r = evaluateRules([rule({ threshold: 700 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('passed');
  });

  it('handles gte in the same way', () => {
    const pass = evaluateRules([rule({ metric: 'throughput_rps', comparator: 'gte', threshold: 40 })], [stat()]);
    expect(pass.assertions[0]?.outcome).toBe('passed');
    const fail = evaluateRules([rule({ metric: 'throughput_rps', comparator: 'gte', threshold: 60 })], [stat()]);
    expect(fail.assertions[0]?.outcome).toBe('failed');
  });

  it('records not_applicable when the target is absent — never a silent pass', () => {
    const r = evaluateRules(
      [rule({ scope: 'request', targetName: 'GET /missing' })],
      [stat()],
    );
    expect(r.assertions[0]?.outcome).toBe('not_applicable');
    expect(r.assertions[0]?.actualValue).toBeNull();
    expect(r.assertions[0]?.message).toContain('GET /missing');
  });

  it('reports not_evaluated when every rule is not_applicable', () => {
    const r = evaluateRules([rule({ scope: 'request', targetName: 'GET /missing' })], [stat()]);
    expect(r.verdict).toBe('not_evaluated');
  });

  it('reports not_evaluated when there are no rules — a project without rules is not failing', () => {
    expect(evaluateRules([], [stat()]).verdict).toBe('not_evaluated');
  });

  it('fails the run if any rule fails, even when others pass', () => {
    const r = evaluateRules(
      [
        rule({ id: 'a', threshold: 800 }),
        rule({ id: 'b', threshold: 100 }),
        rule({ id: 'c', scope: 'request', targetName: 'GET /gone' }),
      ],
      [stat()],
    );
    expect(r.verdict).toBe('failed');
    expect(r.assertions.map((a) => a.outcome)).toEqual(['passed', 'failed', 'not_applicable']);
  });

  it('snapshots the rule as it read at evaluation time', () => {
    const original = rule({ threshold: 800 });
    const r = evaluateRules([original], [stat()]);
    original.threshold = 1;
    expect(r.assertions[0]?.ruleSnapshot.threshold).toBe(800);
  });

  it('matches a rule to the right family, not merely the right name', () => {
    const stats = [
      stat({ scope: 'group', name: 'Cart', family: 'group_duration', percentiles: { p95: 100 } }),
      stat({ scope: 'group', name: 'Cart', family: 'group_cumulated', percentiles: { p95: 900 } }),
    ];
    const r = evaluateRules(
      [rule({ scope: 'group', targetName: 'Cart', family: 'group_cumulated', threshold: 500 })],
      stats,
    );
    expect(r.assertions[0]?.actualValue).toBe(900);
    expect(r.assertions[0]?.outcome).toBe('failed');
  });
});
