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
 * The categorical series palette. Six hues, fixed assignment order, no
 * seventh — `assignPalette` leaves an excess series undrawn and says so rather
 * than reusing a colour.
 *
 * THIS PALETTE IS NOT COLOUR-VISION-SAFE, AND THAT IS A DECISION, NOT AN
 * OVERSIGHT. It replaced Okabe–Ito, which was chosen precisely because CVD
 * separation is the one property this repo does not compute — simulating
 * protanopia requires transcribed matrices, and one transcribed slightly wrong
 * yields a test that passes while certifying nothing. That property was
 * inherited from a published palette and is now given up, deliberately, for
 * visual coherence with the rest of the design system.
 *
 * What limits the cost: `routes/marks.tsx` renders every status as shape, then
 * word, then colour, and every chart carries a complete data table. So what is
 * lost is telling two SERIES apart, never telling a pass from a failure.
 *
 * Do not reorder. The order is the assignment order, so reordering silently
 * recolours every existing chart.
 */
export const CATEGORICAL = [
  '#4f46e5', // indigo
  '#0d9488', // teal
  '#8b5cf6', // violet
  '#d97706', // amber
  '#0ea5e9', // sky
  '#e11d48', // rose
] as const;

/**
 * The same six hues on a dark ground, derived by the rule this file has always
 * used: hold the hue angle, clamp OKLCH L into the 0.48–0.67 dark band, and
 * reduce chroma only as far as the sRGB gamut forces.
 *
 * The Tailwind-400 values these started from (`#818cf8`, `#2dd4bf`, `#a78bfa`,
 * `#f59e0b`, `#38bdf8`, `#fb7185`) are all ABOVE the band — L 0.68 to 0.79 —
 * and would glare on a dark surface. Measured, not guessed: all six failed.
 */
export const CATEGORICAL_DARK = [
  '#6c71fe', // indigo  — L 0.620
  '#30a79a', // teal    — L 0.661
  '#9469ff', // violet  — L 0.639
  '#d77500', // amber   — L 0.660
  '#059ddf', // sky     — L 0.660
  '#ee2f52', // rose    — L 0.621
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
  /**
   * Series that get a hue, in the order they were handed over, each with a
   * colour no other series has.
   *
   * `index` is the series' position in the INPUT list, and it is what `Chart`
   * pairs a colour back to its data with. It is not always the position in this
   * array: an `essential` series (see below) can be kept while an earlier one
   * is dropped, and reading `data.series[i]` by the position here would then
   * draw the right colour against the wrong numbers.
   */
  readonly drawn: readonly {
    readonly index: number;
    readonly name: string;
    readonly color: string;
  }[];
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
 *
 * `essential` NAMES THE SERIES THAT MUST SURVIVE THE CUT — indices into
 * `names`, and by default there are none, so the six that survive are simply
 * the first six. That default is right when series are peers and wrong when one
 * of them is the summary the rest decompose: `toConcurrentUsers` orders its
 * series `[...scenarios, total]`, so a run with six scenarios would drop the
 * TOTAL while drawing every scenario — losing the one line that answers "how
 * loaded was the system" and keeping six that only answer it together. Marking
 * it essential caps the scenarios instead.
 *
 * This changes WHO spends the six hues, never HOW MANY there are: more
 * essential series than the palette can hold is still capped, and no series is
 * ever drawn in a colour another already has.
 */
export function assignPalette(
  names: readonly string[],
  mode: ChartMode,
  essential: readonly number[] = [],
): PaletteAssignment {
  // `livePalette`, NOT `paletteFor`: the assigned colours are what `Chart`
  // hands to ECharts, so this is the one path a `--chart-*` token has to
  // travel to reach a rendered mark. Reading the compiled constants here
  // instead would leave the tokens decorative — which is exactly what they
  // were until this call changed.
  const palette = livePalette(mode);

  // The protected series first, then the rest in declaration order until the
  // hues run out. `kept.size` is the only budget: an essential index already in
  // the set cannot be spent twice, and the cap applies to both groups alike.
  const kept = new Set<number>();
  for (const index of essential) {
    if (Number.isInteger(index) && index >= 0 && index < names.length) kept.add(index);
    if (kept.size === MAX_CATEGORICAL_SERIES) break;
  }
  for (let i = 0; i < names.length && kept.size < MAX_CATEGORICAL_SERIES; i++) kept.add(i);

  // Back into DECLARATION order before hues are handed out, so the legend and
  // the drawing read in the order the transform built them, and so a chart
  // whose series all fit is coloured exactly as it was before `essential`
  // existed.
  const selected = [...kept].sort((a, b) => a - b);
  const drawn = selected.map((index, slot) => ({
    index,
    name: names[index]!,
    color: palette[slot]!,
  }));
  const undrawn = names.filter((_, i) => !kept.has(i));

  if (undrawn.length === 0) return { drawn, undrawn };

  // "the first N" is a claim about WHICH ones, and it stops being true the
  // moment an essential series is kept over an earlier one. Said accurately in
  // both cases rather than approximately in one.
  const isPrefix = selected.every((index, slot) => index === slot);

  return {
    drawn,
    undrawn,
    limitation:
      `Showing ${isPrefix ? 'the first ' : ''}${drawn.length} of ${names.length} series. ` +
      `${undrawn.join(', ')} ${undrawn.length === 1 ? 'is' : 'are'} not drawn, because ` +
      'reusing a colour would make two series indistinguishable. Every series is in the data table.',
  };
}

/**
 * The SURFACE scale — everything that is not a mark and not a status.
 *
 * Slate rather than a chroma-zero grey, resolving an inconsistency in the
 * reference this was taken from: its CSS surfaces are neutral while its own
 * chart theme uses slate ink and slate gridlines. The charts are most of the
 * page, so the charts win.
 *
 * `page` and `card` are DIFFERENT VALUES on purpose. A card is defined by
 * sitting on a lighter/darker ground than the page; drawn white-on-white it is
 * a wire outline, and twelve of them read as a grid rather than as twelve
 * things.
 */
export type SurfaceRole =
  | 'page' | 'card' | 'sidebar' | 'sunken' | 'border' | 'divider'
  | 'text-primary' | 'text-muted' | 'text-subtle'
  | 'accent' | 'accent-foreground' | 'ring';

export const SURFACE_TOKENS: Readonly<Record<ChartMode, Readonly<Record<SurfaceRole, string>>>> = {
  light: {
    page: '#f8fafc', card: '#ffffff', sidebar: '#ffffff', sunken: '#f1f5f9',
    border: '#e2e8f0', divider: '#f1f5f9',
    'text-primary': '#0f172a', 'text-muted': '#64748b', 'text-subtle': '#94a3b8',
    accent: '#4f46e5', 'accent-foreground': '#ffffff', ring: '#6366f1',
  },
  dark: {
    page: '#0f172a', card: '#1e293b', sidebar: '#0f172a', sunken: '#334155',
    border: '#334155', divider: '#1e293b',
    'text-primary': '#f8fafc', 'text-muted': '#94a3b8', 'text-subtle': '#64748b',
    accent: '#818cf8', 'accent-foreground': '#0f172a', ring: '#818cf8',
  },
};

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
  return {
    roles: liveMarkColors(mode),
    ink: token('--color-text-primary', SURFACE_TOKENS[mode]['text-primary']),
    inkMuted: token('--color-text-muted', SURFACE_TOKENS[mode]['text-muted']),
    gridline: token('--chart-gridline', GRIDLINE[mode]),
    surface: token('--color-surface-card', SURFACE_TOKENS[mode].card),
  };
}
