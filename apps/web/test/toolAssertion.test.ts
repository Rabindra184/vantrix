import type { ToolAssertion } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { formatActual, toolAssertionParts } from '../src/routes/toolAssertion';

/**
 * REVIEW M10 — COLUMNS FROM THE STRUCTURE, NOT FROM THE SENTENCE.
 *
 * The obvious route to target/metric/operator/threshold columns is a regex over
 * "Search: 95th percentile of response time is less than 100.0". That would be
 * a parser for another tool's prose, written against the handful of shapes
 * anybody has happened to see and quietly wrong on the corpus run's
 * twenty-nine.
 *
 * It is also unnecessary. The engine evaluates `{ path, target, condition }`
 * and `describe()` renders the sentence FROM it; the pipeline stores the whole
 * evaluated object, so the structure has been in the database all along —
 * verified against a real ingest, whose stored keys are `outcome`,
 * `assertion`, `expression`, `actualValue`. It was dropped on the way OUT,
 * once by the persistence type and once by the API mapper.
 *
 * Every fixture below is a real shape from that decoder.
 */
const at = (assertion: unknown, actualValue: number | null = 0): ToolAssertion =>
  ({ expression: 'unused here', actualValue, outcome: 'failed', assertion } as ToolAssertion);

describe('toolAssertionParts', () => {
  it('reads a request-scoped percentile, the shape that motivated this', () => {
    const parts = toolAssertionParts(
      at({
        path: { kind: 'details', parts: ['Search'] },
        target: { kind: 'responseTime', stat: 'percentile', rank: 95 },
        condition: { kind: 'lt', value: 100 },
      }),
    );
    expect(parts).toEqual({
      target: 'Search',
      metric: '95th',
      operator: '<',
      threshold: '100 ms',
      unit: 'ms',
    });
  });

  it('names the run for a global path and every request for forAll', () => {
    const global = { kind: 'responseTime', stat: 'max' };
    expect(
      toolAssertionParts(at({ path: { kind: 'global' }, target: global, condition: { kind: 'lte', value: 10000 } })).target,
    ).toBe('the run');
    // `forAll` is NOT `global`: the combined statistics can pass while one
    // endpoint fails, so the two must not read the same.
    expect(
      toolAssertionParts(at({ path: { kind: 'forAll' }, target: global, condition: { kind: 'lte', value: 10000 } })).target,
    ).toBe('every request');
  });

  it('carries a percentage unit for a success-rate assertion', () => {
    const parts = toolAssertionParts(
      at({
        path: { kind: 'global' },
        target: { kind: 'percent', status: 'ok' },
        condition: { kind: 'gt', value: 80 },
      }),
    );
    expect(parts.metric).toBe('successful requests');
    expect(parts.operator).toBe('>');
    expect(parts.threshold).toBe('80%');
  });

  /** `around()` and `deviatesAround()` both compile to `between` with the
   *  bounds already evaluated — the decoder's own docstring says a reader
   *  cannot recover which call produced it, so neither does this. */
  it('renders a between as a range rather than inventing a comparator', () => {
    const parts = toolAssertionParts(
      at({
        path: { kind: 'global' },
        target: { kind: 'responseTime', stat: 'mean' },
        condition: { kind: 'between', lo: -1, hi: 73, inclusive: true },
      }),
    );
    expect(parts.operator).toBe('between');
    expect(parts.threshold).toBe('-1 ms – 73 ms');
  });

  /* ═══ IT DEGRADES TO THE SENTENCE ═══ */

  it('returns nothing for a run ingested before the decoder', () => {
    expect(toolAssertionParts(at(undefined))).toEqual({
      target: null, metric: null, operator: null, threshold: null, unit: null,
    });
  });

  /** A Path or Target this build does not know about must leave the cells
   *  empty rather than guess — the caller then renders the tool's own wording,
   *  which is the only thing that can describe it. */
  it('returns nothing for an assertion shape it does not recognise', () => {
    const parts = toolAssertionParts(
      at({ path: { kind: 'someFuturePath' }, target: { kind: 'somethingNew' }, condition: { kind: 'weird' } }),
    );
    expect(parts.target).toBeNull();
    expect(parts.metric).toBeNull();
    expect(parts.operator).toBeNull();
  });
});

describe('formatActual', () => {
  it('carries the unit the metric implies', () => {
    const ms = at({ path: { kind: 'global' }, target: { kind: 'responseTime', stat: 'max' }, condition: { kind: 'lte', value: 1 } }, 2503);
    expect(formatActual(ms)).toBe('2503 ms');

    const pct = at({ path: { kind: 'global' }, target: { kind: 'percent', status: 'ok' }, condition: { kind: 'gt', value: 80 } }, 97.31843575418995);
    expect(formatActual(pct)).toBe('97.32%');
  });

  /** A dash, never a zero: `not_applicable` means nothing was measured, and a
   *  0 ms maximum is a measurement. */
  it('renders an unmeasured value as a dash', () => {
    expect(formatActual(at({ path: { kind: 'global' } }, null))).toBe('—');
  });

  it('falls back to a bare number when the shape is unknown', () => {
    expect(formatActual(at(undefined, 42))).toBe('42');
  });
});
