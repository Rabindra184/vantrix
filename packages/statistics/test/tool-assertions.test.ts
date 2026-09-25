import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, ToolAssertion } from '@perfportal/core';
import { readRunHeader, BinaryReader } from '@perfportal/plugin-gatling';
import { runEngine } from '../src/engine.js';
import { evaluateToolAssertions } from '../src/tool-assertions.js';

/**
 * ═══ WORDING PARITY IS ASSERTED AGAINST A GENERATED REPORT ═══
 *
 * G-05's tolerance is "exact", and it covers the EXPRESSION as well as the
 * numbers — an assertion we phrased ourselves would be wrong on the row a
 * reader is comparing even when the verdict is right.
 *
 * So the strings below are transcribed from the assertions table of the report
 * Gatling generated for `fixtures/gatling-3.15.1.2/assertion-corpus/`, and the
 * definitions are decoded from that same run's `simulation.log`. One side is
 * the tool's rendering, the other is ours, and this asserts they agree for
 * every Path x Target x Condition the DSL offers.
 *
 * The corpus run had exactly one request, `Session`, which is what makes two
 * of these interesting:
 *
 *   #1 `forAll()` renders as `Session`, not as anything mentioning "all
 *      requests" — it EXPANDS to one row per request.
 *   #3 `details("A", "B")` names nothing in that run, and the tool says so in
 *      a specific sentence rather than failing silently.
 */
const LOG = 'fixtures/gatling-3.15.1.2/assertion-corpus/simulation.log';

const REPORT_EXPRESSIONS: readonly string[] = [
  'Global: max of response time is less than 1.0',
  'Session: max of response time is less than 2.0',
  'Session: max of response time is less than 3.0',
  'Could not find stats matching assertion path List(A, B)',
  'Global: min of response time is less than 10.0',
  'Global: max of response time is less than 11.0',
  'Global: mean of response time is less than 12.0',
  'Global: standard deviation of response time is less than 13.0',
  'Global: 50th percentile of response time is less than 14.0',
  'Global: 75th percentile of response time is less than 15.0',
  'Global: 95th percentile of response time is less than 16.0',
  'Global: 99th percentile of response time is less than 17.0',
  'Global: 99.9th percentile of response time is less than 18.0',
  'Global: count of all events is less than 20.0',
  'Global: percentage of all events is less than 21.0',
  'Global: count of failed events is less than 22.0',
  'Global: percentage of failed events is less than 23.0',
  'Global: count of successful events is less than 24.0',
  'Global: percentage of successful events is less than 25.0',
  'Global: mean requests per second is less than 26.0',
  'Global: max of response time is less than 30.0',
  'Global: max of response time is less than or equal to 31.0',
  'Global: max of response time is greater than 32.0',
  'Global: max of response time is greater than or equal to 33.0',
  'Global: max of response time is between 34.0 and 35.0 inclusive',
  'Global: max of response time is between -1.0 and 73.0 inclusive',
  'Global: max of response time is between 19.0 and 57.0 inclusive',
  'Global: max of response time is 39.0',
  'Global: max of response time is in List(40.0, 41.0, 42.0)',
];

/** The corpus run's shape: one scenario, one request named `Session`. */
function corpusStats() {
  const BASE = 1_000;
  const events: CanonicalEvent[] = [
    { type: 'meta', simulation: 'example.AssertionCorpus', toolVersion: '3.15.1', startedAtMs: BASE },
    { type: 'request', name: 'Session', groups: [], userId: '1', startMs: BASE, endMs: BASE + 120, ok: true },
  ];
  return runEngine(events).stats;
}

describe('tool assertions — G-05', () => {
  const assertions: ToolAssertion[] = readRunHeader(new BinaryReader(readFileSync(LOG))).assertions;

  it('renders every expression exactly as the tool’s own report does', () => {
    const evaluated = evaluateToolAssertions(assertions, corpusStats());
    expect(evaluated.map((e) => e.expression)).toEqual(REPORT_EXPRESSIONS);
  });

  it('reports a path that matches nothing as not_applicable, with no value', () => {
    // Gatling calls this a failure. This platform separates "the endpoint you
    // named does not exist" from "the endpoint is too slow", because a reader
    // acts on them differently (§22.1 tenet 6).
    const evaluated = evaluateToolAssertions(assertions, corpusStats());
    const missing = evaluated.find((e) => e.expression.startsWith('Could not find'));
    expect(missing?.outcome).toBe('not_applicable');
    expect(missing?.actualValue).toBeNull();
  });

  it('expands forAll to one row per request, not one row for the run', () => {
    const two: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 1_000 },
      { type: 'request', name: 'A', groups: [], userId: '1', startMs: 1_000, endMs: 1_010, ok: true },
      { type: 'request', name: 'B', groups: [], userId: '1', startMs: 1_000, endMs: 1_020, ok: true },
    ];
    const forAll = assertions.filter((a) => a.path.kind === 'forAll');
    expect(forAll).toHaveLength(1);

    const evaluated = evaluateToolAssertions(forAll, runEngine(two).stats);
    expect(evaluated.map((e) => e.expression)).toEqual([
      'A: max of response time is less than 2.0',
      'B: max of response time is less than 2.0',
    ]);
  });
});

describe('tool assertions — the verdict is recomputed, not read', () => {
  /** A run whose numbers are known exactly, so every comparison is decidable. */
  const stats = () =>
    runEngine([
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 0 },
      { type: 'request', name: 'r', groups: [], userId: 'u', startMs: 0, endMs: 100, ok: true },
      { type: 'request', name: 'r', groups: [], userId: 'u', startMs: 0, endMs: 200, ok: true },
      { type: 'request', name: 'r', groups: [], userId: 'u', startMs: 0, endMs: 300, ok: false, message: 'x' },
    ] as CanonicalEvent[]).stats;

  const global = { kind: 'global' } as const;
  const max = { kind: 'responseTime', stat: 'max' } as const;
  const evalOne = (assertion: ToolAssertion) => evaluateToolAssertions([assertion], stats())[0]!;

  it('measures max against the run’s real maximum', () => {
    const r = evalOne({ path: global, target: max, condition: { kind: 'lt', value: 400 } });
    expect(r.actualValue).toBe(300);
    expect(r.outcome).toBe('passed');
  });

  it.each([
    ['lt', { kind: 'lt', value: 300 } as const, 'failed'],
    ['lte', { kind: 'lte', value: 300 } as const, 'passed'],
    ['gt', { kind: 'gt', value: 300 } as const, 'failed'],
    ['gte', { kind: 'gte', value: 300 } as const, 'passed'],
    ['is', { kind: 'is', value: 300 } as const, 'passed'],
  ])('applies %s at the boundary', (_name, condition, outcome) => {
    expect(evalOne({ path: global, target: max, condition }).outcome).toBe(outcome);
  });

  it('honours between’s inclusive flag at the edge', () => {
    const inclusive = evalOne({
      path: global, target: max, condition: { kind: 'between', lo: 100, hi: 300, inclusive: true },
    });
    const exclusive = evalOne({
      path: global, target: max, condition: { kind: 'between', lo: 100, hi: 300, inclusive: false },
    });
    expect(inclusive.outcome).toBe('passed');
    expect(exclusive.outcome).toBe('failed');
  });

  it('counts and percentages split by status', () => {
    const of = (target: ToolAssertion['target']) =>
      evalOne({ path: global, target, condition: { kind: 'gte', value: 0 } }).actualValue;

    expect(of({ kind: 'count', status: 'all' })).toBe(3);
    expect(of({ kind: 'count', status: 'ok' })).toBe(2);
    expect(of({ kind: 'count', status: 'ko' })).toBe(1);
    expect(of({ kind: 'percent', status: 'ko' })).toBeCloseTo(100 / 3, 6);
  });

  it('answers a percentile rank that is not one of the stored bands', () => {
    // THE POINT OF KEEPING THE SKETCH. 99.9 is not among the per-bucket bands
    // (25/50/75/80/85/90/95/99), and the four projected columns cannot answer
    // it either — the sketch can.
    const r = evalOne({
      path: global,
      target: { kind: 'responseTime', stat: 'percentile', rank: 99.9 },
      condition: { kind: 'lte', value: 300 },
    });
    expect(r.actualValue).toBeGreaterThan(0);
    expect(r.outcome).toBe('passed');
  });
});

describe('tool assertions — a percentile verdict is clamped like every other estimate', () => {
  /**
   * 95 fast requests and 5 slow ones AT THE SAME TOP VALUE, which is what makes
   * this fixture able to tell a clamped answer from a raw one.
   *
   * `Sketch.quantile` returns the exactly-tracked `max` for rank `n - 1` and
   * estimates every interior rank from the bucket store. With n = 100 the p99
   * rank is index 98 — interior — and it falls in the maximum's own bucket,
   * whose midpoint sits ABOVE the maximum. The block above cannot see this: its
   * run has three requests and asks for p99.9, which IS `n - 1`, so it takes
   * the early return and never reaches the estimating path at all.
   *
   * The numbers here are the reference run's, reproduced exactly (max 2503,
   * raw p99 2515.4601126102525) — the same 12.46 ms overshoot that made
   * `99th percentile of response time is less than 2510.0` report FAILED on a
   * run whose slowest request was 2503 ms.
   */
  const stats = () => {
    const events: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 0 },
    ];
    const push = (ms: number) =>
      events.push({ type: 'request', name: 'r', groups: [], userId: 'u', startMs: 0, endMs: ms, ok: true });
    for (let i = 0; i < 95; i += 1) push(100);
    for (let i = 0; i < 5; i += 1) push(2503);
    return runEngine(events).stats;
  };

  const runRow = () => {
    const row = stats().find((s) => s.scope === 'run' && s.family === 'response_time');
    if (row === undefined) throw new Error('no run-scope response_time row');
    return row;
  };

  const percentile = (rank: number, condition: ToolAssertion['condition']) =>
    evaluateToolAssertions(
      [{ path: { kind: 'global' }, target: { kind: 'responseTime', stat: 'percentile', rank }, condition }],
      stats(),
    )[0]!;

  it('agrees with the percentile the statistics table prints for the same run', () => {
    const row = runRow();

    // THE FIXTURE HAS TO BE ABLE TO DISTINGUISH THE TWO ANSWERS, and saying so
    // is not decoration: if the sketch ever stops overshooting on this shape,
    // every assertion below is satisfied by the unclamped product too and this
    // case goes on passing while guarding nothing.
    expect(row.sketch.quantile(0.99)).toBeGreaterThan(row.maxMs);

    // One run, one quantity, one answer. `row.percentiles` is what the
    // statistics table renders; this verdict re-derives from the sketch to
    // reach arbitrary ranks, and must land in the same place.
    const r = percentile(99, { kind: 'lt', value: 2510 });
    expect(r.actualValue).toBe(row.percentiles.p99);
    expect(r.actualValue).toBe(row.maxMs);

    // The run's slowest request was 2503 ms, so nothing it did breached 2510.
    expect(r.outcome).toBe('passed');
  });

  it('leaves a percentile that is already inside the range alone', () => {
    // PAIRED WITH THE CASE ABOVE, because "clamped" quietly becoming "pinned to
    // the maximum" would satisfy it perfectly and flatten every percentile
    // column in the product.
    const row = runRow();
    const r = percentile(50, { kind: 'gte', value: 0 });

    expect(r.actualValue).toBeLessThan(row.maxMs);
    expect(r.actualValue).toBeGreaterThanOrEqual(row.minMs);
  });
});
