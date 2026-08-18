import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

const BASE_ENV = { DATABASE_URL: 'postgresql://example.invalid/db' };

/**
 * Fix round 1, Minor 2 (apps/worker/src/live/fold-owner.ts's Task 4 design
 * review). `Number(x)` on a non-numeric string is `NaN`, and `NaN` defeats
 * both `liveTickMs`'s floor and `maxOwnedRuns`'s cap silently:
 * `Math.max(1000, NaN)` is `NaN` (a `setInterval(fn, NaN)` timer effectively
 * fires immediately, the opposite of the floor), and `count >= NaN` is
 * always `false` (so `LiveFoldOwner`'s cap check never trips -- unbounded
 * claiming, compounding Critical 1's pool-sizing fix). `numberOr` guards
 * both fields; these cases are the regression guard for that guard.
 */
describe('loadWorkerConfig', () => {
  describe('liveTickMs', () => {
    it('defaults to 5000 when unset', () => {
      const config = loadWorkerConfig(BASE_ENV);
      expect(config.liveTickMs).toBe(5000);
    });

    it('floors an explicit low value at 1000', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, LIVE_TICK_MS: '500' });
      expect(config.liveTickMs).toBe(1000);
    });

    it('passes through a valid value above the floor', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, LIVE_TICK_MS: '8000' });
      expect(config.liveTickMs).toBe(8000);
    });

    it('falls back to the default, not NaN, on a non-numeric value', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, LIVE_TICK_MS: '5s' });
      expect(config.liveTickMs).toBe(5000);
      expect(Number.isNaN(config.liveTickMs)).toBe(false);
    });

    it('floors an empty string at 1000, same as any other value below the floor', () => {
      // Number('') is 0, not NaN -- a genuinely finite (if surprising) JS
      // parse, so numberOr passes it through unchanged; it is Math.max's
      // floor, not the NaN guard, that governs this particular input.
      const config = loadWorkerConfig({ ...BASE_ENV, LIVE_TICK_MS: '' });
      expect(config.liveTickMs).toBe(1000);
    });
  });

  describe('maxOwnedRuns', () => {
    it('defaults to 25 when unset', () => {
      const config = loadWorkerConfig(BASE_ENV);
      expect(config.maxOwnedRuns).toBe(25);
    });

    it('passes through a valid explicit value', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, MAX_OWNED_RUNS: '5' });
      expect(config.maxOwnedRuns).toBe(5);
    });

    it('falls back to the default, not NaN, on a non-numeric value', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, MAX_OWNED_RUNS: 'lots' });
      expect(config.maxOwnedRuns).toBe(25);
      expect(Number.isNaN(config.maxOwnedRuns)).toBe(false);
    });

    it('falls back to the default rather than to Infinity, which would defeat the cap the same way NaN does', () => {
      // Number('Infinity') is a valid, finite-looking parse target but not
      // actually finite -- Number.isFinite is what numberOr guards on, not
      // Number.isNaN alone, specifically so this input is also caught.
      const config = loadWorkerConfig({ ...BASE_ENV, MAX_OWNED_RUNS: 'Infinity' });
      expect(config.maxOwnedRuns).toBe(25);
      expect(Number.isFinite(config.maxOwnedRuns)).toBe(true);
    });
  });
});
