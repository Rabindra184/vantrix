import { useEffect, useMemo, useRef, useState } from 'react';
import DataTable from './DataTable';
import { echarts } from './echarts';
import { assignPalette, chartTheme, resolveChartMode, type ChartMode } from './theme';
import type { ChartData } from './types';

export interface ChartYAxis {
  /**
   * `'log'` is the default for the percentile bands (design §11) and the
   * component offering the linear toggle passes `'value'`. Kept as a prop
   * rather than inferred: which scale is honest is a property of the measure,
   * not of the numbers that happen to have arrived.
   */
  readonly type?: 'value' | 'log';
  readonly name?: string;
}

export interface ChartProps {
  /** Stable per chart. Names the data table (`chart-data-<id>`) and the figure. */
  readonly id: string;
  readonly title: string;
  readonly data: ChartData;
  /** `'line'` unless stated — the shape six of the eight overview charts take. */
  readonly kind?: 'line' | 'bar' | 'pie';
  /** Stacked bars, for the indicator bands. Ignored by lines and pies. */
  readonly stacked?: boolean;
  /**
   * ECharts `connect` group. Charts sharing one string share one crosshair, so
   * hovering requests/s moves the pointer on concurrent users too. That linkage
   * is WHY active users is its own chart instead of a second y-axis: §22.4
   * forbids dual axes outright, and a shared crosshair is what recovers the
   * "read these two together" affordance a dual axis was buying.
   */
  readonly group?: string;
  readonly yAxis?: ChartYAxis;
}

/**
 * The one chart primitive. Everything ECharts-shaped lives here and nowhere
 * else, so the eight chart components are each a transform plus a title.
 *
 * Renders a `<figure>`: heading, the drawing, any stated limitation, and the
 * data table. The table is rendered UNCONDITIONALLY — including for a chart
 * with no data — because it is the parity surface (design §7) and Task 10's
 * e2e suite asserts exactly one `chart-data-<id>` per chart on the page.
 *
 * NOT exercised in jsdom, deliberately (design §8): `getBoundingClientRect`
 * returns zeros there, so the chart lays out at 0×0 and any assertion about
 * what it drew is theatre. The table is plain React and tests cleanly here;
 * the drawing is proven in a real browser.
 */
export default function Chart({
  id,
  title,
  data,
  kind = 'line',
  stacked = false,
  group,
  yAxis,
}: ChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<ChartMode>(() => resolveChartMode());

  // Follow the OS colour scheme while the page is open, so a chart drawn in
  // light mode is not left with light-mode hues on a dark surface.
  //
  // Only `prefers-color-scheme` is watched. `tokens.css` also honours an
  // explicit `[data-theme]`, but nothing in this app sets one yet; when a
  // toggle lands it has to notify here too (a MutationObserver on
  // `documentElement`, or lifting the mode into context), and adding that
  // watcher now for a control that does not exist would be untestable.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setMode(resolveChartMode());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const isEmpty = data.empty !== undefined;

  // Six hues, no cycling — a seventh series is left undrawn and said so,
  // rather than silently repeating a colour. Computed outside the effect
  // because its `limitation` is rendered as prose, not drawn, and memoised
  // because it is in that effect's dependency list: a fresh object per render
  // would tear down and re-initialise the ECharts instance on every render.
  const assignment = useMemo(
    () => assignPalette(data.series.map((series) => series.name), mode),
    [data.series, mode],
  );

  useEffect(() => {
    const element = container.current;
    // Nothing to draw: the empty branch renders prose instead of a canvas, so
    // there is no element and no instance to make.
    if (element === null || isEmpty) return;

    const theme = chartTheme(mode);
    const instance = echarts.init(element, undefined, { renderer: 'svg' });

    // `group` must be set on the instance BEFORE connect; `connect` links
    // every live instance carrying the same group string. Calling it once per
    // mounted chart is intended — it is idempotent for a group that is
    // already connected, and it is what makes a chart mounting later join the
    // crosshair the others already share.
    if (group !== undefined) {
      instance.group = group;
      echarts.connect(group);
    }

    const drawn = assignment.drawn;
    const axisText = { color: theme.inkMuted };

    instance.setOption({
      // Series colour comes from the palette. Text NEVER does (design §11):
      // the palette is tuned for marks on a surface, and 12px type in a
      // series colour is the commonest way a chart quietly fails contrast.
      color: drawn.map((series) => series.color),
      textStyle: { color: theme.ink },
      backgroundColor: 'transparent',
      // A legend only from two series up. One series is named by the title,
      // and a one-entry legend is a label pretending to be a control.
      legend:
        drawn.length >= 2
          ? { top: 0, textStyle: { color: theme.ink }, icon: 'roundRect' }
          : { show: false },
      tooltip: {
        trigger: kind === 'pie' ? 'item' : 'axis',
        // The crosshair `connect` propagates between grouped charts.
        axisPointer: { type: 'line', lineStyle: { color: theme.inkMuted } },
      },
      ...(kind === 'pie'
        ? {}
        : {
            grid: { top: drawn.length >= 2 ? 36 : 12, left: 56, right: 16, bottom: 32 },
            xAxis: {
              type: 'category',
              data: [...data.axisLabels],
              axisLabel: axisText,
              // No chart border (design §11): the axis line stays, the
              // enclosing box does not.
              axisLine: { lineStyle: { color: theme.gridline } },
              splitLine: { show: false },
            },
            yAxis: {
              type: yAxis?.type ?? 'value',
              name: yAxis?.name,
              nameTextStyle: axisText,
              axisLabel: axisText,
              axisLine: { show: false },
              // Hairline gridlines in the gridline token, so they sit behind
              // the data rather than competing with it.
              splitLine: { lineStyle: { color: theme.gridline, width: 1 } },
            },
          }),
      series: drawn.map(({ name }, i) => {
        const source = data.series[i]!;
        if (kind === 'pie') {
          return {
            type: 'pie',
            name,
            radius: ['52%', '76%'],
            label: { color: theme.ink },
            data: (source.data as readonly (number | null)[]).map((value, j) => ({
              name: String(data.axisLabels[j] ?? ''),
              value,
            })),
          };
        }
        return {
          type: kind,
          name,
          stack: stacked ? 'total' : undefined,
          data: [...source.data],
          // 2px lines and 8px markers (design §11). Symbols stay off on the
          // line itself — a marker per bucket on a 600-bucket series is
          // noise — and the size applies to the emphasised/hovered point.
          lineStyle: { width: 2 },
          symbolSize: 8,
          showSymbol: false,
        };
      }),
    });

    // ResizeObserver, not a window `resize` listener: the chart's width is set
    // by its column, which changes when the page's layout does without the
    // window changing size at all. Guarded because jsdom has no
    // ResizeObserver and a chart mounted there must not throw.
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => instance.resize())
        : null;
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      // Dispose, always. An undisposed instance keeps its own listeners and
      // its SVG root alive, and a page of eight charts remounted on every run
      // navigation leaks all eight.
      instance.dispose();
    };
  }, [data, isEmpty, kind, stacked, group, yAxis, mode, assignment]);

  return (
    <figure data-testid={`chart-${id}`} className="flex flex-col gap-2 m-0">
      <h3 className="text-lg font-semibold">{title}</h3>

      {isEmpty ? (
        // An explanation, never empty axes. A grid with no marks reads as "this
        // was measured and found to be nothing"; the truth is usually "this run
        // has not been parsed yet" or "nothing was recorded", and those are
        // different facts a reader acts on differently.
        <p role="status" className="text-[var(--color-text-muted)]">
          {data.empty}
        </p>
      ) : (
        <div
          ref={container}
          // The data table is the accessible route to these values (design §7).
          // Exposing the SVG's own text nodes as well would make a screen
          // reader read axis ticks and legend fragments in visual order, which
          // is noise on top of a complete alternative.
          aria-hidden="true"
          className="h-72 w-full"
        />
      )}

      {/* Anything the chart is not showing, in prose. Both the transform's own
          limitation (truncated bins, a split the run predates) and the
          palette's (a seventh series that would have had to reuse a hue). */}
      {data.limitation !== undefined && (
        <p className="text-sm text-[var(--color-text-muted)]">{data.limitation}</p>
      )}
      {assignment.limitation !== undefined && (
        <p className="text-sm text-[var(--color-text-muted)]">{assignment.limitation}</p>
      )}

      <DataTable id={id} caption={title} columns={data.columns} rows={data.rows} />
    </figure>
  );
}
