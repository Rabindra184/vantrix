import { useEffect, useMemo, useRef, useState } from 'react';
import Card from '../components/Card';
import DataTable from './DataTable';
import { echarts } from './echarts';
import { tooltipFormatter } from './tooltip';
import {
  assignPalette,
  chartTheme,
  resolveChartMode,
  type ChartMode,
  type MarkRole,
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

/**
 * Names the CATEGORY axis — `axisLabels` — which is what `xAxis` has always
 * meant here in the same way `yAxis` has always meant the value axis: a
 * `horizontal` chart swaps which of x/y each one is placed on, and
 * `IndicatorsChart` already passes `yAxis={{ name: 'Requests' }}` for an axis
 * that ends up drawn along the bottom.
 *
 * No `type`: a category axis has no scale to choose.
 *
 * Unused by the six time-axis charts, whose labels are elapsed seconds and say
 * so in the title. It exists for the distribution ⑧, the first chart whose
 * category labels are ambiguous on their own — a bare `28` under a bar is
 * either the midpoint of a 25 ms bin or a response time some request actually
 * took, depending on `exactValues`, and the reader has no other way to tell.
 * `DistributionChart` passes `data.columns[0]`, so the drawn axis and the data
 * table's label column are one string and cannot drift.
 *
 * A `scatter` has no categories: its x is a measured quantity and its series
 * carry explicit [x, y] pairs, so this names the numeric horizontal axis
 * instead. Same prop, same position on screen, different axis type underneath.
 */
export interface ChartXAxis {
  readonly name?: string;
  /**
   * `'value'` when the horizontal axis is a MEASURED QUANTITY rather than a
   * category, so the series carry explicit `[x, y]` pairs.
   *
   * A scatter is always this and does not need to say so — `kind` already
   * settles it. The prop exists for a LINE whose x is a measurement: the
   * percentiles-distribution chart plots response time against percentile, and
   * its percentiles are not evenly spaced (they come from a cumulative sum over
   * bin counts, so they arrive at 12%, 47%, 89%…). Drawn on a category axis
   * those would be spread at equal intervals, which straightens exactly the
   * curvature the chart exists to show.
   */
  readonly type?: 'category' | 'value';
}

export interface ChartProps {
  /** Stable per chart. Names the data table (`chart-data-<id>`) and the figure. */
  readonly id: string;
  readonly title: string;
  readonly data: ChartData;
  /** `'line'` unless stated — the shape six of the eight overview charts take. */
  readonly kind?: 'line' | 'bar' | 'pie' | 'scatter';
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
   * Draw the marks in SEMANTIC colours instead of the categorical palette, in
   * this order.
   *
   * For the charts whose marks mean something rather than merely differing —
   * the indicator bands ③, which take the `band-*` severity ramp, and the OK/KO
   * donut ④, which takes the app-wide status colours. See `MarkRole` in
   * `theme.ts` for why those two must not spend categorical hues, and why they
   * do not take the same palette as each other.
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
  readonly roles?: readonly MarkRole[];
  /**
   * ECharts `connect` group. Charts sharing one string share one crosshair, so
   * hovering requests/s moves the pointer on concurrent users too. That linkage
   * is WHY active users is its own chart instead of a second y-axis: §22.4
   * forbids dual axes outright, and a shared crosshair is what recovers the
   * "read these two together" affordance a dual axis was buying.
   */
  readonly group?: string;
  /**
   * The unit every value in this chart's TOOLTIP carries — `'ms'`, `'%'`,
   * `'req/s'`.
   *
   * Per chart, because the chart is what knows its own axis. The unit was
   * previously only in the axis title, which is not where a reader's eye is
   * when they are reading a tooltip: the tooltip is the surface they take
   * numbers off, since the data table is collapsed until asked for.
   *
   * Omitted where an axis is unitless or mixed. Never a unit that disagrees
   * with the axis title already on screen.
   */
  readonly unit?: string;
  readonly yAxis?: ChartYAxis;
  readonly xAxis?: ChartXAxis;
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
  unit,
  yAxis,
  xAxis,
  roles,
}: ChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  // Held across renders so the option can be updated without the instance
  // being rebuilt — see the two effects below.
  const instanceRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [mode, setMode] = useState<ChartMode>(() => resolveChartMode());

  // The axes, as primitives. See the option effect's closing comment.
  const yAxisType = yAxis?.type ?? 'value';
  const yAxisName = yAxis?.name;
  const xAxisName = xAxis?.name;
  // A scatter's x is numeric by definition; any other chart has to ask. Folded
  // to a primitive here for the same reason the other three are — see the
  // option effect's closing comment about identity-compared object props.
  const xAxisNumeric = kind === 'scatter' || xAxis?.type === 'value';

  // Follow the active colour scheme while the page is open, so a chart drawn
  // in light mode is not left with light-mode hues on a dark surface.
  //
  // TWO SOURCES, because `resolveChartMode` reads two: the OS setting, and an
  // explicit `[data-theme]` on `<html>` which overrides it. Watching only
  // `prefers-color-scheme` — which is all this did while no toggle existed —
  // means clicking Dark in `ThemeToggle` repaints the whole app around eight
  // charts still drawn in light-mode ink, gridlines and tooltip fills, on a
  // near-black card. The MutationObserver is the notification this file's
  // previous comment said a toggle would have to bring with it.
  //
  // `attributeFilter` keeps this to the one attribute that matters: React
  // Router and TanStack both touch `<html>`/`<body>` classes, and an
  // unfiltered observer would recompute the mode on every one of them.
  useEffect(() => {
    const onChange = () => setMode(resolveChartMode());

    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    query?.addEventListener('change', onChange);

    // Guarded: jsdom has MutationObserver, but a non-DOM test environment
    // (`vitest.config.ts`'s node-environment globs) has neither it nor
    // `document`, and a chart must not throw when rendered to a string.
    const observer =
      typeof MutationObserver === 'function' && typeof document !== 'undefined'
        ? new MutationObserver(onChange)
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      query?.removeEventListener('change', onChange);
      observer?.disconnect();
    };
  }, []);

  const isEmpty = data.empty !== undefined;

  // Six hues, no cycling — a seventh series is left undrawn and said so,
  // rather than silently repeating a colour. Computed outside the effect
  // because its `limitation` is rendered as prose, not drawn, and memoised
  // because it is in that effect's dependency list: a fresh object per render
  // would tear down and re-initialise the ECharts instance on every render.
  //
  // A series may declare itself `essential` (see `ChartSeries`), which exempts
  // it from the cut without moving it: the concurrent-users chart's total is
  // last in the list and must be drawn even when six scenarios precede it.
  //
  // A chart that declares `roles` brought its own colour per series and is not
  // spending categorical hues, so the six-slot cap does not apply to it. The
  // cap exists to stop a SEVENTH series wrapping back to `--chart-1`; a ramp
  // has no wraparound to prevent. Charts without `roles` are unaffected.
  const assignment = useMemo(() => {
    const names = data.series.map((series) => series.name);
    if (roles !== undefined) {
      return { drawn: names.map((name, index) => ({ index, name, color: '' })), undrawn: [] };
    }
    const essential = data.series.flatMap((series, i) => (series.essential === true ? [i] : []));
    return assignPalette(names, mode, essential);
  }, [data.series, mode, roles]);

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
      name: xAxisName,
      // Centred under the axis rather than at its end, which is ECharts'
      // default: the one caller's name is a phrase ("Response time (ms, bin
      // midpoint)"), and at `end` it is drawn past the last tick and clipped
      // by the container. `nameGap` clears the tick labels; the grid below
      // makes the room for it.
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: axisText,
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
    /**
     * FOR A CHART WHOSE X IS A MEASURED QUANTITY, not a category — its series
     * carry explicit [x, y] pairs rather than one value per label, so a category
     * axis would index them by position and draw the run's throughput as 0, 1, 2…
     *
     * Every scatter, and any other chart that asks via `xAxis.type: 'value'`.
     * That second case is the percentiles-distribution line, whose percentiles
     * come from a cumulative sum and so are not evenly spaced.
     */
    const numericAxis = {
      type: 'value' as const,
      name: xAxisName,
      nameLocation: 'middle' as const,
      nameGap: 28,
      nameTextStyle: axisText,
      axisLabel: axisText,
      axisLine: { lineStyle: { color: theme.gridline } },
      splitLine: { show: false },
    };

    instance.setOption(
      {
        // Mark colour comes from the categorical palette, which `assignPalette`
        // reads off the `--chart-*` tokens — unless the chart declared `roles`,
        // in which case its marks mean something and wear the `--chart-status-*`,
        // `--chart-band-*` or `--chart-pct-*` tokens instead. Text NEVER wears
        // any of them (design §11): the palettes are tuned for marks on a
        // surface, and 12px type in a mark colour is the commonest way a chart
        // quietly fails contrast.
        color:
          roles === undefined
            ? drawn.map((series) => series.color)
            : roles.map((role) => theme.roles[role]),
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
          // ONE FORMATTER, in `./tooltip`, which owns every decision about what
          // this panel says: the shared `formatCell` rounding, the unit suffix,
          // the escaping of series names (which are PAYLOAD DATA and therefore
          // untrusted), and the switch to two columns above eight series.
          //
          // It replaced `valueFormatter`, which could only see a value and so
          // could not do the last three. Keeping `valueFormatter` for narrow
          // charts and adding a custom `formatter` for wide ones would have put
          // two code paths on the same value — the exact bug that sharing
          // `formatCell` with the data table exists to prevent.
          formatter: (params: unknown) => tooltipFormatter(params, unit),
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
                // A named category axis needs the room its name is drawn in.
                bottom: xAxisName === undefined ? 32 : 56,
              },
              ...(horizontal
                ? { xAxis: valueAxis, yAxis: categoryAxis }
                : { xAxis: xAxisNumeric ? numericAxis : categoryAxis, yAxis: valueAxis }),
            }),
        // `index`, NOT the position in `drawn`. The two agree only while the
        // drawn set is a prefix of the series list, and an `essential` series
        // kept over an earlier one breaks that — pairing by position would then
        // draw each colour against the next series' numbers.
        series: drawn.map(({ name, index }) => {
          const source = data.series[index]!;
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
            // A scatter IS its symbols. `showSymbol: false` — right for a
            // 600-bucket line — draws an empty grid here.
            showSymbol: kind === 'scatter' ? true : false,
          };
        }),
      },
      // notMerge. Task 8's band selector removes series, and a merging
      // setOption keeps the ones it was not told about — so deselecting p99
      // would leave p99 on the chart.
      true,
    );
    // `yAxis` and `xAxis` are spread into PRIMITIVES above (`yAxisType`,
    // `yAxisName`, `xAxisName`) rather than listed here as objects: they are
    // compared by identity, and the documented call site
    // `<Chart yAxis={{ type: 'log' }} …/>` builds a new one every render.
  }, [
    data,
    kind,
    stacked,
    horizontal,
    roles,
    unit,
    yAxisType,
    yAxisName,
    xAxisName,
    xAxisNumeric,
    mode,
    assignment,
  ]);

  return (
    <Card as="figure" data-testid={`chart-${id}`}>
      {/* `Chart`'s own `<h3>`, not `Card`'s `title` prop — which is exactly
          why that prop is optional (see `Card`'s docstring): a card that always
          drew a heading would give every figure two, and the figure's
          accessible name would become whichever won. */}
      <h3 className="text-[15px] font-semibold tracking-tight text-primary">{title}</h3>

      {isEmpty ? (
        // An explanation, never empty axes. A grid with no marks reads as "this
        // was measured and found to be nothing"; the truth is usually "this run
        // has not been parsed yet" or "nothing was recorded", and those are
        // different facts a reader acts on differently.
        //
        // Given the height a drawn chart would have occupied, so a stack of
        // eight figures keeps its rhythm when one of them has nothing to draw —
        // and so the page does not resize around the reader if a pending
        // payload arrives while they are looking at it.
        <p
          role="status"
          className="flex h-72 items-center justify-center rounded-lg bg-sunken px-6 text-center text-[13px] text-muted"
        >
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
          palette's (a seventh series that would have had to reuse a hue).

          Set apart with a rule and a smaller size rather than left as another
          paragraph: these are caveats ABOUT the figure, and a reader
          skimming eight charts has to be able to tell them from the figure's
          own description at a glance. */}
      {(data.limitation !== undefined || assignment.limitation !== undefined) && (
        <div className="flex flex-col gap-1 border-t border-divider pt-3 text-[12px] leading-relaxed text-muted">
          {data.limitation !== undefined && <p>{data.limitation}</p>}
          {assignment.limitation !== undefined && <p>{assignment.limitation}</p>}
        </div>
      )}

      <DataTable id={id} caption={title} columns={data.columns} rows={data.rows} />
    </Card>
  );
}
