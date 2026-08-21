import type { SVGProps } from 'react';
import {
  Activity,
  Box,
  ChartSpline,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Gauge,
  Inbox,
  Layers,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Server,
  Square,
  Sun,
  TrendingUp,
  TriangleAlert,
  Upload,
  type LucideIcon,
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

/** Every run in the organisation — a stack of rows. */
export const LayersIcon = icon(Layers);

/** One project. */
export const CubeIcon = icon(Box);

export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);

/** "Follow the operating system" — a display, not a third colour. */
export const MonitorIcon = icon(Monitor);

export const SignOutIcon = icon(LogOut);
export const ChevronRightIcon = icon(ChevronRight);
export const ChevronLeftIcon = icon(ChevronLeft);

/** A retry / re-check action. */
export const RefreshIcon = icon(RefreshCw);

export const PlayIcon = icon(Play);
export const StopIcon = icon(Square);
export const UploadIcon = icon(Upload);

/** Something the reader has to act on: a failed fetch, a failed sign-out. */
export const AlertIcon = icon(TriangleAlert);

/** An empty result — a container with nothing in it. */
export const InboxIcon = icon(Inbox);

/** An action in flight — pair with `animate-spin` and `aria-busy`. */
export const SpinnerIcon = icon(LoaderCircle);

/* The run page's five tabs, in tab order (`routes/RunTabs.tsx`). Decorative
 * like everything else here: the tab's accessible name stays its text. */
export const OverviewTabIcon = icon(Gauge);
export const ChartsTabIcon = icon(ChartSpline);
export const TelemetryTabIcon = icon(Server);
export const ErrorsTabIcon = icon(CircleAlert);
export const TrendsTabIcon = icon(TrendingUp);

/* The project rail's desktop collapse control (`ProjectRail.tsx`). */
export const PanelCollapseIcon = icon(PanelLeftClose);
export const PanelExpandIcon = icon(PanelLeftOpen);
