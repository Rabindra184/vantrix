import { useEffect, useMemo, useRef, useState } from 'react';
import DataTable from './DataTable';
import { echarts } from './echarts';
import {
  assignPalette,
  chartTheme,
  resolveChartMode,
  type ChartMode,
  type StatusRole,
} from './theme';
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
   * Swaps the category and value axes, so bars run left-to-right. Ignored by
   * pies. The indicator bands are one stacked bar of four segments, and drawn
   * vertically that is a single column filling most of the plot; horizontally
   * it reads as what it is — a proportion bar. Ignored by lines, which have a
   * time axis that is not negotiable.
   */
  readonly horizontal?: boolean;
  /**
   * Draw the marks in STATUS colours instead of the categorical palette, in
   * this order.
   *
   * For the charts whose marks are states rather than identities — the
   * indicator bands ③ and the OK/KO donut ④. See `StatusRole` in `theme.ts` for
   * why those two must not spend categorical hues.
   *
   * WHAT THE ORDER LINES UP WITH is ECharts' own top-level `color` semantics
   * and therefore differs by `kind`: a bar or line chart consumes it PER
   * SERIES, a single-series pie consumes it PER SLICE. So the bands pass one
   * role per series (`BAND_ROLES`, four series of one value each) and the donut
   * passes one role per slice (`OUTCOME_ROLES`, aligned with `axisLabels`).
   * Both transforms document their side of that.
   *
   * Pass a module-level constant, not a fresh array: this is in the option
   * effect's dependency list.
   */
  readonly statusRoles?: readonly StatusRole[];
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
  horizontal = false,
  group,
  yAxis,
  statusRoles,
}: ChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  // Held across renders so the option can be updated without the instance
  // being rebuilt — see the two effects below.
  const instanceRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [mode, setMode] = useState<ChartMode>(() => resolveChartMode());

  // The y-axis, as primitives. See the option effect's closing comment.
  const yAxisType = yAxis?.type ?? 'value';
  const yAxisName = yAxis?.name;

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

  // THE INSTANCE'S LIFETIME, and nothing else: create, join the crosshair
  // group, follow the container's size, dispose.
  //
  // Split from the option-setting effect below deliberately. When the two were
  // one effect, every value the option depends on was also a reason to
  // `dispose()` and `init()` — and two of those values (`data`, `yAxis`) are
  // objects compared by identity, which a documented call site like
  // `<Chart yAxis={{ type: 'log' }} …/>` makes fresh on every render. A
  // React Query background refetch would then tear down and rebuild all eight
  // charts inside one commit: a visible flash, and any hover, tooltip or axis
  // pointer the reader was mid-interaction with thrown away. Now a change of
  // data costs a `setOption`, and only a genuine change of identity
  // (`group`) or of existence (`isEmpty`) costs an instance.
  useEffect(() => {
    const element = container.current;
    // Nothing to draw: the empty branch renders prose instead of a chart, so
    // there is no element and no instance to make.
    if (element === null || isEmpty) return;

    const instance = echarts.init(element, undefined, { renderer: 'svg' });
    instanceRef.current = instance;

    // `group` must be set on the instance BEFORE connect; `connect` links
    // every live instance carrying the same group string. Calling it once per
    // mounted chart is intended — it is idempotent for a group that is
    // already connected, and it is what makes a chart mounting later join the
    // crosshair the others already share.
    if (group !== undefined) {
      instance.group = group;
      echarts.connect(group);
    }

    // ResizeObserver, not a window `resize` listener: the chart's width is set
    // by its column, which changes when the page's layout does without the
    // window changing size at all. Guarded because jsdom has no
    // ResizeObserver and a chart mounted there must not throw.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => instance.resize()) : null;
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      // Dispose, always. An undisposed instance keeps its own listeners and
      // its SVG root alive, and a page of eight charts remounted on every run
      // navigation leaks all eight.
      instance.dispose();
      instanceRef.current = null;
    };
  }, [isEmpty, group]);

  // WHAT IS DRAWN. Runs after the effect above on mount (effects fire in
  // declaration order), and on its own whenever the data or the theme moves.
  useEffect(() => {
    const instance = instanceRef.current;
    if (instance === null) return;

    const theme = chartTheme(mode);
    const drawn = assignment.drawn;
    const axisText = { color: theme.inkMuted };

    // The category axis and the value axis, built once and then placed on
    // whichever of x/y `horizontal` says. Splitting them out is what keeps the
    // orientation a single swap rather than two near-identical axis blocks.
    const categoryAxis = {
      type: 'category',
      data: [...data.axisLabels],
      axisLabel: axisText,
      // No chart border (design §11): the axis line stays, the enclosing box
      // does not.
      axisLine: { lineStyle: { color: theme.gridline } },
      splitLine: { show: false },
    };
    const valueAxis = {
      type: yAxisType,
      name: yAxisName,
      nameTextStyle: axisText,
      axisLabel: axisText,
      axisLine: { show: false },
      // Hairline gridlines in the gridline token, so they sit behind the data
      // rather than competing with it.
      splitLine: { lineStyle: { color: theme.gridline, width: 1 } },
    };

    instance.setOption(
      {
        // Series colour comes from the palette, which `assignPalette` reads off
        // the `--chart-*` tokens — unless the chart declared `statusRoles`, in
        // which case its marks are states and wear the `--color-status-*`
        // tokens instead. Text NEVER wears either (design §11): the palettes
        // are tuned for marks on a surface, and 12px type in a series colour is
        // the commonest way a chart quietly fails contrast.
        color:
          statusRoles === undefined
            ? drawn.map((series) => series.color)
            : statusRoles.map((role) => theme.status[role]),
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
          // Surface and ink tokens, not ECharts' defaults: the default tooltip
          // is a near-white panel with dark text, which on a dark page is a
          // flashlight over the data.
          backgroundColor: theme.surface,
          borderColor: theme.gridline,
          textStyle: { color: theme.ink },
          // The crosshair `connect` propagates between grouped charts.
          axisPointer: { type: 'line', lineStyle: { color: theme.inkMuted } },
        },
        ...(kind === 'pie'
          ? {}
          : {
              grid: {
                top: drawn.length >= 2 ? 36 : 12,
                // A horizontal chart's category labels sit in the left gutter
                // and are words, not axis ticks, so they need the room.
                left: horizontal ? 104 : 56,
                right: 16,
                bottom: 32,
              },
              ...(horizontal
                ? { xAxis: valueAxis, yAxis: categoryAxis }
                : { xAxis: categoryAxis, yAxis: valueAxis }),
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
      },
      // notMerge. Task 8's band selector removes series, and a merging
      // setOption keeps the ones it was not told about — so deselecting p99
      // would leave p99 on the chart.
      true,
    );
    // `yAxis` is spread into PRIMITIVES above (`yAxisType`, `yAxisName`) rather
    // than listed here as an object: it is compared by identity, and the
    // documented call site `<Chart yAxis={{ type: 'log' }} …/>` builds a new
    // one every render.
  }, [data, kind, stacked, horizontal, statusRoles, yAxisType, yAxisName, mode, assignment]);

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
