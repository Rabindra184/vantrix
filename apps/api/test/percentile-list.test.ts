import { describe, expect, it } from 'vitest';
import { parsePercentileList } from '../src/common/validation.js';

/**
 * `?percentiles=90,99.9` — the ranks a read answers instead of the project's
 * configured set. Every refusal is ONE code, INVALID_QUERY, and names the
 * parameter, so a caller that sent a bad list is told which parameter to fix.
 */

function refusal(raw: unknown): { code?: string; message: string } {
  try {
    parsePercentileList('percentiles', raw);
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error(`parsePercentileList accepted ${JSON.stringify(raw)}`);
}

describe('parsePercentileList', () => {
  it('answers null when the parameter is absent, so the caller keeps its own set', () => {
    expect(parsePercentileList('percentiles', undefined)).toBeNull();
  });

  it('sorts ascending and drops duplicates', () => {
    expect(parsePercentileList('percentiles', '99.9,90,90')).toEqual([90, 99.9]);
  });

  it('accepts a fractional rank, answered under the key the caller spelled', () => {
    const ranks = parsePercentileList('percentiles', '99.99,0.000001')!;
    expect(ranks).toEqual([0.000001, 99.99]);
    expect(ranks.map((p) => `p${p}`)).toEqual(['p0.000001', 'p99.99']);
  });

  it('accepts the twelve-rank maximum', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(parsePercentileList('percentiles', twelve.join(','))).toEqual(twelve);
  });

  const thirteen = Array.from({ length: 13 }, (_, i) => i + 1).join(',');
  it.each([
    ['an empty value', ''],
    ['0, outside the open interval', '0'],
    ['100, outside the open interval', '100'],
    ['a word', 'abc'],
    ['a trailing comma', '50,'],
    ['thirteen ranks', thirteen],
    // Each of these is a number to `Number()` (10, 16 and 90), and none is a
    // rank a caller wrote on purpose: the decimal pattern is what refuses them.
    ['an exponent', '1e1'],
    ['hexadecimal', '0x10'],
    ['padding', ' 90'],
    // In the pattern and out of the open interval: the range check refuses it.
    ['above 100', '100.5'],
    // Seven places: `Number` gives 1e-7, which would be keyed `p1e-7` — not
    // the decimal the caller sent.
    ['more than six decimal places', '0.0000001'],
  ])('refuses %s with INVALID_QUERY naming the parameter', (_label, raw) => {
    const err = refusal(raw);
    expect(err.code).toBe('INVALID_QUERY');
    expect(err.message).toContain('percentiles');
  });

  it('refuses a repeated parameter the way every single-valued query does', () => {
    const err = refusal(['90', '95']);
    expect(err.code).toBe('INVALID_QUERY');
    expect(err.message).toContain('"percentiles" must be given once');
  });
});
