import type { SVGProps } from 'react';

/**
 * The app's icons, as inline SVG.
 *
 * HAND-ROLLED RATHER THAN A DEPENDENCY, for two reasons that are specific to
 * this repo rather than general distaste for libraries. The set is nine
 * glyphs; an icon package is several hundred, and the ones here are drawn on
 * the same 24-unit grid at the same 1.5 stroke so they cannot drift in weight
 * the way a mixed set does. And every icon in this app is decorative — the
 * control it sits in always carries its own text or `aria-label`, which is
 * what `aria-hidden` below encodes — so none of them is worth a package.
 *
 * NEVER AN EMOJI. An emoji is a font-dependent colour bitmap: it ignores
 * `currentColor`, renders differently on every platform, and cannot follow the
 * theme. Everything here is a stroked path in `currentColor`, so an icon is
 * whatever colour its container's text is, in both themes, for free.
 *
 * `routes/marks.tsx`'s status glyphs (`✓ ✕ ○ ●`) are NOT icons and do not
 * belong here. Those are geometric characters carrying meaning as the SHAPE
 * half of the text+shape+colour rule that file documents, they are asserted
 * for uniqueness in `test/marks.test.ts`, and they must stay text so they
 * survive a forced-colours theme and a monochrome print-out.
 *
 * `aria-hidden` is on the shared props, not per call site, because the
 * alternative failed silently: an icon inside a `<button>` with a visible
 * label contributes its own name to that button unless hidden, and nothing in
 * jsdom would ever have caught it (CLAUDE.md's note about accessible-name
 * defects being invisible to `dom-accessibility-api`).
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** The brand mark: an activity trace, which is what this product draws. */
export function ActivityIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  );
}

/** Every run in the organisation — a stack of rows. */
export function LayersIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </svg>
  );
}

/** One project. */
export function CubeIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z" />
      <path d="M3.5 7 12 11.75 20.5 7" />
      <path d="M12 21.5v-9.75" />
    </svg>
  );
}

export function SearchIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

export function SunIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

/** "Follow the operating system" — a display, not a third colour. */
export function MonitorIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}

export function SignOutIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M9.5 20.5H5.5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4" />
      <path d="m16 16.5 4.5-4.5L16 7.5" />
      <path d="M20.5 12H9.5" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </svg>
  );
}

export function ChevronLeftIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}

/** A retry / re-check action. */
export function RefreshIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5h-5" />
    </svg>
  );
}

/** Something the reader has to act on: a failed fetch, a failed sign-out. */
export function AlertIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M12 3.5 21.5 20H2.5L12 3.5Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </svg>
  );
}

/** An empty result — a container with nothing in it. */
export function InboxIcon({ className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg {...base} className={className} {...props}>
      <path d="M3 13.5h5l1.5 3h5l1.5-3h5" />
      <path d="M5.2 4.5h13.6a2 2 0 0 1 1.9 1.35l2.3 6.6v5.05a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V12.45l2.3-6.6A2 2 0 0 1 5.2 4.5Z" />
    </svg>
  );
}
