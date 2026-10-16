import { describe, expect, it } from 'vitest';
import { engineOptionsFrom } from '../src/engine-options.js';

/**
 * `percentiles` reaches the engine from the RAW project.settings JSON, and the
 * engine's nearest-rank formula throws a RangeError for a rank outside
 * [0, 100] — inside `RollupBuilder.finish`, so one bad value failed every
 * ingest and every live tick of the project. The set is filtered here, once,
 * to what `ProjectSettingsSchema` accepts: finite and strictly inside (0, 100).
 */
describe('engineOptionsFrom', () => {
  it('keeps only percentiles a nearest rank can answer', () => {
    const out = engineOptionsFrom({ percentiles: [50, 150, -1, 0, 100, 99.9, Number.NaN, 'p95', null, Infinity] });
    expect(out.percentiles).toEqual([50, 99.9]);
  });

  it('omits the set entirely when nothing usable is left, so the engine default applies', () => {
    expect('percentiles' in engineOptionsFrom({ percentiles: [150, 'x'] })).toBe(false);
    expect('percentiles' in engineOptionsFrom({ percentiles: 'p95' })).toBe(false);
  });

  it('passes a valid set and the other engine keys through unchanged', () => {
    const settings = { warmupMs: 5000, percentiles: [50, 75, 95, 99], maxEndpoints: 200, unrelated: true };
    expect(engineOptionsFrom(settings)).toEqual({ warmupMs: 5000, percentiles: [50, 75, 95, 99], maxEndpoints: 200 });
  });
});
