import { describe, expect, it } from 'vitest';
import { parseProjectSettings } from '../src/settings.js';

describe('parseProjectSettings', () => {
  it('falls back to Gatling defaults for an empty settings object', () => {
    expect(parseProjectSettings({})).toEqual({
      indicators: { lowerMs: 800, higherMs: 1200 },
      percentiles: [50, 75, 95, 99],
    });
  });

  it('accepts non-default bounds and columns (AC-PARITY-4)', () => {
    expect(parseProjectSettings({ indicators: { lowerMs: 200, higherMs: 900 }, percentiles: [90, 99, 99.9] }))
      .toEqual({ indicators: { lowerMs: 200, higherMs: 900 }, percentiles: [90, 99, 99.9] });
  });

  it('ignores unrelated keys rather than failing the request', () => {
    expect(parseProjectSettings({ maxDecompressedBundleBytes: 123 }).indicators.lowerMs).toBe(800);
  });

  it('rejects a lower bound above the higher bound', () => {
    expect(() => parseProjectSettings({ indicators: { lowerMs: 2000, higherMs: 1000 } }))
      .toThrow(/lowerMs/);
  });

  it('rejects percentiles outside (0, 100)', () => {
    expect(() => parseProjectSettings({ percentiles: [0] })).toThrow();
    expect(() => parseProjectSettings({ percentiles: [100] })).toThrow();
  });
});
