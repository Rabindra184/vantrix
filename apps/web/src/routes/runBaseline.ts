import type { TrendRun, TrendsResponse } from '@perfportal/contracts';

/**
 * The cohort run immediately BEFORE this one, by time.
 *
 * NOT `runs[here + 1]`, WHICH IS WHAT THIS SHIPPED AS.
 * `TrendsResponseSchema`'s own docstring forbids exactly that: the window is
 * the newest `limit` runs and the asked-about run is ADDED BACK when it
 * falls outside, "so `runs` holds at most `limit + 1` entries and the last
 * of them may not be adjacent in time to the rest. Consumers must key off
 * `id` and the timestamps rather than assuming consecutive entries are
 * consecutive runs." Reading by position, a run older than the newest twenty
 * landed last, `runs[here + 1]` was undefined, and the fallback compared it
 * to the OLDEST run of the newest-twenty window — fifteen runs away — under
 * the words "vs previous".
 *
 * The ordering value is the one the whole product sorts runs by,
 * `COALESCE(tool_started_at, started_at)`, spelled the same way here as in
 * `RunRepository.list` and `TRENDS_SQL`.
 *
 * STRICTLY OLDER, WITH NO NEWER FALLBACK. The tiles say "vs previous", and
 * the newest run in a cohort has no previous — omitting the deltas is the
 * only reading of that phrase that stays true. A tie is skipped for the same
 * reason: two runs at the same instant have no "before" between them.
 */
export function baselineRun(trends: TrendsResponse | undefined, current: string): TrendRun | null {
  if (trends === undefined) return null;
  const here = trends.runs.find((run) => run.id === current);
  if (here === undefined) return null;
  const startedAt = effectiveStart(here);

  let previous: TrendRun | null = null;
  for (const run of trends.runs) {
    if (run.id === current) continue;
    const at = effectiveStart(run);
    if (!(at < startedAt)) continue;
    if (previous === null || at > effectiveStart(previous)) previous = run;
  }
  return previous;
}

/** `COALESCE(tool_started_at, started_at)`, as a comparable number. */
function effectiveStart(run: TrendRun): number {
  return Date.parse(run.toolStartedAt ?? run.startedAt);
}
