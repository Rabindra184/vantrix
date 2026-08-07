import { describe, expect, it } from 'vitest';
import { parseCursor, parseLimit } from '../src/common/validation.js';

describe('parseLimit', () => {
  it('defaults to 25 when limit is missing', () => {
    expect(parseLimit(undefined)).toBe(25);
  });

  it('clamps a negative limit up to the minimum of 1', () => {
    // Math.min(-5, 100) === -5, and slice(0, -5) silently returns [] —
    // this is the exact reviewer-reported failure mode.
    expect(parseLimit('-5')).toBe(1);
  });

  it('clamps a zero limit up to the minimum of 1', () => {
    expect(parseLimit('0')).toBe(1);
  });

  it('clamps an excessive limit down to the maximum of 100', () => {
    expect(parseLimit('99999')).toBe(100);
  });

  it('passes an in-range limit through unchanged', () => {
    expect(parseLimit('10')).toBe(10);
  });

  it('defaults non-numeric input to 25 rather than propagating NaN', () => {
    expect(parseLimit('not-a-number')).toBe(25);
  });

  it('truncates a fractional limit', () => {
    expect(parseLimit('3.9')).toBe(3);
  });
});

describe('parseCursor', () => {
  it('passes a missing cursor through as undefined', () => {
    expect(parseCursor(undefined)).toBeUndefined();
  });

  it('accepts a well-formed UUID cursor', () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(parseCursor(id)).toBe(id);
  });

  it('rejects a malformed cursor with a structured, actionable error instead of letting it reach Prisma', () => {
    expect(() => parseCursor('not-a-uuid')).toThrow();
    try {
      parseCursor('not-a-uuid');
      expect.unreachable();
    } catch (err) {
      expect((err as { remediation?: string }).remediation).toMatch(/uuid/i);
    }
  });
});
