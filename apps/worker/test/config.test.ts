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

  /**
   * Fix round 2, item 2. `concurrency` became a POOL-SIZING INPUT in fix
   * round 1 (`main.ts`'s `max: maxOwnedRuns + ... + concurrency *
   * PIPELINE_CLIENTS_PER_JOB + ...`), but was still read with a bare
   * `Number(...)`, unguarded. A non-numeric `WORKER_CONCURRENCY` would make
   * that `max` computation `NaN`, and pg-pool's own fallback chain
   * (`this.options.max = this.options.max || this.options.poolSize || 10`)
   * silently substitutes 10 for a falsy/`NaN` `max` -- reintroducing
   * Critical 1's exact shape (a pool of 10 against `maxOwnedRuns`'s default
   * of 25) through this field instead of the two `numberOr` already guarded.
   */
  describe('concurrency', () => {
    it('defaults to 2 when unset', () => {
      const config = loadWorkerConfig(BASE_ENV);
      expect(config.concurrency).toBe(2);
    });

    it('passes through a valid explicit value', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, WORKER_CONCURRENCY: '4' });
      expect(config.concurrency).toBe(4);
    });

    it('falls back to the default, not NaN, on a non-numeric value', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, WORKER_CONCURRENCY: 'lots' });
      expect(config.concurrency).toBe(2);
      expect(Number.isNaN(config.concurrency)).toBe(false);
    });
  });

  describe('recompute', () => {
    it('is on unless RECOMPUTE_ENABLED is exactly "false"', () => {
      expect(loadWorkerConfig(BASE_ENV).recomputeEnabled).toBe(true);
      expect(loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_ENABLED: 'false' }).recomputeEnabled).toBe(false);
      // An exact comparison: '0' and 'no' are not the word that turns it off.
      expect(loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_ENABLED: '0' }).recomputeEnabled).toBe(true);
      expect(loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_ENABLED: 'true' }).recomputeEnabled).toBe(true);
    });

    it('scans every ten minutes by default, and falls back to that on a non-numeric override', () => {
      expect(loadWorkerConfig(BASE_ENV).recomputeScanIntervalMs).toBe(600_000);
      expect(
        loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_SCAN_INTERVAL_MS: '60000' }).recomputeScanIntervalMs,
      ).toBe(60_000);
      expect(
        loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_SCAN_INTERVAL_MS: 'often' }).recomputeScanIntervalMs,
      ).toBe(600_000);
    });

    /**
     * Compose passes both as `${PERFPORTAL_...:-}`, so an operator who sets
     * neither hands the worker EMPTY STRINGS, not absent variables. Empty has
     * to mean the default: `Number('')` is 0, and a 0 ms interval rescans the
     * database continuously.
     */
    it('reads an empty string, as compose passes an unset variable, as the default', () => {
      const config = loadWorkerConfig({ ...BASE_ENV, RECOMPUTE_ENABLED: '', RECOMPUTE_SCAN_INTERVAL_MS: '' });
      expect(config.recomputeEnabled).toBe(true);
      expect(config.recomputeScanIntervalMs).toBe(600_000);
    });
  });

  describe('verify and raw-log retention', () => {
    it('defaults: retention 90 days, verification on, a scan every ten minutes', () => {
      const config = loadWorkerConfig(BASE_ENV);
      expect(config.rawLogRetentionDays).toBe(90);
      expect(config.verifyEnabled).toBe(true);
      expect(config.verifyScanIntervalMs).toBe(600_000);
    });

    it('reads an empty string, as compose passes an unset variable, as the default', () => {
      const config = loadWorkerConfig({
        ...BASE_ENV, RAW_LOG_RETENTION_DAYS: '', VERIFY_ENABLED: '', VERIFY_SCAN_INTERVAL_MS: '  ',
      });
      expect(config.rawLogRetentionDays).toBe(90);
      expect(config.verifyEnabled).toBe(true);
      expect(config.verifyScanIntervalMs).toBe(600_000);
    });

    it('keeps raw logs for ever at RAW_LOG_RETENTION_DAYS=0, and passes a positive count through', () => {
      expect(loadWorkerConfig({ ...BASE_ENV, RAW_LOG_RETENTION_DAYS: '0' }).rawLogRetentionDays).toBe(0);
      expect(loadWorkerConfig({ ...BASE_ENV, RAW_LOG_RETENTION_DAYS: '30' }).rawLogRetentionDays).toBe(30);
    });

    /**
     * A retention that silently fell back to a default would DELETE raw logs
     * on a schedule the operator did not choose: `-1` meant as "for ever",
     * or `7.5`, must stop the worker rather than be guessed at.
     */
    it.each(['-1', '7.5', 'forever', '1e3x'])('refuses RAW_LOG_RETENTION_DAYS=%s at startup, naming the variable', (v) => {
      expect(() => loadWorkerConfig({ ...BASE_ENV, RAW_LOG_RETENTION_DAYS: v })).toThrow(/RAW_LOG_RETENTION_DAYS/);
    });

    it('is on unless VERIFY_ENABLED is exactly "false"', () => {
      expect(loadWorkerConfig({ ...BASE_ENV, VERIFY_ENABLED: 'false' }).verifyEnabled).toBe(false);
      expect(loadWorkerConfig({ ...BASE_ENV, VERIFY_ENABLED: '0' }).verifyEnabled).toBe(true);
    });

    it('falls back to the default scan interval on a non-numeric override', () => {
      expect(loadWorkerConfig({ ...BASE_ENV, VERIFY_SCAN_INTERVAL_MS: '60000' }).verifyScanIntervalMs).toBe(60_000);
      expect(loadWorkerConfig({ ...BASE_ENV, VERIFY_SCAN_INTERVAL_MS: 'often' }).verifyScanIntervalMs).toBe(600_000);
    });
  });

  /**
   * `setInterval(fn, 0)` walks every candidate back to back, and a negative
   * delay is clamped to the same thing: neither is what an operator means.
   * Both scans read a non-positive interval as their default, through ONE
   * helper, so the two queues cannot drift apart on it.
   */
  describe('scan intervals', () => {
    it.each(['0', '-5'])('reads %s as the default for both scans', (v) => {
      const config = loadWorkerConfig({
        ...BASE_ENV, RECOMPUTE_SCAN_INTERVAL_MS: v, VERIFY_SCAN_INTERVAL_MS: v,
      });
      expect(config.recomputeScanIntervalMs).toBe(600_000);
      expect(config.verifyScanIntervalMs).toBe(600_000);
    });
  });
});
