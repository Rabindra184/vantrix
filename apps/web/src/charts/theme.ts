/**
 * The chart theme: the categorical palette, and the ink/grid colours read off
 * the design tokens.
 *
 * Two responsibilities that belong together because they answer one question —
 * "what colour is this?" — and must never be answered twice with different
 * values.
 */

export type ChartMode = 'light' | 'dark';

/**
 * The categorical series palette for LIGHT mode: **Okabe–Ito**, verbatim.
 *
 * Source: Masataka Okabe and Kei Ito, "Color Universal Design (CUD): How to
 * make figures and presentations that are friendly to colorblind people"
 * (https://jfly.uni-koeln.de/color/), the standard colour-universal set.
 *
 * WHY A PUBLISHED PALETTE, AND WHAT THAT BUYS: colour-vision-deficiency
 * separation is the one property of a palette this repo does NOT compute.
 * Simulating protanopia/deuteranopia/tritanopia requires transcribed matrices,
 * and a matrix transcribed slightly wrong yields a test that passes while
 * certifying nothing. So the CVD property is INHERITED from a palette
 * published as colour-vision-safe rather than asserted by us. Everything that
 * IS computable — lightness band, chroma floor, adjacent-pair separation — is
 * computed, in `apps/web/test/palette.test.ts`, in both modes.
 *
 * Do not reorder these. The order is the assignment order (see
 * `assignPalette`), so reordering silently recolours every existing chart.
 */
export const CATEGORICAL = [
  '#0072B2', // blue
  '#E69F00', // orange
  '#009E73', // bluish green
  '#CC79A7', // reddish purple
  '#56B4E9', // sky blue
  '#D55E00', // vermillion
] as const;

/**
 * The same six hues, tuned for a DARK surface.
 *
 * Okabe–Ito as published does not satisfy the dark-mode lightness band
 * (0.48–0.67 in OKLCH L): `#E69F00` sits at L 0.753, `#56B4E9` at 0.735 and
 * `#CC79A7` at 0.679, all above the ceiling, where they glare against a dark
 * surface. This set is derived from the published one by a single, mechanical
 * rule — clamp OKLCH L into the band, hold the hue angle, reduce chroma only
 * as far as the sRGB gamut forces — so the three in-band hues (`#0072B2`,
 * `#009E73`, `#D55E00`) are byte-identical to Okabe–Ito and the other three
 * keep their hue and their identity across a theme switch.
 *
 * The honest caveat, recorded rather than buried: the CVD property of THIS set
 * is inherited by hue from Okabe–Ito, not re-derived. Compressing lightness
 * also compresses separation — orange and vermillion, Okabe–Ito's closest
 * pair, fall from ΔE 15.6 to 9.1 here. They are not adjacent in assignment
 * order (slots 2 and 6), so no chart with fewer than six series shows both,
 * and the adjacent-pair gate `palette.test.ts` enforces still passes at 19.1.
 */
export const CATEGORICAL_DARK = [
  '#0072B2', // blue        — unchanged from Okabe–Ito
  '#C08400', // orange      — L clamped from 0.753
  '#009E73', // bluish green — unchanged
  '#C573A0', // reddish purple — L clamped from 0.679
  '#3B9CD0', // sky blue    — L clamped from 0.735
  '#D55E00', // vermillion  — unchanged
] as const;

export function paletteFor(mode: ChartMode): readonly string[] {
  return mode === 'dark' ? CATEGORICAL_DARK : CATEGORICAL;
}

/* -------------------------------------------------------------------- *
 * SEMANTIC colours — for marks that MEAN something, rather than marks that
 * merely differ from each other
 * -------------------------------------------------------------------- */

/**
 * WHY ANY OF THIS EXISTS ALONGSIDE `CATEGORICAL`. The categorical palette
 * answers "which series is this?" — its hues are interchangeable, and
 * Okabe–Ito's whole point is that they carry no meaning beyond "not the other
 * one". The indicator bands ③ and the OK/KO donut ④ ask a different question: a
 * request that failed is not merely a different series from one that
 * succeeded, it is WORSE, and the reader has already learned elsewhere on this
 * same page (`routes/marks.tsx`) that failure is `--color-status-failed`.
 * Drawing it in categorical blue because it happened to be the first series
 * would throw that away.
 *
 * There are TWO semantic palettes, and they are not the same kind of thing.
 */

/**
 * App-wide STATES: what the rest of the UI already spends on a status, a
 * verdict or an SLA outcome (`routes/marks.tsx`). Maps one-to-one onto the four
 * `--color-status-*` tokens; `neutral` is `--color-status-not-applicable`.
 */
export type StatusRole = 'passed' | 'pending' | 'neutral' | 'failed';

/**
 * The indicator bands' SEVERITY RAMP — one chart's ordered four-step scale,
 * deliberately NOT the status palette.
 *
 * The first cut of this overloaded the status tokens, which put
 * `--color-status-pending` behind "800–1200 ms" (a stretch: the band is not
 * pending anything) and, with only four status tokens of which just three form
 * a ramp, left the neutral grey on `t >= higherMs` — inverting the ordering,
 * because grey reads as *less* severe than the amber directly beneath it when
 * it is the worst non-failure state.
 *
 * Gatling's own report (`fixtures/gatling-3.15.1.2/reference-report/index.html`)
 * uses a genuine four-step ramp — `#68b65c` green, `#FFDD00` yellow, `#FFA900`
 * orange, `#f15b4f` red — and the monotonic ordering is the information.
 * `--chart-band-*` is that, in this design system's own hues: three of the four
 * are var() aliases of the status tokens so the endpoints keep agreeing with
 * the rest of the app, and only the orange step is new.
 *
 * The ramp's measured properties, and the one gate it does NOT meet, are in
 * `palette.test.ts`.
 */
export type BandRole = 'band-under' | 'band-between' | 'band-over' | 'band-failed';

/** Either semantic palette. What `Chart`'s `roles` prop accepts. */
export type MarkRole = StatusRole | BandRole;

const ROLE_TOKEN: Readonly<Record<MarkRole, string>> = {
  passed: '--color-status-passed',
  pending: '--color-status-pending',
  neutral: '--color-status-not-applicable',
  failed: '--color-status-failed',
  'band-under': '--chart-band-under',
  'band-between': '--chart-band-between',
  'band-over': '--chart-band-over',
  'band-failed': '--chart-band-failed',
};

/**
 * The compiled values of those tokens, per mode.
 *
 * Mirrors `tokens.css` exactly, and `palette.test.ts` fails if the two ever
 * disagree in ANY of the four blocks — the same arrangement, and the same
 * guard, the `--chart-*` palette has. These are the FALLBACKS: `markColor`
 * reads the live document first, so a theme switch is picked up without a
 * rebuild, and these cover the two cases where reading fails honestly (no
 * document at all, and jsdom, which parses no stylesheet).
 *
 * The three aliased band values are written out as the hexes they resolve TO,
 * because a fallback is what is used when no stylesheet exists and there is
 * nothing for a `var()` to resolve against. `palette.test.ts` resolves the
 * indirection when it compares, so the alias cannot drift from its target.
 */
export const STATUS_COLORS: Readonly<Record<ChartMode, Readonly<Record<StatusRole, string>>>> = {
  light: { passed: '#1a7f37', pending: '#9a6700', neutral: '#6e7781', failed: '#cf222e' },
  dark: { passed: '#3fb950', pending: '#d29922', neutral: '#8b949e', failed: '#f85149' },
};

/** In SEVERITY ORDER. Do not reorder: `palette.test.ts` reads the ramp off it. */
export const BAND_COLORS: Readonly<Record<ChartMode, Readonly<Record<BandRole, string>>>> = {
  light: {
    'band-under': '#1a7f37',
    'band-between': '#9a6700',
    'band-over': '#bc4c00',
    'band-failed': '#cf222e',
  },
  dark: {
    'band-under': '#3fb950',
    'band-between': '#d29922',
    'band-over': '#db6d28',
    'band-failed': '#f85149',
  },
};

/** The severity ramp, in order, as a list — `under → between → over → failed`. */
export const BAND_RAMP: readonly BandRole[] = [
  'band-under',
  'band-between',
  'band-over',
  'band-failed',
];

function fallbackFor(role: MarkRole, mode: ChartMode): string {
  return role.startsWith('band-')
    ? BAND_COLORS[mode][role as BandRole]
    : STATUS_COLORS[mode][role as StatusRole];
}

export function markColor(role: MarkRole, mode: ChartMode): string {
  return token(ROLE_TOKEN[role], fallbackFor(role, mode));
}

/**
 * Every semantic colour, read off the live document — the shape `chartTheme`
 * carries and `Chart` indexes with a chart's declared roles.
 */
export function liveMarkColors(mode: ChartMode): Readonly<Record<MarkRole, string>> {
  const entries = (Object.keys(ROLE_TOKEN) as MarkRole[]).map(
    (role) => [role, markColor(role, mode)] as const,
  );
  return Object.fromEntries(entries) as Record<MarkRole, string>;
}

/** How many categorical series can be drawn at once. There is no seventh. */
export const MAX_CATEGORICAL_SERIES = CATEGORICAL.length;

export interface PaletteAssignment {
  /** Series that get a hue, in order, each with a colour no other series has. */
  readonly drawn: readonly { readonly name: string; readonly color: string }[];
  /** Series left unplotted because the palette ran out. Usually empty. */
  readonly undrawn: readonly string[];
  /** Prose for the reader when `undrawn` is non-empty. */
  readonly limitation?: string;
}

/**
 * Assigns hues to series, in FIXED ORDER, and never cycles.
 *
 * The palette has six hues and this sub-project draws eight charts. Nothing in
 * it needs more than six series today, but `toConcurrentUsers` (Task 6) draws
 * one series per scenario PLUS the total, so a run with six scenarios already
 * exceeds the palette. The default behaviour of every charting library is to
 * wrap around — a seventh series would come back as `#0072B2` — and nothing
 * about the rendered chart would say so. The reader would simply be wrong
 * about which line is which, with no signal that anything had happened.
 *
 * So this makes it a loud, handled case: the first six get the six hues, and
 * anything past that is NOT PLOTTED and is named in prose. The values are not
 * lost — the data table carries every series regardless, and the table is the
 * parity surface (design §7) — so the honest trade is "you can read it, you
 * cannot see it", never "two of these lines are the same colour".
 *
 * Folding the excess into a summed "Other" series was the alternative and is
 * rejected here: `Chart` is a primitive shared by a donut, a distribution and
 * four time series, and summing is meaningful for counts and nonsense for
 * percentiles. A primitive that aggregated would produce a plausible,
 * wholly-wrong curve on the charts where summing does not apply.
 */
export function assignPalette(names: readonly string[], mode: ChartMode): PaletteAssignment {
  // `livePalette`, NOT `paletteFor`: the assigned colours are what `Chart`
  // hands to ECharts, so this is the one path a `--chart-*` token has to
  // travel to reach a rendered mark. Reading the compiled constants here
  // instead would leave the tokens decorative — which is exactly what they
  // were until this call changed.
  const palette = livePalette(mode);
  const drawn = names
    .slice(0, MAX_CATEGORICAL_SERIES)
    .map((name, i) => ({ name, color: palette[i]! }));
  const undrawn = names.slice(MAX_CATEGORICAL_SERIES);

  if (undrawn.length === 0) return { drawn, undrawn };

  return {
    drawn,
    undrawn,
    limitation:
      `Showing the first ${MAX_CATEGORICAL_SERIES} of ${names.length} series. ` +
      `${undrawn.join(', ')} ${undrawn.length === 1 ? 'is' : 'are'} not drawn, because ` +
      'reusing a colour would make two series indistinguishable. Every series is in the data table.',
  };
}

/**
 * One design token, read off the live document.
 *
 * `tokens.css` is the runtime source of truth — it is what a theme switch
 * changes — so the theme reads from it rather than hard-coding. `fallback`
 * covers the two cases where reading fails honestly: server/unit rendering
 * with no document at all, and jsdom, which parses no stylesheet and returns
 * '' for every custom property.
 */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * The hairline gridline colour, per mode.
 *
 * Exported so `palette.test.ts` can pin it against all four blocks of
 * `tokens.css` rather than only against the two `[data-theme]` ones. A typo in
 * the `prefers-color-scheme` block would otherwise ship a gridline that
 * competes with the data on every dark-mode machine, be read live by
 * `chartTheme`, rendered faithfully, and go unnoticed.
 */
export const GRIDLINE: Readonly<Record<ChartMode, string>> = {
  light: '#e9ecf0',
  dark: '#262c33',
};

/**
 * The categorical palette as the DOCUMENT currently defines it.
 *
 * `paletteFor` is the compiled constant and the source of truth for the
 * checks; this is what actually gets drawn. The two agree unless someone edits
 * `tokens.css` alone, which `palette.test.ts` fails on.
 *
 * Falls back per-index rather than wholesale, so a stylesheet defining only
 * some of the six still yields six colours.
 */
export function livePalette(mode: ChartMode): readonly string[] {
  return paletteFor(mode).map((fallback, i) => token(`--chart-${i + 1}`, fallback));
}

/**
 * Which theme the document is currently in.
 *
 * `[data-theme]` first and `prefers-color-scheme` second, mirroring the
 * cascade `tokens.css` sets up — an explicit override must win over the OS
 * setting in both directions.
 */
export function resolveChartMode(): ChartMode {
  if (typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export interface ChartTheme {
  /**
   * The two SEMANTIC palettes, by role — for the charts whose marks mean
   * something. See `MarkRole`.
   */
  readonly roles: Readonly<Record<MarkRole, string>>;
  readonly ink: string;
  readonly inkMuted: string;
  readonly gridline: string;
  readonly surface: string;
}

/**
 * Every colour a chart uses that is NOT a categorical series colour, read off
 * the live document.
 *
 * WHERE SERIES COLOUR ACTUALLY COMES FROM, because this docstring got it wrong
 * once and a comment that misdescribes the mechanism is worse than none: it
 * does NOT come from here. `Chart` calls `assignPalette`, which calls
 * `livePalette` itself, and hands the result straight to ECharts. That is a
 * parallel path which bypasses `chartTheme` entirely — deliberately, because
 * assignment has to decide what to do with a seventh series and a plain list of
 * six hues cannot. `chartTheme` used to also return a `palette` field
 * mirroring it; nothing ever read that field, so it is gone. Editing
 * `--chart-4` and looking for it here is looking down the wrong path.
 *
 * What IS here, and every field is read by `Chart.tsx`:
 *
 *   - `roles` — the status and band palettes, consumed only by the charts that
 *     declare `roles` on `<Chart/>`: the indicator bands ③ and the
 *     request-count donut ④.
 *   - `ink` / `inkMuted` — all text. Design §11 is explicit that values, labels
 *     and legend text wear ink tokens and NEVER a mark colour; a legend label
 *     painted in its series' colour is the most common way a chart quietly
 *     fails contrast, because the palettes are tuned for marks on a surface,
 *     not for 12px type.
 *   - `gridline` — the hairline splitLines.
 *   - `surface` — the tooltip's background. Without it the tooltip renders
 *     ECharts' default near-white panel over a dark page.
 */
export function chartTheme(mode: ChartMode): ChartTheme {
  const dark = mode === 'dark';
  return {
    roles: liveMarkColors(mode),
    ink: token('--color-text-primary', dark ? '#f4f5f7' : '#14171a'),
    inkMuted: token('--color-text-muted', dark ? '#9aa4b2' : '#5b6470'),
    gridline: token('--chart-gridline', GRIDLINE[mode]),
    surface: token('--color-surface', dark ? '#14171a' : '#ffffff'),
  };
}
