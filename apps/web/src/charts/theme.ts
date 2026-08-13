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
  readonly palette: readonly string[];
  readonly ink: string;
  readonly inkMuted: string;
  readonly gridline: string;
  readonly surface: string;
}

/**
 * Every colour a chart uses, read off the live document.
 *
 * Series colour comes from `palette`; EVERYTHING ELSE comes from the ink
 * tokens. Design §11 is explicit that values, labels and legend text wear ink
 * tokens and never the series colour — a legend label painted in its series'
 * colour is the most common way a chart quietly fails contrast, because the
 * palette is tuned for marks on a surface, not for 12px text.
 *
 * Every field here is CONSUMED by `Chart.tsx`. That is worth stating because
 * it was briefly untrue: `palette` and `surface` were computed and then
 * ignored, so `--chart-1…--chart-6` reached no rendered mark while this
 * docstring claimed a theme switch was picked up. `palette` now flows through
 * `assignPalette` into the series colours, and `surface` is the tooltip's
 * background — without it the tooltip renders ECharts' default near-white
 * panel over a dark page.
 */
export function chartTheme(mode: ChartMode): ChartTheme {
  const dark = mode === 'dark';
  return {
    palette: livePalette(mode),
    ink: token('--color-text-primary', dark ? '#f4f5f7' : '#14171a'),
    inkMuted: token('--color-text-muted', dark ? '#9aa4b2' : '#5b6470'),
    gridline: token('--chart-gridline', GRIDLINE[mode]),
    surface: token('--color-surface', dark ? '#14171a' : '#ffffff'),
  };
}
