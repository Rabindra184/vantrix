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
 * STRICTLY BEFORE, WITH NO NEWER FALLBACK. The tiles say "vs previous", and
 * the newest run in a cohort has no previous — omitting the deltas is the
 * only reading of that phrase that stays true.
 *
 * "BEFORE" IS THE COMPOSITE KEY `(effective, id)`, NOT THE INSTANT ALONE,
 * because that is the total order the rest of the product already commits
 * to: `ORDER BY COALESCE(tool_started_at, started_at) DESC, r.id DESC` in
 * both `TRENDS_SQL` and `RunRepository.list`. Comparing instants alone left
 * every run in a tie with no baseline at all — and ties are not exotic here,
 * since a run's `tool_started_at` comes from the LOG rather than from ingest,
 * so re-ingesting one simulation (a CI replay, a re-capture, a fixture) gives
 * every run in the cohort the same instant. The run list still shows those in
 * a definite sequence; "previous" has to mean the row below this one in it,
 * or the tiles and the list disagree about an ordering only one of them made
 * up.
 */
export function baselineRun(trends: TrendsResponse | undefined, current: string): TrendRun | null {
  if (trends === undefined) return null;
  const here = trends.runs.find((run) => run.id === current);
  if (here === undefined) return null;
  let previous: TrendRun | null = null;
  for (const run of trends.runs) {
    if (run.id === current) continue;
    if (!isBefore(run, here)) continue;
    if (previous === null || isBefore(previous, run)) previous = run;
  }
  return previous;
}

/**
 * `(COALESCE(tool_started_at, started_at), id)` compared the way
 * `TRENDS_SQL`'s own `ORDER BY … DESC, r.id DESC` compares it, so "before"
 * here means exactly "further down the run list".
 */
function isBefore(a: TrendRun, b: TrendRun): boolean {
  const at = effectiveStart(a);
  const bt = effectiveStart(b);
  return at !== bt ? at < bt : a.id < b.id;
}

/** `COALESCE(tool_started_at, started_at)`, as a comparable number. */
function effectiveStart(run: TrendRun): number {
  return Date.parse(run.toolStartedAt ?? run.startedAt);
}
