import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Card from '../components/Card';
import { CollapseIcon } from '../components/icons';
import ChartActions from './ChartActions';
import DataTable from './DataTable';
import { echarts } from './echarts';
import { tooltipFormatter, type PairValue } from './tooltip';
import { useTimeAxis } from './TimeAxisContext';
import { clockStepMs } from './timeTicks';
import { formatClockTime, formatElapsedClock, formatZoneOffset } from '../routes/format';
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

/** The x axis fields every chart may set; `name` and `tickUnit` are the exclusive pair in `ChartXAxis` below. */
interface ChartXAxisBase {
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
  /**
   * An EXPLICIT domain for a value axis, in the axis' own units.
   *
   * ═══ THIS IS WHAT "ONE TIME AXIS" (§22.5) ACTUALLY REQUIRES ═══
   *
   * Left to itself, each chart scales its axis to its own data, and the charts
   * on a run page do not cover the same span: `/series` is SPARSE — a second
   * with no request produces no bucket at all — so the response-time charts
   * ended at 100,000 ms across 97 buckets while the users charts ran to 99,000
   * across 100. Two axes of different extents drawn one above the other put the
   * same instant at two different x positions, and a crosshair joining them
   * points at two different moments.
   *
   * Pinning every time chart to the same `[min, max]` is what makes the shared
   * pointer mean one instant. Omit both and the axis auto-scales as before —
   * every non-time chart still does.
   */
  readonly min?: number;
  readonly max?: number;
  /**
   * The run's warm-up window in elapsed milliseconds, shaded from 0 when set.
   *
   * ═══ ON THE AXIS, NOT ON `ChartProps` (AC-STAT-4) ═══
   *
   * It is a fact about THIS axis — elapsed time from the run's start — and it
   * is meaningless on any other. Living here means it travels in the same
   * object the call sites already build from `domainMs`, and a chart with no
   * elapsed-time axis has nowhere to put it, so it cannot be handed to a
   * distribution or a scatter by mistake.
   *
   * Drawn because the two surfaces genuinely disagree and are both right:
   * `LiveEngine.add` keeps warm-up events in every time SERIES and withholds
   * them from the summary ROLLUPS, so the charts show traffic the statistics
   * table does not count. Keeping it in the series is only meaningful if a
   * reader can see which part of the line it is.
   */
  readonly warmupMs?: number;
}

/**
 * `name` and `tickUnit` are EXCLUSIVE, and the type says so.
 *
 * An elapsed-millisecond axis is named by `Chart` itself, from the viewer's
 * time mode (`Elapsed`, or `Time (GMT+5:30)` over wall-clock ticks), so a
 * caller that also named it would put a second, stale answer on the page. It
 * used to be thirteen hand-written `name: 'Elapsed (s)'` literals kept in step
 * with `tickUnit` only by `timeAxis.test.ts`; now passing both does not
 * compile.
 */
export type ChartXAxis = ChartXAxisBase &
  (
    | {
        /**
         * Names the CATEGORY axis — `axisLabels` — which is what `xAxis` has
         * always meant here in the same way `yAxis` has always meant the
         * value axis: a `horizontal` chart swaps which of x/y each one is
         * placed on, and `IndicatorsChart` already passes
         * `yAxis={{ name: 'Requests' }}` for an axis that ends up drawn along
         * the bottom.
         *
         * No `type`: a category axis has no scale to choose.
         *
         * Unused on an elapsed-time axis, which `Chart` names itself from the
         * time mode (the second branch). It exists for the distribution ⑧,
         * the first chart whose category labels are ambiguous on their own —
         * a bare `28` under a bar is either the midpoint of a 25 ms bin or a
         * response time some request actually took, depending on
         * `exactValues`, and the reader has no other way to tell.
         * `DistributionChart` passes `data.columns[0]`, so the drawn axis and
         * the data table's label column are one string and cannot drift.
         *
         * A `scatter` has no categories: its x is a measured quantity and its
         * series carry explicit [x, y] pairs, so this names the numeric
         * horizontal axis instead. Same prop, same position on screen,
         * different axis type underneath.
         */
        readonly name?: string;
        readonly tickUnit?: undefined;
      }
    | {
        /**
         * Draws a MILLISECOND value axis as clock time: `HH:MM:SS` elapsed
         * from the run's start, or the reader's own wall clock in Datetime
         * mode (`TimeAxisProvider`). The axis pointer's label, which is the
         * tooltip's title, follows the ticks.
         *
         * ═══ IT CHANGES THE LABELS AND NOTHING ELSE ═══
         *
         * The axis stays in milliseconds, because on the time-window strip
         * the axis' units ARE the contract: the `dataZoom` slider reports its
         * handles in them and `TimeBrush` writes those numbers straight to
         * the URL. Converting the axis itself would silently re-denominate
         * every committed window, the same class of bug as drawing the scalar
         * form on a value axis, which once turned a drag over a third of a
         * 63 s run into `?from=0&to=7`.
         *
         * A STRING, not a formatter function: it lands in the option effect's
         * dependency list, and a caller-built closure would be a fresh
         * identity every render and re-run that effect continuously.
         */
        readonly tickUnit: 'ms-as-s';
        readonly name?: never;
      }
  );

export interface ChartProps {
  /** Stable per chart. Names the data table (`chart-data-<id>`) and the figure. */
  readonly id: string;
  readonly title: string;
  readonly data: ChartData;
  /**
   * This chart's own controls — band selection, outcome, scale — drawn INSIDE
   * the figure, between the heading and the drawing.
   *
   * The slot exists because the alternative had them outside it. A chart that
   * owns controls used to render `<div><controls/><Chart/></div>`, which put
   * them in the page background above the card: on the run page that left two
   * unlabelled clusters of chips floating between figures, each equally close
   * to the chart above it and the chart below it. Nothing on screen said which
   * chart either one drove.
   *
   * Build them from `ChartControls`, which is where the three shapes and the
   * selected-state styling live.
   */
  readonly controls?: ReactNode;
  /**
   * A SPARKLINE: short, unlabelled, no legend — §22.6's mobile summary.
   *
   * The shape a number is making, beside the number itself. Axes and a legend
   * would take more room than the line and say nothing a 96px-tall figure can
   * afford to say; the stat tiles above it carry the values, and the data table
   * below it stays exactly where it is, so nothing is lost to a reader who
   * cannot see the drawing.
   */
  readonly compact?: boolean;
  /**
   * A NAVIGATOR: shorter than a figure, no legend, axes KEPT.
   *
   * Between `compact` and a full plot, and the difference from `compact` is
   * the whole reason it exists. A sparkline sits beside the number it
   * describes, so it can drop its axes; a navigator is the control a reader
   * DRAGS, and one with no time labels gives them no idea where they are.
   *
   * `TimeBrush` is the only caller. At the full 288px its strip plus header,
   * legend, slider and fields came to ~460px of chrome above every tab's
   * content — measured at 1440x900, what kept the run's own totals at y=1570.
   * A control for choosing a stretch of time should not be the largest thing
   * on the page.
   */
  readonly navigator?: boolean;
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
  /**
   * How this chart's `[x, y]` points read in a tooltip — see `PairValue`.
   *
   * `'xy'` by default, which is what a scatter needs and what every pair-shaped
   * chart did before the time axes moved to a value axis. A time series passes
   * `'y'`: its x is the instant, and the tooltip's title already names it.
   */
  readonly pairValue?: PairValue;
  readonly yAxis?: ChartYAxis;
  readonly xAxis?: ChartXAxis;
  /**
   * Turns this chart into a RANGE SELECTOR: a `dataZoom` slider under the
   * plot, reporting the elapsed range a reader drags out.
   *
   * ═══ OPT-IN, SO THE OTHER EIGHT ARE UNTOUCHED ═══
   *
   * Absent on every other chart, and `Chart` emits no `dataZoom` at all when
   * it is absent — a unit test asserts exactly that, because a slider quietly
   * appearing under all eight figures would be the kind of change that looks
   * fine in review and wrong on screen.
   *
   * ═══ IT DOES NOT VIOLATE THE ONE-SVG INVARIANT ═══
   *
   * Nine specs prove a chart drew by asserting exactly one `<svg>` inside its
   * `<figure>`. ECharts' SVG renderer emits ONE `<svg>` root per instance and
   * draws the slider inside it as `<g>`/`<rect>` children, so the count is
   * unchanged. The rule those specs encode is about a SEPARATE decorative
   * `<svg>` — an icon — not about anything ECharts itself draws.
   *
   * ═══ IT IS NOT A KEYBOARD PATH ═══
   *
   * ECharts' dataZoom is pointer-only. A chart carrying this must offer the
   * same selection some other way, or the window becomes mouse-exclusive.
   * `TimeBrush` keeps its numeric fields for exactly that reason.
   */
  readonly brush?: {
    /** Called with the dragged range, in the x-axis' own units. */
    readonly onChange: (fromMs: number, toMs: number) => void;
    /** Where the handles sit, or `null` for the full extent. */
    readonly value: { readonly fromMs: number; readonly toMs: number } | null;
  };
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
/**
 * The slider's own footprint, bottom edge to top edge — the two numbers it is
 * laid out with, named once so the grid that has to clear it cannot drift from
 * the slider that has to fit in it.
 */
const BRUSH_INSET = 4;
const BRUSH_HEIGHT = 28;
const BRUSH_BAND = BRUSH_INSET + BRUSH_HEIGHT;

/**
 * The legend's own footprint, and the gap it keeps from whatever is under it.
 *
 * THE LEGEND IS DRAWN AT THE BOTTOM, and that is a correctness fix rather than
 * a preference. A value axis draws its `name` one `nameGap` ABOVE the axis
 * line, i.e. in the band immediately above `grid.top` — the same band a
 * top-anchored legend occupies. The two therefore always compete, and on the
 * percentile chart they collided visibly at every width: `Response time (ms)`
 * was overprinted by the `min` swatch at 1568px, and at 390px the wrapped
 * legend covered both the axis name and the topmost tick label (`100,000`),
 * leaving neither readable. Moving the legend below the plot is the only
 * placement where the two cannot share a band, whatever the series count.
 *
 * `type: 'scroll'` is load-bearing for the same reason: a wrapping legend has
 * no bounded height, so no reservation here could be right for every width. A
 * scrolling legend is exactly one row tall, always, and pages the overflow
 * behind arrows. Nothing is lost by that — the data table below carries every
 * series unconditionally (design §7).
 */
const LEGEND_HEIGHT = 24;
const LEGEND_GAP = 2;
const LEGEND_BAND = LEGEND_HEIGHT + LEGEND_GAP;

export default function Chart({
  id,
  title,
  data,
  controls,
  compact = false,
  navigator = false,
  kind = 'line',
  stacked = false,
  horizontal = false,
  group,
  unit,
  pairValue,
  yAxis,
  xAxis,
  roles,
  brush,
}: ChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  // Held across renders so the option can be updated without the instance
  // being rebuilt — see the two effects below.
  const instanceRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [mode, setMode] = useState<ChartMode>(() => resolveChartMode());

  /**
   * Which of the card's two views is drawn, and whether the plot is filling
   * the screen. Both live here rather than in the components that render them
   * because they are the same decision seen twice: `DataTable` cannot hide the
   * canvas, and `ChartActions` owns neither.
   *
   * NOT PERSISTED, unlike the rail's collapse or the theme. Those are
   * preferences about the app; these are about one figure in one sitting, and
   * a page that reopened ten data tables because the reader once opened one
   * would be answering a question nobody asked.
   */
  const [tableShown, setTableShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement | null>(null);

  // The axes, as primitives. See the option effect's closing comment.
  const yAxisType = yAxis?.type ?? 'value';
  const yAxisName = yAxis?.name;
  const xAxisName = xAxis?.name;
  // A primitive, for the same reason the three around it are — see
  // `ChartXAxis.tickUnit`.
  const xAxisTickUnit = xAxis?.tickUnit;
  // Primitives, like every other axis field here — see `ChartXAxis.tickUnit`.
  const xAxisMin = xAxis?.min;
  const xAxisMax = xAxis?.max;
  /**
   * THE CLOCK THIS AXIS READS, from the nearest `TimeAxisProvider`.
   *
   * Only an elapsed-millisecond axis can be relabelled, and only to the wall
   * clock when the viewer chose it AND the run has an anchor: `null` means
   * elapsed. A primitive, like every axis field here, because the option
   * effect lists it.
   */
  const timeAxis = useTimeAxis();
  const wallAnchorMs =
    xAxisTickUnit === 'ms-as-s' && timeAxis.mode === 'datetime' ? timeAxis.anchorMs : null;
  /**
   * The x axis' name as drawn. An elapsed-millisecond axis is named here and
   * nowhere else (`ChartXAxis`): `Elapsed` over elapsed ticks, or the zone over
   * wall-clock ones, taken at the run's START so a run recorded in July is
   * labelled for July whenever it is read.
   */
  const drawnXAxisName =
    xAxisTickUnit === 'ms-as-s'
      ? wallAnchorMs === null
        ? 'Elapsed'
        : `Time (${formatZoneOffset(wallAnchorMs)})`
      : xAxisName;
  /**
   * The warm-up band, or null when there is nothing to shade.
   *
   * GATED ON `tickUnit`, not merely on the value being set. A `markArea`
   * positions itself with `{ xAxis: 0 }` / `{ xAxis: warmupMs }`, and on a
   * CATEGORY axis those are category INDICES — so a millisecond count handed
   * to a distribution chart would shade the first N bins and look deliberate.
   * `tickUnit: 'ms-as-s'` is this codebase's one marker for "x is elapsed
   * milliseconds" (`ChartXAxis` makes it the only thing a caller declares
   * about such an axis; `Chart` derives the name), so it is the honest test
   * for whether the band means anything.
   *
   * A primitive, like the axis fields above it, so the option effect's
   * dependency array stays comparable by value.
   */
  const warmupBandMs =
    xAxis?.tickUnit === 'ms-as-s' && typeof xAxis.warmupMs === 'number' && xAxis.warmupMs > 0
      ? xAxis.warmupMs
      : null;
  // A scatter's x is numeric by definition; any other chart has to ask. Folded
  // to a primitive here for the same reason the other three are — see the
  // option effect's closing comment about identity-compared object props.
  const xAxisNumeric = kind === 'scatter' || xAxis?.type === 'value';

  // PRIMITIVES, for the same reason `yAxisType`/`drawnXAxisName` are: `brush` is an
  // object a call site rebuilds on every render, and listing it in the option
  // effect's dependencies would re-run that effect continuously.
  const brushFrom = brush?.value?.fromMs ?? null;
  const brushTo = brush?.value?.toMs ?? null;
  const hasBrush = brush !== undefined;
  /**
   * The span an elapsed axis DRAWS, for choosing a clock step: the window a
   * brushed navigator's slider shows, else the domain the caller pinned, else
   * what ECharts draws for an unpinned axis. `null` on any other axis, which
   * ECharts steps.
   *
   * Read from the brush because ECharts zooms the plot to the slider's window:
   * a step chosen for the whole run would leave a narrowed navigator with one
   * tick, or none.
   *
   * ═══ UNPINNED, ECHARTS DRAWS FROM ZERO, NOT FROM THE FIRST POINT ═══
   *
   * A value axis includes zero unless `scale` is set, and no axis in this app
   * sets it, so an unpinned axis runs from `min(0, first point)`. Measuring
   * from the first point instead under-counted the span: a real run's request
   * drill-down, "Place Order", had buckets from 15 s to 88 s, stepped 10 s,
   * and drew 0 to 100 s — ten intervals, eleven labels, over the eight
   * `timeTicks.ts` budgets. A request active only at the end of a long soak
   * would have drawn hundreds. The far end is still measured to the last
   * point, and ECharts still rounds it up past the run's end: that stays
   * ECharts' own behaviour.
   */
  const timeStepMs = useMemo((): number | null => {
    if (xAxisTickUnit !== 'ms-as-s') return null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const series of data.series) {
      for (const point of series.data) {
        if (point !== null && typeof point === 'object') {
          lo = Math.min(lo, point[0]);
          hi = Math.max(hi, point[0]);
        }
      }
    }
    const from = brushFrom ?? xAxisMin ?? Math.min(0, lo);
    const to = brushTo ?? xAxisMax ?? hi;
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? clockStepMs(to - from) : null;
  }, [xAxisTickUnit, data, brushFrom, brushTo, xAxisMin, xAxisMax]);
  /**
   * ═══ THE AXIS' END IS LABELLED ONLY WHEN IT IS A TICK OF THE GRID ═══
   *
   * With a fixed `interval`, ECharts ticks from the axis' start in whole steps
   * and then appends the axis' END as one more tick whenever it falls off
   * that grid (`IntervalScale#getTicks`). `hideOverlap` drops that label only
   * once the two boxes touch, so in a browser, before this: a window of 0 to
   * 2.5 s drew `00:00:00 00:00:01 00:00:02 00:00:02`, a 2.457 s run
   * `00:00:02` twice, and a window of 7 to 61 s put `00:01:01` 60px after
   * `00:00:57` on a 152px step.
   *
   * `showMaxLabel: false` drops that label and its tick, and is set on every
   * elapsed axis EXCEPT one whose end is known to be a grid tick: a pinned
   * domain a whole number of steps long, whose end ECharts draws as an
   * ordinary tick. Everywhere else the end is ECharts' to decide, not a fact
   * this axis has to state. An unpinned axis ends where ECharts rounds its
   * last point up to, which on a drill-down can be a time after the run ended;
   * a brushed navigator's slider shifts its zoomed window to keep it inside
   * the data. Dropping the label there costs at most one tick at the end of
   * such an axis, even when ECharts' end happens to fall on the grid;
   * predicting that end instead would copy ECharts' `nice` and `splitNumber`
   * into this file. The range line states the window's ends to the second.
   *
   * A value, not a formatter that blanks the end: which tick is the end
   * depends on where ECharts starts the grid, and it moves the navigator's
   * start off the brush (measured: a window of 40 to 63.161 s ticked from
   * `00:00:39`). Getting that wrong in a formatter would blank every label.
   */
  const timeAxisEndOnGrid =
    timeStepMs !== null &&
    !hasBrush &&
    xAxisMin !== undefined &&
    xAxisMax !== undefined &&
    (xAxisMax - xAxisMin) % timeStepMs === 0;
  // Held in a ref so the handler stays current without being a dependency —
  // otherwise a fresh `onChange` closure per render would re-run the effect.
  const onBrush = useRef(brush?.onChange);
  onBrush.current = brush?.onChange;

  // Follow the active colour scheme while the page is open, so a chart drawn
  // in light mode is not left with light-mode hues on a dark surface.
  //
  // TWO SOURCES, because `resolveChartMode` reads two: the OS setting, and an
  // explicit `[data-theme]` on `<html>` which overrides it. Watching only
  // `prefers-color-scheme` — which is all this did while no toggle existed —
  // means choosing Dark in the account menu repaints the whole app around eight
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

  /**
   * A NATIVE `<dialog>`, DRIVEN BY `showModal()` RATHER THAN BY A CLASS.
   *
   * The alternative — position the card `fixed inset-0` — needs a hand-rolled
   * focus trap, its own Escape handler, and something to make the rest of the
   * page inert, and gets two of those three wrong in most attempts. A modal
   * `<dialog>` has all three in the platform, plus top-layer painting that no
   * `z-index` can be beaten by.
   *
   * `onClose` is what keeps React's state honest: Escape closes the dialog
   * without going through the button, so without this the DOM would be closed
   * while `expanded` stayed true and the canvas stayed in a hidden dialog.
   */
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (expanded && !element.open) element.showModal();
    if (!expanded && element.open) element.close();
  }, [expanded]);

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

    // The slider reports its range on every frame of a drag. Reported here as
    // it happens; the CALLER decides when a drag has settled, because only the
    // caller knows what the range costs — for `TimeBrush` it is a navigation
    // and six refetches.
    if (hasBrush) {
      instance.on('datazoom', () => {
        const [zoom] = instance.getOption().dataZoom as { startValue?: number; endValue?: number }[];
        if (zoom?.startValue === undefined || zoom.endValue === undefined) return;
        onBrush.current?.(Math.round(zoom.startValue), Math.round(zoom.endValue));
      });
    }

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
    // `hasBrush` joins the identity list because the datazoom handler is
    // bound at init; a chart that gained or lost a brush without a rebuild
    // would keep the old subscription.
    //
    // `expanded` joins it for a different reason, and it is the one that bites
    // if forgotten: expanding moves the canvas into the `<dialog>`, which
    // REMOUNTS the element. The old instance is bound to a node no longer in
    // the document, so it has to be disposed and rebuilt on the new one — a
    // genuine change of existence, which is exactly what this effect's own
    // comment above says earns a rebuild.
  }, [isEmpty, group, hasBrush, expanded]);

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
      name: drawnXAxisName,
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
     * One clock for the ticks and the pointer: elapsed `HH:MM:SS`, or the
     * reader's wall clock when the time mode and the run's anchor allow it.
     */
    const timeLabel = (value: number): string =>
      wallAnchorMs === null ? formatElapsedClock(value) : formatClockTime(wallAnchorMs + value);

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
      name: drawnXAxisName,
      nameLocation: 'middle' as const,
      nameGap: 28,
      nameTextStyle: axisText,
      // THE ONLY AXIS HERE WHOSE TICK COUNT THE RENDERER CHOOSES, and its
      // labels are the widest: elapsed milliseconds print as `10,000`…
      // `60,000`, and at a phone's width ECharts lays out more of them than
      // fit — `10,00020,00030,000`, run together. Dropping the ones that
      // collide is a measurement only the renderer can make.
      axisLabel: {
        ...axisText,
        hideOverlap: true,
        // Milliseconds on the axis, clock time on the label: see
        // `ChartXAxis` and `timeLabel` above.
        ...(xAxisTickUnit === 'ms-as-s' ? { formatter: timeLabel } : {}),
        // The end is labelled only when it is a grid tick: see
        // `timeAxisEndOnGrid`.
        ...(timeStepMs !== null && !timeAxisEndOnGrid ? { showMaxLabel: false } : {}),
      },
      // NEVER FINER THAN A SECOND on an elapsed axis. The zoom buttons can
      // narrow a window to one bucket, and ECharts would then tick it every
      // 200 ms: five labels reading the same HH:MM:SS.
      ...(xAxisTickUnit === 'ms-as-s' ? { minInterval: 1000 } : {}),
      // A CLOCK'S STEP, not ECharts' decimal one: see `timeTicks.ts`.
      // `minInterval` above stays as the floor when there is no span to
      // measure.
      ...(timeStepMs === null ? {} : { interval: timeStepMs }),
      axisLine: { lineStyle: { color: theme.gridline } },
      splitLine: { show: false },
      // THE POINTER'S LABEL IS THE TOOLTIP'S TITLE, so it has to speak the same
      // units as the ticks under it. Without this the percentile chart's ticks
      // read 0..100 in seconds while the tooltip above them announced
      // "49,000.00" — the raw millisecond value, to two decimals, for an axis
      // labelled as clock time.
      ...(xAxisTickUnit === 'ms-as-s'
        ? {
            axisPointer: {
              label: {
                formatter: (params: { value: number | string }) => timeLabel(Number(params.value)),
              },
            },
          }
        : {}),
      // Absent unless the caller pinned one — see `ChartXAxis.min`. `undefined`
      // is ECharts' own "auto", so an unpinned axis behaves exactly as before.
      min: xAxisMin,
      max: xAxisMax,
    };

    /**
     * A SPARKLINE HAS NO FURNITURE. Ticks, axis lines, gridlines and the axis
     * name are all suppressed rather than shrunk: at 96px tall they would take
     * more room than the line, and the stat tile beside the sparkline already
     * carries the value they would be labelling.
     */
    const bare = {
      name: undefined,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    };
    const catAxis = compact ? { ...categoryAxis, ...bare } : categoryAxis;
    /**
     * ═══ A NAVIGATOR'S VALUE AXIS IS A SENSE OF SCALE, NOT A READING ═══
     *
     * ECharts' default `splitNumber` is 5, which asks for six labels. In a
     * navigator's plot that is tens of pixels tall they cannot all fit, and
     * ECharts draws them anyway: measured at 4-5px apart with a 14px line
     * height, so six numbers overprinted each other and none was legible.
     *
     * Two splits is three labels — floor, middle, ceiling — which is what this
     * axis is for: the reader is DRAGGING a time range, and the y values tell
     * them the shape of what they are selecting rather than a number they will
     * quote. The full treatment stays on every analytical chart.
     */
    /**
     * WHETHER A LEGEND IS DRAWN — asked once, because two places need the
     * answer and they used to compute it separately. The `grid.bottom` that
     * has to CLEAR the legend tested only the series count, so a navigator
     * (which is never given one) reserved its band regardless. See the note on
     * `grid.bottom` for what that cost.
     *
     * One series is named by the title, and a one-entry legend is a label
     * pretending to be a control — which is why the floor is two.
     */
    const showLegend = !compact && !navigator && drawn.length >= 2;

    const valAxis = compact
      ? { ...valueAxis, ...bare }
      : navigator
        ? { ...valueAxis, splitNumber: 2 }
        : valueAxis;
    const numAxis = compact ? { ...numericAxis, ...bare } : numericAxis;

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
        // ONLY when asked for. Absent entirely otherwise, so the eight charts
        // that pass no `brush` emit no dataZoom key at all.
        ...(hasBrush
          ? {
              dataZoom: [
                {
                  type: 'slider',
                  // The range is in the x-axis' own units, not percentages:
                  // this axis is elapsed milliseconds and the caller writes
                  // milliseconds to the URL, so a percentage would need the
                  // extent to convert and would drift as the extent changed.
                  startValue: brushFrom ?? undefined,
                  endValue: brushTo ?? undefined,
                  height: BRUSH_HEIGHT,
                  bottom: BRUSH_INSET,
                  borderColor: theme.gridline,
                  fillerColor: 'transparent',
                  handleStyle: { color: theme.ink },
                  textStyle: { color: theme.inkMuted },
                  // THE HANDLES SPEAK THE AXIS' CLOCK. Unformatted, ECharts
                  // prints the raw value, so the navigator's handles read
                  // `20412` over ticks reading `00:00:20`.
                  ...(xAxisTickUnit === 'ms-as-s' ? { labelFormatter: timeLabel } : {}),
                  // The slider is the control; wheel-zooming the plot above it
                  // would give the same window two gestures that disagree.
                  zoomLock: false,
                },
              ],
            }
          : {}),
        legend:
          // A navigator drops the legend for the room, and can: its series are
          // the same All/OK/KO the chart directly below it labels.
          showLegend
            ? {
                // Under the plot, and above the slider when there is one, so
                // the three never share a band. See `LEGEND_BAND`.
                bottom: (hasBrush ? BRUSH_BAND : 0) + LEGEND_GAP,
                height: LEGEND_HEIGHT,
                type: 'scroll',
                textStyle: { color: theme.ink },
                // The pager only appears when the row overflows, but when it
                // does it must not arrive in ECharts' default near-black on a
                // dark card.
                pageTextStyle: { color: theme.inkMuted },
                pageIconColor: theme.inkMuted,
                pageIconInactiveColor: theme.gridline,
                icon: 'roundRect',
              }
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
          formatter: (params: unknown) => tooltipFormatter(params, unit, pairValue),
          // The crosshair `connect` propagates between grouped charts.
          axisPointer: { type: 'line', lineStyle: { color: theme.inkMuted } },
        },
        ...(kind === 'pie'
          ? {}
          : {
              grid: compact
                ? // Every gutter the labels needed, given back to the line.
                  { top: 4, left: 4, right: 4, bottom: 4 }
                : {
                // The legend no longer sits above the plot, so the only thing
                // this band still has to clear is the value axis' own name —
                // which is exactly what it was competing with. See
                // `LEGEND_BAND`. A navigator names no value axis, so it has
                // nothing up here to clear and gives the room to the plot.
                top: navigator ? 4 : 12,
                // A horizontal chart's category labels sit in the left gutter
                // and are words, not axis ticks, so they need the room.
                left: horizontal ? 104 : 56,
                right: 16,
                // A named category axis needs the room its name is drawn in,
                // PLUS the slider's own footprint when there is one. The
                // slider is laid out from the bottom of the container
                // (`bottom` + `height` below) and the axis name is drawn
                // `nameGap` under the axis line at `grid.bottom`; without this
                // term the two share a band, and "Elapsed (ms)" was drawn
                // across the middle of the scrubber on every run page.
                // `showLegend`, NOT `drawn.length >= 2` (review 09-13 C02).
                // These two expressions decided the same thing and disagreed:
                // the legend is withheld from a NAVIGATOR, and this reserved
                // its band anyway. Measured at 1440x900 on the run page's time
                // selector — a 160px canvas whose plot was 34px, with seven
                // y-axis tick labels 14px tall drawn 4-5px apart, i.e. a
                // smear. One name now, read by both.
                bottom:
                  (drawnXAxisName === undefined ? 32 : 56) +
                  (hasBrush ? BRUSH_BAND : 0) +
                  (showLegend ? LEGEND_BAND : 0),
              },
              ...(horizontal
                ? { xAxis: valAxis, yAxis: catAxis }
                : { xAxis: xAxisNumeric ? numAxis : catAxis, yAxis: valAxis }),
            }),
        // `index`, NOT the position in `drawn`. The two agree only while the
        // drawn set is a prefix of the series list, and an `essential` series
        // kept over an earlier one breaks that — pairing by position would then
        // draw each colour against the next series' numbers.
        series: drawn.map(({ name, index }, position) => {
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
            /**
             * AC-STAT-4's demarcation, on the FIRST drawn series only.
             *
             * A `markArea` belongs to a series, so attaching it to each would
             * stack N translucent bands and darken the ramp in proportion to
             * how many percentiles happen to be selected — the shading would
             * change when the reader toggled a legend entry, which is a
             * property of the legend and not of the run.
             *
             * `position`, NOT `index`: `index` is the position in the whole
             * series list and `drawn` may start past it once a band is
             * deselected, so keying on `index === 0` would drop the shading
             * exactly when the first series is hidden. The same distinction
             * the palette assignment above this makes, for the same reason.
             *
             * `silent` so it never takes a tooltip or a click — it is a
             * backdrop, and an axis-pointer readout of "warm-up" where a
             * measurement belongs would be worse than no marker.
             */
            markArea:
              position === 0 && warmupBandMs !== null
                ? {
                    silent: true,
                    itemStyle: { color: theme.gridline, opacity: 0.55 },
                    label: {
                      show: !compact,
                      position: 'insideTop' as const,
                      color: theme.inkMuted,
                      fontSize: 10,
                      formatter: 'warm-up',
                    },
                    data: [[{ xAxis: 0 }, { xAxis: warmupBandMs }]],
                  }
                : undefined,
          };
        }),
      },
      // notMerge. Task 8's band selector removes series, and a merging
      // setOption keeps the ones it was not told about — so deselecting p99
      // would leave p99 on the chart.
      true,
    );
    // `yAxis` and `xAxis` are spread into PRIMITIVES above (`yAxisType`,
    // `yAxisName`, `drawnXAxisName`) rather than listed here as objects: they
    // are compared by identity, and the documented call site
    // `<Chart yAxis={{ type: 'log' }} …/>` builds a new one every render.
  }, [
    data,
    kind,
    stacked,
    horizontal,
    roles,
    unit,
    pairValue,
    compact,
    navigator,
    yAxisType,
    yAxisName,
    drawnXAxisName,
    wallAnchorMs,
    timeStepMs,
    timeAxisEndOnGrid,
    xAxisNumeric,
    xAxisTickUnit,
    xAxisMin,
    xAxisMax,
    warmupBandMs,
    mode,
    assignment,
    hasBrush,
    brushFrom,
    brushTo,
    // NOT because the option depends on it — it does not — but because the
    // effect above rebuilds the instance when it changes, and a fresh instance
    // has no option on it. Effects run in declaration order, so listing it
    // here is what makes the rebuilt chart draw instead of coming up blank.
    //
    // Verified red: removing this line leaves the full-screen dialog with an
    // ECharts SVG root and no marks in it, which `run-charts.spec.ts`'s
    // "a chart can fill the screen" case catches on its `path` assertion.
    expanded,
  ]);

  /**
   * ═══ THE PLOTTING SURFACE, AND THE ONLY THING IN THIS CARD THAT MAY
   *     CONTAIN AN <svg> ECharts DREW ═══
   *
   * `data-chart-canvas` exists so a test can say "the chart drew" without
   * saying "this figure contains exactly one SVG". Those were the same
   * sentence while the figure held nothing else that could carry one, and the
   * e2e suite wrote the second — `getByTestId('chart-x').locator('svg')` with
   * `toHaveCount(1)`, in twenty-odd places. CLAUDE.md recorded the consequence
   * as a prohibition on icons anywhere in a chart card, which held the line
   * but also froze the design: no icon control could ever live in a header.
   * Scoping the assertion here says what was always meant, and is stronger —
   * an icon elsewhere in the card can no longer answer it.
   *
   * ONE ELEMENT, TWO POSSIBLE PARENTS. It renders inside the card normally and
   * inside the full-screen `<dialog>` when expanded; only ever one at a time,
   * so `container.current` is unambiguous. Moving between parents remounts the
   * node, which is why `expanded` is in BOTH echarts effects' dependencies —
   * the instance has to be rebuilt on the new element, and the option set on
   * the instance that replaced it.
   */
  const canvas = (
    <div
      ref={container}
      data-chart-canvas=""
      // The data table is the accessible route to these values (design §7).
      // Exposing the SVG's own text nodes as well would make a screen reader
      // read axis ticks and legend fragments in visual order, which is noise
      // on top of a complete alternative.
      aria-hidden="true"
      className={
        expanded
          ? 'min-h-0 w-full flex-1'
          : compact
            ? 'h-24 w-full'
            : navigator
              ? 'h-40 w-full'
              : 'h-72 w-full'
      }
    />
  );

  return (
    <Card as="figure" data-testid={`chart-${id}`}>
      {/* The title and the card's own actions share a row. `items-start` and
          not `items-center`, because a title that wraps to two lines on a
          narrow column must not drag the button row down with it — the
          controls stay aligned to the first line, where the eye expects a
          header's actions to be. */}
      <div className="flex items-start justify-between gap-3">
        {/* `Chart`'s own `<h3>`, not `Card`'s `title` prop — which is exactly
            why that prop is optional (see `Card`'s docstring): a card that
            always drew a heading would give every figure two, and the figure's
            accessible name would become whichever won. */}
        <h3 className="min-w-0 text-[0.9375rem] font-semibold tracking-tight text-primary">{title}</h3>

        <ChartActions
          id={id}
          title={title}
          columns={data.columns}
          rows={data.rows}
          tableShown={tableShown}
          onToggleTable={() => setTableShown((was) => !was)}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((was) => !was)}
          expandable={!isEmpty}
        />
      </div>

      {/* Between the name of the figure and the figure itself, which is the
          only place a control bar reads as belonging to this chart and not to
          its neighbour. Rendered even when there is nothing to draw: a reader
          who has filtered a chart down to nothing needs the control that got
          them there in order to get back. */}
      {controls}

      {/* ONE THING, TWO VIEWS. `hidden` rather than unmounting: the canvas
          holds a live ECharts instance that would be disposed and rebuilt on
          every toggle, and the table is the parity and accessibility surface
          that has to stay in the DOM whatever is on screen (see `DataTable`).
          So both are always mounted and exactly one is displayed.

          A `display: none` canvas reports a 0×0 box, which the instance's own
          ResizeObserver sees; on the way back it fires again with the real
          size and the chart re-lays out. That is why this can be a plain
          attribute toggle and needs no resize call of its own. */}
      <div hidden={tableShown}>
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
          className="flex h-72 items-center justify-center rounded-lg bg-sunken px-6 text-center text-[0.8125rem] text-muted"
        >
          {data.empty}
        </p>
      ) : expanded ? (
        // The canvas has moved into the dialog below. This keeps the space it
        // left, so closing the dialog does not drop the page's scroll position
        // by the height of a chart.
        <div
          aria-hidden="true"
          className={compact ? 'h-24 w-full' : navigator ? 'h-40 w-full' : 'h-72 w-full'}
        />
      ) : (
        canvas
      )}
      </div>

      {/* Anything the chart is not showing, in prose. Both the transform's own
          limitation (truncated bins, a split the run predates) and the
          palette's (a seventh series that would have had to reuse a hue).

          Set apart with a rule and a smaller size rather than left as another
          paragraph: these are caveats ABOUT the figure, and a reader
          skimming eight charts has to be able to tell them from the figure's
          own description at a glance. */}
      {(data.limitation !== undefined || assignment.limitation !== undefined) && (
        <div className="flex flex-col gap-1 border-t border-divider pt-3 text-[0.75rem] leading-relaxed text-muted">
          {data.limitation !== undefined && <p>{data.limitation}</p>}
          {assignment.limitation !== undefined && <p>{assignment.limitation}</p>}
        </div>
      )}

      <DataTable
        id={id}
        caption={title}
        columns={data.columns}
        rows={data.rows}
        shown={tableShown}
      />

      {/* THE FULL-SCREEN VIEW.

          A child of the figure in the DOM, which matters for two reasons that
          are easy to miss. A modal `<dialog>` paints in the TOP LAYER, so its
          position in the tree costs it nothing visually — but it keeps every
          figure-scoped query (`getByTestId('chart-x')`, and `plot()` through
          it) finding the canvas wherever the canvas currently lives.

          `aria-label` rather than a heading inside it: a chart card must not
          contribute an `<h2>`, because `run-tables.spec.ts` pins each tab's
          heading outline exactly and this component renders on all of them.
          The visible title below is a `<p>` for the same reason.

          The content is mounted only while open. A closed `<dialog>` is
          `display: none`, so its contents would be an invisible second copy of
          the title in the accessible tree for no benefit — and, more to the
          point, the canvas has to be in exactly one place at a time.

          `controls` are deliberately NOT repeated here. They are a `ReactNode`
          the caller built, and rendering the same node twice would put two
          copies of every `data-testid` in the document. The cost is that the
          percentile chart's scale toggle is unreachable while expanded; the
          fix is to close it, which is one keystroke. */}
      <dialog
        ref={dialog}
        aria-label={`${title} — full screen`}
        onClose={() => setExpanded(false)}
        // `m-auto` IS LOAD-BEARING, and its absence is invisible in every
        // test. A modal `<dialog>` centres itself in the viewport with the UA
        // stylesheet's `margin: auto`; Tailwind's preflight resets `margin: 0`
        // on every element, which silently defeats that and pins the dialog to
        // the top-left corner. Measured before the fix: a 1325×810 box at
        // (0, 0) in a 1440×900 viewport.
        className="m-auto h-[90dvh] w-[92vw] max-w-none rounded-xl border border-default bg-surface p-0 text-primary backdrop:bg-black/60"
      >
        {expanded && (
          <div className="flex h-full w-full flex-col gap-3 p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-[0.9375rem] font-semibold tracking-tight text-primary">
                {title}
              </p>
              {/* A real labelled control, not only Escape. Escape is the
                  keyboard route and the platform gives it for free; a pointer
                  user needs something to aim at, and "click the backdrop" is
                  not discoverable. */}
              <button
                type="button"
                aria-label="Exit full screen"
                title="Exit full screen"
                onClick={() => setExpanded(false)}
                className="transition-ui flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary"
              >
                <CollapseIcon className="h-4 w-4" />
              </button>
            </div>
            {canvas}
          </div>
        )}
      </dialog>
    </Card>
  );
}
