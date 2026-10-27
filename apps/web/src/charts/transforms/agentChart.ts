import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * The kit every agent chart on the Report is built from — Connections, DNS,
 * the status breakdown (`agentRates.ts`), Load generators (`agentInjectors.ts`)
 * and the duration charts (`agentDurations.ts`). Its own module because three
 * transforms share it and none of them owns it.
 *
 * ═══ A SPARSE PAYLOAD IS NOT A CONTINUOUS ONE ═══
 *
 * The API writes some series only for buckets that had an event — the DNS and
 * status rates, and every duration's percentiles over time — while the
 * connection, kernel and JVM figures are written for every sample. Drawn as
 * given, a sparse payload's line runs straight across seconds nobody measured:
 * nine seconds of connects, thirty seconds of nothing, one connect more, and a
 * line from 9 s to 39 s that reads as a steady rate.
 *
 * So `bucketChart` fills every missing `bucketWidthMs` step BETWEEN two
 * consecutive buckets, by what the measure is (`Measure.gap`):
 *
 *   counter  a bucket with no row saw no event — the controller's own rule —
 *            so the step is a measured 0, drawn and tabulated as 0
 *   gauge    a level nobody read there, so the step is a null: a break in the
 *            line and a dash in the table, never a zero
 *
 * Per MEASURE, not per chart, because "TCP Connections Events per Second" holds
 * four counters beside `established`, a gauge. On a dense payload there is no
 * missing step and nothing changes. Nothing is invented before the first bucket
 * or after the last: a run's edges are where its own data says they are.
 */

/**
 * Heads every data table's label column. The drawn axis is named by `Chart`.
 */
export const TIME_COLUMN = 'Elapsed (s)';

export type Opts = { readonly windowSelected: boolean };
type Pair = readonly [number, number | null];

/**
 * A bucket's sum as a per-second rate, or `null` where nothing was measured.
 * `?? 0` is what this must never do.
 */
export function perSecond(value: number | null, widthMs: number): number | null {
  return value === null ? null : value / (widthMs / 1000);
}

/**
 * The zero-series ruling: the series worth drawing, and the names of the two
 * kinds that are not.
 *
 *   zero    at least one reading, and every reading is 0
 *   unread  no reading at all — every y is null
 *
 * NEITHER IS PLOTTED. An unread series drawn would be an invisible line that
 * still spends one of the palette's six hues: on a macOS load generator, whose
 * TCP states and RAM are never read, it would cap a series that HAS readings
 * under a note blaming the palette. The two groups are kept apart because
 * their sentences differ — "every reading is zero" would be false of a series
 * nobody read. `zeroSeriesNote` and `unreadSeriesNote` carry the words.
 */
export function dropAllZero(series: readonly ChartSeries[]): {
  readonly kept: ChartSeries[];
  readonly zero: string[];
  readonly unread: string[];
} {
  const kept: ChartSeries[] = [];
  const zero: string[] = [];
  const unread: string[] = [];
  for (const s of series) {
    const values = (s.data as readonly (number | null | Pair)[]).map((d) => (Array.isArray(d) ? d[1] : d) as number | null);
    const measured = values.filter((v): v is number => v !== null);
    if (measured.length === 0) unread.push(s.name);
    else if (measured.every((v) => v === 0)) zero.push(s.name);
    else kept.push(s);
  }
  return { kept, zero, unread };
}

/** The `limitation` sentence for `dropAllZero`'s `zero` group, or nothing. */
export function zeroSeriesNote(zero: readonly string[]): string | undefined {
  return zero.length === 0 ? undefined : `Not drawn: every reading is zero — ${zero.join(', ')}.`;
}

/** The `limitation` sentence for `dropAllZero`'s `unread` group, or nothing. */
export function unreadSeriesNote(unread: readonly string[]): string | undefined {
  return unread.length === 0 ? undefined : `Not drawn: no reading was taken — ${unread.join(', ')}.`;
}

/**
 * One series' name, how to read its y off a bucket, and what a missing bucket
 * between two others means for it (see the module note). `gap` is REQUIRED:
 * the wrong answer draws either an invented zero or a line across nothing, and
 * neither looks wrong.
 */
export interface Measure<B> {
  readonly name: string;
  readonly read: (bucket: B) => number | null;
  readonly gap: 'counter' | 'gauge';
}

/**
 * The offsets to draw at: every bucket's, plus each `widthMs` step missing
 * between two consecutive ones. `null` for a step this module filled, else the
 * bucket. A null width (nothing to step by) fills nothing.
 */
export function bucketGrid<B extends { readonly startOffsetMs: number }>(
  buckets: readonly B[],
  widthMs: number | null,
): readonly { readonly x: number; readonly bucket: B | null }[] {
  const grid: { x: number; bucket: B | null }[] = [];
  buckets.forEach((b, i) => {
    const previous = buckets[i - 1];
    if (previous !== undefined && widthMs !== null && widthMs > 0) {
      for (let x = previous.startOffsetMs + widthMs; x < b.startOffsetMs; x += widthMs) {
        grid.push({ x, bucket: null });
      }
    }
    grid.push({ x: b.startOffsetMs, bucket: b });
  });
  return grid;
}

/**
 * Every chart here has this shape: buckets with an offset, a fixed list of
 * measures, pairs for the drawing and the same numbers for the table — on the
 * filled grid (`bucketGrid`), each missing step drawn by its measure's `gap`.
 */
export function bucketChart<B extends { readonly startOffsetMs: number }>(
  buckets: readonly B[],
  measures: readonly Measure<B>[],
  empty: string,
  widthMs: number | null,
): ChartData {
  const columns = [TIME_COLUMN, ...measures.map((m) => m.name)];
  if (buckets.length === 0) {
    // Not a flat zero line: a window or run that recorded nothing is said so.
    return { series: [], axisLabels: [], columns, rows: [], empty };
  }
  const grid = bucketGrid(buckets, widthMs);
  const measured = measures.map((m) =>
    grid.map(({ bucket }) => (bucket === null ? (m.gap === 'counter' ? 0 : null) : m.read(bucket))),
  );
  const series: ChartSeries[] = measures.map((m, s) => ({
    name: m.name,
    // A null y keeps its pair — omitting the point would draw a line across the gap.
    data: grid.map(({ x }, i) => [x, measured[s]![i] ?? null] as Pair),
  }));
  const rows: ChartTableRow[] = grid.map(({ x }, i) => ({
    label: String(x / 1000),
    values: measured.map((line) => line[i] ?? '—'),
  }));
  return { series, axisLabels: [], columns, rows };
}

/**
 * "No <things> fall in the selected window." or "… were recorded for this run."
 * One wording for every agent chart.
 */
export function emptySentence(things: string, opts: Opts): string {
  return opts.windowSelected
    ? `No ${things} fall in the selected window.`
    : `No ${things} were recorded for this run.`;
}

/**
 * ═══ NO AGENT CHART DRAWS A MARKLESS GRID ═══
 *
 * Dropping series can leave a chart with none, and empty axes say nothing —
 * worse, they read as "the agent measured and found nothing to plot". So when
 * nothing is kept, the chart is `empty`, with the same reasons its `limitation`
 * would have given, said of the window or the run as the reader asked. The
 * data table keeps every column and row either way.
 */
function dropAndExplain(
  chart: ChartData,
  opts: Opts,
  dropZero: boolean,
  otherNotes: readonly (string | undefined)[],
): ChartData {
  const split = dropAllZero(chart.series);
  const zero = dropZero ? split.zero : [];
  const kept = chart.series.filter((s) => !split.unread.includes(s.name) && !zero.includes(s.name));
  const others = otherNotes.filter((n): n is string => n !== undefined);
  if (kept.length === 0) {
    const reasons = [
      zero.length > 0 ? `every reading is zero — ${zero.join(', ')}` : undefined,
      split.unread.length > 0 ? `no reading was taken — ${split.unread.join(', ')}` : undefined,
    ].filter((r): r is string => r !== undefined);
    const scope = opts.windowSelected ? 'in the selected window' : 'for this run';
    const empty = reasons.length > 0 ? `Nothing to draw ${scope}: ${reasons.join('; ')}.` : `Nothing to draw ${scope}.`;
    return { ...chart, series: [], empty, limitation: others.length > 0 ? others.join(' ') : undefined };
  }
  const notes = [zeroSeriesNote(zero), unreadSeriesNote(split.unread), ...others].filter(
    (n): n is string => n !== undefined,
  );
  return { ...chart, series: kept, limitation: notes.length > 0 ? notes.join(' ') : undefined };
}

/**
 * Applies the zero-series ruling to a built chart — every-zero and never-read
 * series are dropped and named — joining its note to any other. The ruling's
 * scope is the plan's: TCP states, status codes, GC and kernel TCP counters.
 */
export function withoutAllZero(chart: ChartData, opts: Opts, ...otherNotes: (string | undefined)[]): ChartData {
  return dropAndExplain(chart, opts, true, otherNotes);
}

/**
 * The half of the ruling every agent chart takes, gauges included: a series
 * with no reading at all is dropped and named, while a measured zero is drawn.
 * For CPU and memory, where 0 is a reading worth seeing.
 */
export function withoutUnread(chart: ChartData, opts: Opts, ...otherNotes: (string | undefined)[]): ChartData {
  return dropAndExplain(chart, opts, false, otherNotes);
}

/**
 * A rate chart for a payload with no bucket width. The contract makes it null
 * only when nothing was collected, but a rate cannot be drawn without one, and
 * assuming 1000 is the mis-scaled chart this module exists to avoid.
 */
export function noWidth(names: readonly string[]): ChartData {
  return {
    series: [],
    axisLabels: [],
    columns: [TIME_COLUMN, ...names],
    rows: [],
    empty: 'These figures carry no bucket width, so no per-second rate can be drawn.',
  };
}
