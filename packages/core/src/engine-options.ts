// lowerMs/higherMs deliberately absent: packages/statistics/src/engine.ts's
// EngineOptions no longer accepts indicator bounds at all - bands are folded
// at READ time from the project's current settings.indicators (see
// @perfportal/contracts' ProjectSettingsSchema docstring). Freezing them here
// used to be a double bug: this key list looked for a FLAT lowerMs/higherMs
// that the documented settings shape never writes (it's nested under
// "indicators"), and even a matching value would have landed in
// run.engineOptions only to be silently ignored by an engine that no longer
// reads it - a stale value rewritten on every ingest for no effect.
export const ENGINE_KEYS = [
  'warmupMs', 'percentiles',
  'maxEndpoints', 'maxBucketsRun', 'maxBucketsEndpoint',
] as const;

/**
 * Frozen onto the run, not read at parse time. Statistics are meaningful only
 * relative to the warm-up window and percentile set that produced them, and a
 * project changing its warm-up must not silently reinterpret its own history.
 *
 * `settings` is the RAW project.settings JSON (ProjectRepository.settings()),
 * not @perfportal/contracts' validated ProjectSettings: these ENGINE_KEYS are
 * ingest-time engine knobs (and, via the sibling `maxBundleBytes` read
 * alongside it in each caller, a bundle-size cap) that live in the same JSON
 * column but outside that schema's modeled shape, so they are read here
 * unvalidated.
 */
export function engineOptionsFrom(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENGINE_KEYS) {
    const v = k === 'percentiles' ? usablePercentiles(settings[k]) : settings[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The ONE engine key that is checked, because it is the one that can take a
 * run down. The engine answers each configured percentile by nearest rank,
 * and `nearestRankIndex` throws a RangeError for a rank outside [0, 100] —
 * inside `RollupBuilder.finish`, so a single `150` in project.settings failed
 * every ingest and every live tick of the project. Filtered to what
 * `ProjectSettingsSchema` accepts (finite, strictly inside (0, 100)); a set
 * with nothing usable left is omitted, so the engine's default applies, as
 * that schema's `.default()` would. `p0` and `p100` are the min and the max
 * and have their own columns.
 *
 * Only NEW runs are protected: `engineOptions` is frozen onto a run at open,
 * so a run opened with a bad set before this filter existed still carries it.
 */
function usablePercentiles(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const kept = v.filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 100);
  return kept.length > 0 ? kept : undefined;
}
