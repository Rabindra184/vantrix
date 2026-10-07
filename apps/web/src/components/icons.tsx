import type { SVGProps } from 'react';
import {
  Activity,
  Box,
  ChartArea,
  ChartSpline,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  Download,
  FileText,
  Funnel,
  GitCompareArrows,
  House,
  Inbox,
  Info,
  KeyRound,
  Layers,
  LoaderCircle,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Square,
  Sun,
  Table2,
  Terminal,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

/**
 * The app's icons — lucide-react glyphs behind the same names and prop
 * contract the hand-rolled set had. What a call site WRITES is unchanged;
 * what it DRAWS is deliberately not: every glyph now renders at lucide's
 * 2px stroke where the hand-drawn set used 1.5, a single consistent step
 * heavier, chosen because it is the weight the reference design language
 * uses and it survives 14px rendering better on low-DPI screens. If the
 * weight ever needs to come back down, `icon()` below is the one place a
 * `strokeWidth` would go.
 *
 * lucide emits `width="24" height="24"` ATTRIBUTES on the svg, which the
 * old set did not. The `className` default below REPLACES rather than
 * merges — pass a `className` without `h-*`/`w-*` and the icon is a hard
 * 24px box, not an inherited size — so every call site states its size.
 *
 * ONE MODULE, NOT PER-FILE IMPORTS FROM `lucide-react`. The set was nine
 * hand-drawn glyphs precisely so every icon shared one grid and one stroke;
 * lucide gives the same guarantee (24-unit grid, 2px stroke) across a far
 * larger set, but only if every consumer draws from the same place with the
 * same defaults. Importing `lucide-react` directly from a route would bypass
 * the `aria-hidden` default below, which is the part that has already failed
 * silently once — an icon inside a `<button>` with a visible label
 * contributes its own name to that button unless hidden, and nothing in
 * jsdom catches it (CLAUDE.md's note on `dom-accessibility-api`).
 *
 * EVERY ICON HERE IS DECORATIVE. The control it sits in always carries its
 * own text or `aria-label`, which is what the `aria-hidden` default encodes.
 * lucide 1.x happens to add `aria-hidden` itself when no a11y prop is given;
 * it is still passed explicitly here so the contract survives a library
 * upgrade changing that default.
 *
 * NEVER AN EMOJI. An emoji is a font-dependent colour bitmap: it ignores
 * `currentColor`, renders differently on every platform, and cannot follow
 * the theme. Every lucide glyph is a stroked path in `currentColor`, so an
 * icon is whatever colour its container's text is, in both themes, for free.
 *
 * `routes/marks.tsx`'s status glyphs (`✓ ✕ ○ ●`) are NOT icons and do not
 * belong here. Those are geometric characters carrying meaning as the SHAPE
 * half of the text+shape+colour rule that file documents, they are asserted
 * for uniqueness in `test/marks.test.ts`, and they must stay text so they
 * survive a forced-colours theme and a monochrome print-out.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'ref'>;

function icon(Glyph: LucideIcon) {
  return function Icon({ className = 'h-4 w-4', ...props }: IconProps) {
    return <Glyph className={className} aria-hidden="true" focusable="false" {...props} />;
  };
}

/** The brand mark: an activity trace, which is what this product draws. */
export const ActivityIcon = icon(Activity);

/** The portfolio home page — the rail's first row. */
export const HomeIcon = icon(House);

/** Every run in the organisation — a stack of rows. */
export const LayersIcon = icon(Layers);

/** One project. */
export const CubeIcon = icon(Box);

/**
 * A test — the named thing a project runs REPEATEDLY, which is the whole
 * distinction between a test and a run.
 *
 * `Repeat` rather than a flask or a checklist. Those read as "test" in the
 * QA-suite sense, and this product's tests are not pass/fail cases: a test is
 * a simulation you execute again and again to watch a number move, and the
 * repetition is the reason the entity exists at all (see `TRENDS_SQL`, which
 * cohorts on it).
 */
export const TestIcon = icon(Repeat);

export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);

/** "Follow the operating system" — a display, not a third colour. */
export const MonitorIcon = icon(Monitor);

export const SignOutIcon = icon(LogOut);
export const ChevronRightIcon = icon(ChevronRight);
export const ChevronLeftIcon = icon(ChevronLeft);

// The time window: its range menu and Gatling Enterprise's six navigator
// controls.
export const ChevronDownIcon = icon(ChevronDown);
export const FastBackwardIcon = icon(ChevronsLeft);
export const FastForwardIcon = icon(ChevronsRight);
export const ZoomInIcon = icon(ZoomIn);
export const ZoomOutIcon = icon(ZoomOut);

/** A retry / re-check action. */
export const RefreshIcon = icon(RefreshCw);

/** The header's search control — a magnifier, which is what it opens. */
export const SearchIcon = icon(Search);

export const PlayIcon = icon(Play);
export const StopIcon = icon(Square);
export const UploadIcon = icon(Upload);
export const PlusIcon = icon(Plus);
export const TokenIcon = icon(KeyRound);
export const SetupIcon = icon(Settings);
export const CopyIcon = icon(Clipboard);
export const CheckIcon = icon(Check);
export const DownloadIcon = icon(Download);
export const FilterIcon = icon(Funnel);

/* --- A chart card's own view controls (see `charts/ChartActions.tsx`) --- */

/** Swap a plot for the table of the exact numbers behind it. */
export const TableIcon = icon(Table2);
/** Swap that table back for the plot. A different glyph from `ReportTabIcon`'s
 *  area chart, which means "go to the Report" in the tab strip — what this
 *  button means is "show the plot here". */
export const PlotIcon = icon(ChartSpline);
export const ExpandIcon = icon(Maximize2);
export const CollapseIcon = icon(Minimize2);

/** Something the reader has to act on: a failed fetch, a failed sign-out. */
export const AlertIcon = icon(TriangleAlert);

/** An empty result — a container with nothing in it. */
export const InboxIcon = icon(Inbox);

/** A caveat about the thing beside it, opened on request — see `InfoTip`. */
export const InfoIcon = icon(Info);

/** An action in flight — pair with `animate-spin` and `aria-busy`. */
export const SpinnerIcon = icon(LoaderCircle);

/* The run page's sections, in tab order (`routes/RunTabs.tsx`) — Summary and
 * Report, Trends and Compare, and a fifth, Logs, for a run the on-prem runner
 * executed. The first two are Gatling Enterprise's own glyphs for its Summary
 * (`summarize`) and Report (`area_chart`), which lucide spells `FileText` and
 * `ChartArea`. Decorative like everything else here: the tab's accessible name
 * stays its text. */
export const SummaryTabIcon = icon(FileText);
export const ReportTabIcon = icon(ChartArea);
export const TrendsTabIcon = icon(TrendingUp);
export const CompareTabIcon = icon(GitCompareArrows);
export const LogsTabIcon = icon(Terminal);

/* The project rail's desktop collapse control (`ProjectRail.tsx`). */
/* The chart card's overflow menu (`ChartActions.tsx`, review M17). An ellipsis
   because the menu holds several unrelated actions and no one of them names
   the set; the TRIGGER's accessible name carries the chart's title, so ten of
   these in one document are still ten distinguishable controls. */
export const MoreIcon = icon(MoreHorizontal);

export const PanelCollapseIcon = icon(PanelLeftClose);
export const PanelExpandIcon = icon(PanelLeftOpen);
