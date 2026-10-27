import { AGENT_PERCENTILE_ROWS, roundForReading } from '@perfportal/contracts';
import type { AgentPercentileRow, DurationSection } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';
import { TIME_COLUMN, emptySentence } from './agentRates';
import { binLabelColumn } from './distribution';
import { SERIES_NAME } from './percentileDistribution';
import type { Outcome } from './percentiles';

/**
 * The Report's duration charts — TCP connect and TLS handshake under
 * Connections, DNS resolution under DNS — each from one `DurationSection` of a
 * `/v1/runs/:id/agent*` response. Three charts per section, as GE draws them:
 * percentiles over time, the distribution, and the percentile curve.
 *
 * ═══ NEVER A ZERO WHERE NOTHING WAS MEASURED ═══
 *
 * A bucket whose population is `null` measured none of that outcome, so every
 * row is a null y there — a gap — and a dash in the table. A distribution bin's
 * count, by contrast, is a measured zero when nothing landed in it, and KO is
 * drawn even when every bin is zero, the `toDistribution` rule — but a bin the
 * payload does not carry at all is a gap, not a zero (see `toDurationDistribution`).
 *
 * Unlike `/series`, each population carries its OWN thirteen rows (min and max
 * included), so the min/max caveat `toPercentiles` carries does not apply here.
 *
 * `noun` ("TCP connects", "TLS handshakes", "DNS lookups") is what the empty
 * sentences are about. As in `agentRates.ts`, the unavailable cases are the
 * section's to explain; these are called only for a collected run.
 */

/** GE's own row labels (spec §6). */
export const AGENT_ROW_LABEL: Record<AgentPercentileRow, string> = {
  min: 'Min',
  p25: '25%',
  p50: '50%',
  p75: '75%',
  p80: '80%',
  p85: '85%',
  p90: '90%',
  p95: '95%',
  p99: '99%',
  p99_9: '99.9%',
  p99_99: '99.99%',
  max: 'Max',
  mean: 'Mean',
};

/** The rows GE hides until asked for (spec §7.5). */
const HIDDEN_BY_DEFAULT: readonly AgentPercentileRow[] = ['p25', 'p80', 'p85', 'p99_9', 'p99_99'];

/** Every row except the five GE hides by default, in GE order. */
export const DEFAULT_AGENT_ROWS: readonly AgentPercentileRow[] = AGENT_PERCENTILE_ROWS.filter(
  (row) => !HIDDEN_BY_DEFAULT.includes(row),
);

type Opts = { readonly windowSelected: boolean; readonly noun: string };

/** "failed TCP connects" — the noun narrowed to one outcome; `all` narrows nothing. */
const OUTCOME_ADJECTIVE: Record<Outcome, string> = { ok: 'successful ', ko: 'failed ', all: '' };

/**
 * "Mean of failed TCP connects: 4.2 ms", at the product's one two-decimal
 * rounding. `population` is always named, because a KO curve's mean sitting
 * beside a distribution's merged mean must not read as the overall figure.
 */
function meanNote(population: string, meanMs: number | null): string | undefined {
  return meanMs === null ? undefined : `Mean of ${population}: ${roundForReading(meanMs)} ms`;
}

/** "all TCP connects", "failed TCP connects" — whose mean a curve's note gives. */
function populationOf(outcome: Outcome, noun: string): string {
  return outcome === 'all' ? `all ${noun}` : `${OUTCOME_ADJECTIVE[outcome]}${noun}`;
}

/**
 * GE's "… Duration Percentiles": one series per selected row over time.
 *
 * `rows` SELECTS WHAT IS DRAWN AND NOTHING ELSE — the table carries all
 * thirteen whatever is selected, `toPercentiles`' reasoning: the drawing has a
 * legibility budget, the table and a screen reader do not. Series order always
 * follows `AGENT_PERCENTILE_ROWS`, never the selection's order.
 */
export function toDurationOverTime(
  section: DurationSection,
  opts: Opts & { readonly outcome: Outcome; readonly rows: readonly AgentPercentileRow[] },
): ChartData {
  const columns = [TIME_COLUMN, ...AGENT_PERCENTILE_ROWS.map((r) => AGENT_ROW_LABEL[r])];
  const buckets = section.overTime;
  if (buckets.length === 0) {
    return { series: [], axisLabels: [], columns, rows: [], empty: emptySentence(opts.noun, opts) };
  }

  const population = buckets.map((b) => b[opts.outcome]);
  const rows: ChartTableRow[] = buckets.map((b, i) => ({
    label: String(b.startOffsetMs / 1000),
    values: AGENT_PERCENTILE_ROWS.map((_, r) => population[i]?.[r] ?? '—'),
  }));

  const unmeasured = population.filter((p) => p === null).length;
  const narrowed = `${OUTCOME_ADJECTIVE[opts.outcome]}${opts.noun}`;
  if (unmeasured === buckets.length) {
    // Thirteen lines of nothing would be a labelled grid with no marks; say what is absent.
    return { series: [], axisLabels: [], columns, rows, empty: emptySentence(narrowed, opts) };
  }

  const selected = AGENT_PERCENTILE_ROWS.filter((row) => opts.rows.includes(row));
  const series: ChartSeries[] = selected.map((row) => {
    const r = AGENT_PERCENTILE_ROWS.indexOf(row);
    return {
      name: AGENT_ROW_LABEL[row],
      // A null y keeps its pair — omitting the point would draw a line across the gap.
      data: buckets.map((b, i) => [b.startOffsetMs, population[i]?.[r] ?? null] as const),
    };
  });

  return {
    series,
    axisLabels: [],
    columns,
    rows,
    empty:
      selected.length === 0
        ? 'No percentile rows are selected, so there is nothing to draw. Choose at least one row above.'
        : undefined,
    limitation:
      unmeasured > 0
        ? `${unmeasured} of ${buckets.length} buckets recorded no ${narrowed}, so those points are absent rather than zero.`
        : undefined,
  };
}

/**
 * GE's "… Duration Distribution": OK and KO counts per bin, on Gatling's
 * uniform grid. Bin `i` is labelled `offsetMs + i * stepMs`, the payload's own
 * position for it, never the bin index.
 *
 * WHAT A LABEL IS depends on the grid, as it does for the request charts
 * (`binLabelColumn`): the producer's wide branch labels bin MIDPOINTS, while
 * its narrow "exact values" branch (a range of 100 ms or less) lays one bin on
 * every millisecond, `stepMs: 1`. A wide step is the range over 100 plots, so
 * it exceeds 1 — `stepMs === 1` is the exact branch and nothing else.
 *
 * The mean is the producer's over OK and KO MERGED, and its note says so.
 */
export function toDurationDistribution(section: DurationSection, opts: Opts): ChartData {
  const d = section.distribution;
  const columns = [binLabelColumn('Duration', d.stepMs === 1), `OK ${opts.noun}`, `KO ${opts.noun}`];
  // Indexed off the longer array, so the axis, series and table are one length.
  // The PRODUCER keeps the two parallel (it builds both from one label set);
  // `DurationSectionSchema` does not refine for it. So a bin one array lacks is
  // a gap and a dash, never a zero bin nobody counted.
  const length = Math.max(d.ok.length, d.ko.length);
  const bins = Array.from({ length }, (_, i) => ({
    label: d.offsetMs + i * d.stepMs,
    ok: d.ok[i] ?? null,
    ko: d.ko[i] ?? null,
  }));
  const binned = bins.reduce((sum, b) => sum + (b.ok ?? 0) + (b.ko ?? 0), 0);
  if (binned === 0) {
    // Not a row of zero-height bars, which would read as "measured, and every one took no time".
    return { series: [], axisLabels: [], columns, rows: [], empty: emptySentence(opts.noun, opts) };
  }

  return {
    series: [
      { name: 'OK', data: bins.map((b) => b.ok) },
      // Always present: a bin count of zero genuinely means zero failed.
      { name: 'KO', data: bins.map((b) => b.ko) },
    ],
    axisLabels: bins.map((b) => b.label),
    columns,
    rows: bins.map((b) => ({ label: String(b.label), values: [b.ok ?? '—', b.ko ?? '—'] })),
    limitation: meanNote(`all ${opts.noun}, OK and KO together`, d.meanMs),
  };
}

/**
 * GE's "… Percentiles Distribution": the curve for one outcome as `[p, ms]`
 * pairs, p from 0 (Min) to 100 (Max), drawn as the payload carries it.
 *
 * An empty curve for a population the section otherwise holds is not "nothing
 * recorded": the run recorded connects, just none of that outcome, and the
 * sentence says which.
 */
export function toDurationPercentiles(section: DurationSection, outcome: Outcome, opts: Opts): ChartData {
  const curve = section.percentiles[outcome];
  const columns = ['Percentile (%)', 'Duration (ms)'];
  if (curve.length === 0) {
    const anything = section.totals.ok + section.totals.ko > 0;
    const things = anything ? `${OUTCOME_ADJECTIVE[outcome]}${opts.noun}` : opts.noun;
    return { series: [], axisLabels: [], columns, rows: [], empty: emptySentence(things, opts) };
  }

  return {
    series: [{ name: SERIES_NAME[outcome], data: curve.map(([p, ms]) => [p, ms] as const) }],
    // EMPTY ON PURPOSE: x is a percentile carried by each point, on a value axis.
    axisLabels: [],
    columns,
    rows: curve.map(([p, ms]) => ({ label: String(p), values: [ms] })),
    limitation: meanNote(populationOf(outcome, opts.noun), section.percentiles.meanMs[outcome]),
  };
}
