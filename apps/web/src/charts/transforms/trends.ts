import type { TrendRun, TrendsResponse } from '@perfportal/contracts';
import { compareLabels } from './compare';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';
import { clampPercentile } from '../../percentile';

/**
 * `TrendsResponse` → the three trend figures.
 *
 * ═══ THE X AXIS IS RUNS, NOT TIME ═══
 *
 * A decision rather than a convenience. Runs are not evenly spaced: three in
 * an hour during a debugging session, then nothing for a week. Drawn on a time
 * axis, that week becomes a long flat stretch inviting the reader to see a
 * rate of change between two runs that nothing measured — and the gap, which
 * carries no information at all, gets more pixels than the runs do. The
 * question this page answers is "run over run", so the axis is runs.
 *
 * ═══ THE RESPONSE IS NEWEST FIRST; THESE READ OLDEST FIRST ═══
 *
 * The endpoint matches `/v1/runs`' ordering so the two cannot disagree about
 * what "most recent" means. A trend reads left-to-right in time, so it is
 * reversed here — once, in `ordered`, so three charts cannot end up reversing
 * it twice or not at all.
 */

/** Oldest first. See the file docstring. */
function ordered(t: TrendsResponse): readonly TrendRun[] {
  return [...t.runs].reverse();
}

/**
 * The x-axis labels for a cohort: `MM-DD HH:mm` in the reader's own zone, with
 * a short id suffix on any that would otherwise be identical.
 *
 * ═══ THIS WAS A BARE `runMinuteLabel` PER RUN, AND COMPARE ALREADY KNEW WHY
 *     THAT IS NOT ENOUGH ═══
 *
 * `compareLabels` exists to disambiguate colliding run labels, and its own
 * docstring names THIS axis as the other consumer of the shared
 * `runMinuteLabel`. So the function that solves the problem knew about this
 * caller, and this caller did not use it: the same shape as every other
 * one-of-N-call-sites defect in this repo.
 *
 * MEASURED, with twenty runs of one test on the Trends tab: ten drawn labels
 * (ECharts hides alternates rather than overlapping them, so the collision
 * this was first looked for does NOT happen) and every one of them reading
 * `08-07 11:00`. A reader could not tell any run from any other.
 *
 * THE FIXTURE MAKES IT TOTAL AND PRODUCTION MAKES IT PARTIAL, which is worth
 * stating rather than rounding up. `toolStartedAt` is when the LOAD TEST ran,
 * read from the simulation.log header — so re-ingesting one bundle gives every
 * run the same instant, and that is what the seeded cohort does. A real cohort
 * collides more narrowly: runs sharing a minute, which is a nightly on a fixed
 * schedule, a retried pipeline, or parallel shards. The fix is the same, and
 * it costs the non-colliding case nothing — `compareLabels` suffixes ONLY the
 * labels that collide.
 */
function axisLabels(runs: readonly TrendRun[]): string[] {
  return compareLabels(runs.map((run) => ({ id: run.id, at: run.toolStartedAt ?? run.startedAt })));
}

/** The full timestamp, for the table. */
const fullTimestamp = (run: TrendRun): string => run.toolStartedAt ?? run.startedAt;

/**
 * Set when the window is shorter than the cohort.
 *
 * A reader shown twenty of sixty runs, with nothing saying so, reads a
 * complete history — and "the last twenty look fine" is a different claim from
 * "it looks fine".
 */
function truncation(t: TrendsResponse): string | undefined {
  if (t.cohortSize <= t.runs.length) return undefined;
  return `Showing the most recent ${t.runs.length} of ${t.cohortSize} runs in this cohort.`;
}

/**
 * The shell every trend shares: an empty cohort explains itself rather than
 * drawing empty axes (design §11), and the truncation note rides along in
 * both branches — a truncated cohort that happens to be empty in this window
 * is exactly when the reader most needs to know the window exists.
 */
function empty(columns: readonly string[], t: TrendsResponse): ChartData {
  return {
    series: [],
    axisLabels: [],
    columns,
    rows: [],
    empty: 'No completed runs of this simulation yet, so there is no trend to show.',
    limitation: truncation(t),
  };
}

/**
 * A share of a run's own requests, as a percentage — or `null` where the run
 * recorded none.
 *
 * `0/0` IS NOT `0`. A run that recorded no requests did not succeed none of
 * them; it measured nothing, and a zero drawn on a percentage axis reads as a
 * total failure. The same distinction the rest of this codebase draws between
 * a gap and a floor.
 */
function share(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/* ── ① response status ─────────────────────────────────────────────────── */

const STATUS_COLUMNS = ['Run', 'Started (UTC)', 'OK (%)', 'KO (%)', 'Requests'] as const;

/**
 * Stacked OK/KO PERCENTAGE per run.
 *
 * Percentages rather than counts, and that is the whole design of this figure:
 * a run of 100 requests and a run of 100,000 with the same failure ratio must
 * draw at the same height. On raw counts the tall bar is the busy run, so
 * changes in LOAD read as changes in QUALITY — which is precisely the
 * confusion a status trend exists to remove.
 */
export function toStatusTrend(t: TrendsResponse): ChartData {
  if (t.runs.length === 0) return empty(STATUS_COLUMNS, t);

  const runs = ordered(t);
  const labels = axisLabels(runs);

  const rows: ChartTableRow[] = runs.map((run, i) => ({
    label: labels[i]!,
    values: [
      fullTimestamp(run),
      share(run.okCount, run.count) ?? '—',
      share(run.koCount, run.count) ?? '—',
      run.count,
    ],
  }));

  return {
    series: [
      { name: 'OK', data: runs.map((r) => share(r.okCount, r.count)) },
      { name: 'KO', data: runs.map((r) => share(r.koCount, r.count)) },
    ],
    axisLabels: labels,
    columns: STATUS_COLUMNS,
    rows,
    limitation: truncation(t),
  };
}

/* ── ② response time percentiles ───────────────────────────────────────── */

/**
 * `p99.9` → `99.9`, and anything unparseable → `null`.
 *
 * A LOCAL PARSER RATHER THAN THE STATISTICS TABLE'S. `tables/StatisticsTable`
 * has one, but importing it here would pull a React component module into
 * `charts/transforms/*` — which exists precisely so these run in the node
 * environment with no DOM and no renderer. The rule is one line; the layering
 * is worth more than sharing it.
 */
function percentileOf(key: string): number | null {
  if (!key.startsWith('p')) return null;
  const value = Number.parseFloat(key.slice(1));
  return Number.isFinite(value) ? value : null;
}

/**
 * Every percentile key any run in the cohort carries, in NUMERIC order.
 *
 * Read off the payload rather than assumed, for the reason the statistics
 * table's columns are: the set is a project setting, so a project configuring
 * `p99.9` gets a series for it without this file being edited.
 *
 * Numerically, not lexicographically — `'p99.9' < 'p50'` as strings, which
 * would draw the ramp out of order and make the legend nonsense.
 */
function percentileKeys(runs: readonly TrendRun[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) for (const key of Object.keys(run.percentiles)) seen.add(key);

  return [...seen].sort((a, b) => {
    const av = percentileOf(a);
    const bv = percentileOf(b);
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    return av - bv;
  });
}

/** `p95` → `95%`, matching how every other percentile surface in the app reads. */
function percentileLabel(key: string): string {
  const value = percentileOf(key);
  return value === null ? key : `${value}%`;
}

export function toPercentileTrend(t: TrendsResponse): ChartData {
  const keys = percentileKeys(t.runs);
  const columns = ['Run', 'Started (UTC)', ...keys.map(percentileLabel)];

  if (t.runs.length === 0) return empty(columns, t);

  const runs = ordered(t);
  const labels = axisLabels(runs);

  // A run without this key has NO VALUE on this series, which is not zero —
  // zero milliseconds is a measurement, and drawing one puts the fastest
  // point in the chart where a missing one belongs.
  //
  // CLAMPED AGAINST ITS OWN RUN'S EXTREMES, which is what the run page has
  // always done to the same number. Each point is a different run, so each
  // clamps against its own `minMs`/`maxMs` — the pair `TrendRun` carries for
  // exactly this, and which `PercentileRange` was narrowed to accept.
  // Unclamped, this line plotted a p99 ABOVE the max the run's own page had
  // already projected it onto: 2515.46 here against 2503 there, for one run,
  // one quantity, two surfaces.
  const at = (run: TrendRun, key: string): number | null => {
    const raw = run.percentiles[key];
    return raw === undefined ? null : clampPercentile(raw, run);
  };

  const series: ChartSeries[] = keys.map((key) => ({
    name: percentileLabel(key),
    data: runs.map((run) => at(run, key)),
  }));

  const rows: ChartTableRow[] = runs.map((run, i) => ({
    label: labels[i]!,
    values: [fullTimestamp(run), ...keys.map((key) => at(run, key) ?? '—')],
  }));

  return { series, axisLabels: labels, columns, rows, limitation: truncation(t) };
}

/* ── ③ throughput ──────────────────────────────────────────────────────── */

const THROUGHPUT_COLUMNS = ['Run', 'Started (UTC)', 'OK (/s)', 'KO (/s)', 'Total (/s)'] as const;

/**
 * The run's rate, split by its own outcome counts.
 *
 * SPLIT BY `okCount`/`count`, NOT BY `errorRate`. The two agree today —
 * `errorRate` is that ratio — but the counts are the quantity being described,
 * and deriving the split from them means this figure cannot disagree with the
 * status figure above it about what fraction of a run failed.
 */
function rateShare(part: number, run: TrendRun): number | null {
  return run.count > 0 ? run.throughputRps * (part / run.count) : null;
}

export function toThroughputTrend(t: TrendsResponse): ChartData {
  if (t.runs.length === 0) return empty(THROUGHPUT_COLUMNS, t);

  const runs = ordered(t);
  const labels = axisLabels(runs);

  const rows: ChartTableRow[] = runs.map((run, i) => ({
    label: labels[i]!,
    values: [
      fullTimestamp(run),
      rateShare(run.okCount, run) ?? '—',
      rateShare(run.koCount, run) ?? '—',
      run.throughputRps,
    ],
  }));

  return {
    series: [
      { name: 'OK', data: runs.map((r) => rateShare(r.okCount, r)) },
      { name: 'KO', data: runs.map((r) => rateShare(r.koCount, r)) },
    ],
    axisLabels: labels,
    columns: THROUGHPUT_COLUMNS,
    rows,
    limitation: truncation(t),
  };
}
