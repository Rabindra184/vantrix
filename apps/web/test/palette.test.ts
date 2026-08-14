import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BAND_COLORS,
  BAND_RAMP,
  CATEGORICAL,
  CATEGORICAL_DARK,
  GRIDLINE,
  STATUS_COLORS,
  SURFACE_TOKENS,
  assignPalette,
  chartTheme,
  paletteFor,
  type ChartMode,
  type StatusRole,
  type SurfaceRole,
} from '../src/charts/theme.js';

/**
 * The categorical palette, CHECKED rather than eyeballed.
 *
 * The design (§11) says the palette is validated with the `dataviz` skill's
 * `validate_palette.js` before it ships. That script is NOT installed in this
 * environment — the skill's `scripts/` directory does not exist here, which
 * the controller confirmed before Task 4 started. The rule it enforces still
 * stands, so the computable half of it is implemented HERE instead, as a test.
 *
 * That is deliberately stronger than a one-off script run. A script validates
 * once and is then forgotten; this file fails on the day someone edits a hex
 * value in `theme.ts` or in `tokens.css`.
 *
 * Three checks, in BOTH modes:
 *
 *   1. Lightness band — OKLCH L within 0.43–0.77 (light), 0.48–0.67 (dark).
 *      Outside it a series either disappears into the surface or glares.
 *   2. Chroma floor — OKLCH C >= 0.10. Below it a hue reads as grey and stops
 *      carrying identity, so the legend becomes the only way to tell series
 *      apart.
 *   3. Normal-vision separation — Euclidean ΔE in OKLab ×100 between every
 *      ADJACENT pair >= 15. Hues are assigned in fixed order, so adjacent
 *      pairs are the ones a two- or three-series chart actually shows
 *      together. This is the hard gate that stops full-colour readers
 *      confusing neighbours.
 *
 * WHAT IS NOT CHECKED HERE: colour-vision-deficiency separation. Simulating
 * protanopia/deuteranopia/tritanopia needs transcribed matrices, and a matrix
 * transcribed slightly wrong produces a test that PASSES while certifying
 * nothing — which is the exact failure mode this project keeps hitting. The
 * CVD property is instead INHERITED, by using Okabe–Ito, a palette published
 * as colour-vision-safe. See `theme.ts` for the citation. The dark palette is
 * a lightness-adjusted derivative of it and its CVD property is inherited by
 * hue rather than re-derived; that limitation is recorded in the Task 4
 * report rather than papered over here.
 */

/* ------------------------------------------------------------------ *
 * sRGB → OKLab.
 *
 * Björn Ottosson, "A perceptual color space for image processing"
 * (https://bottosson.github.io/posts/oklab/), the `linear_srgb_to_oklab`
 * reference implementation. Fixed, fully specified, and written out ONCE
 * here so the constants are auditable in one place rather than trusted.
 *
 * OKLCH's L is OKLab's L unchanged; C is sqrt(a² + b²).
 * ------------------------------------------------------------------ */

interface OkLab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** sRGB transfer function, inverted: gamma-encoded channel → linear light. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function hexToOkLab(hex: string): OkLab {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = Number.parseInt(match[1], 16);

  const r = srgbToLinear(((n >> 16) & 0xff) / 255);
  const g = srgbToLinear(((n >> 8) & 0xff) / 255);
  const b = srgbToLinear((n & 0xff) / 255);

  // linear sRGB → LMS, then the cube root that makes the space perceptual.
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  // LMS' → OKLab.
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

const chroma = (c: OkLab): number => Math.hypot(c.a, c.b);

/** Euclidean distance in OKLab, ×100 — the scale the thresholds are stated on. */
const deltaE = (x: OkLab, y: OkLab): number => 100 * Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);

/* ------------------------------------------------------------------ */

const CHROMA_FLOOR = 0.1;
const SEPARATION_FLOOR = 15;

const MODES: readonly { mode: ChartMode; palette: readonly string[]; lo: number; hi: number }[] = [
  { mode: 'light', palette: CATEGORICAL, lo: 0.43, hi: 0.77 },
  { mode: 'dark', palette: CATEGORICAL_DARK, lo: 0.48, hi: 0.67 },
];

describe.each(MODES)('the $mode categorical palette', ({ mode, palette, lo, hi }) => {
  it('is the six hues, and paletteFor returns it', () => {
    expect(palette).toHaveLength(6);
    expect(paletteFor(mode)).toEqual(palette);
    // Distinct values, before any perceptual question is asked.
    expect(new Set(palette).size).toBe(6);
  });

  it(`keeps every hue inside the ${lo}–${hi} lightness band`, () => {
    // Reported as a table rather than one bare boolean: when this fails, the
    // useful information is WHICH hue and BY HOW MUCH, and a failing
    // `toEqual` on a mapped array prints exactly that.
    const outOfBand = palette
      .map((hex) => ({ hex, L: Number(hexToOkLab(hex).L.toFixed(4)) }))
      .filter(({ L }) => L < lo || L > hi);
    expect(outOfBand).toEqual([]);
  });

  it('keeps every hue above the chroma floor, so none reads as grey', () => {
    const tooGrey = palette
      .map((hex) => ({ hex, C: Number(chroma(hexToOkLab(hex)).toFixed(4)) }))
      .filter(({ C }) => C < CHROMA_FLOOR);
    expect(tooGrey).toEqual([]);
  });

  it('separates every adjacent pair by at least ΔE 15 for normal vision', () => {
    const lab = palette.map(hexToOkLab);
    const tooClose = lab
      .slice(1)
      .map((next, i) => ({
        pair: `${palette[i]} → ${palette[i + 1]}`,
        dE: Number(deltaE(lab[i]!, next).toFixed(2)),
      }))
      .filter(({ dE }) => dE < SEPARATION_FLOOR);
    expect(tooClose).toEqual([]);
  });
});

/**
 * `tokens.css` is the runtime source — `chartTheme` reads `--chart-*` off the
 * document and `assignPalette` hands the result to ECharts — while `theme.ts`
 * holds the compiled fallbacks and is what the checks above run against. Two
 * copies of seven values is exactly the arrangement that drifts, so the drift
 * is a test failure rather than a mystery about why a chart is the wrong
 * colour in one theme only.
 *
 * ALL THREE BLOCKS, not just `:root`. There is no `[data-theme='light']`
 * block — the media query's own `:not()` already lets an explicit light
 * theme beat a dark OS setting — so the three that remain are `:root`, the
 * `prefers-color-scheme: dark` media block, and `[data-theme='dark']`.
 * Nothing in `apps/web/src` sets `data-theme` yet, so that last block is
 * currently INERT, but the two actually in force — `:root` and the media
 * block — are exactly the ones a typo would slip past unnoticed: it ships a
 * wrong hue or a gridline that competes with the data on every machine,
 * `chartTheme` reads it live, renders it faithfully, and nothing notices.
 *
 * `--chart-gridline` is included for the same reason. It was in none of the
 * three.
 */
describe('tokens.css and theme.ts agree about the chart tokens', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
    'utf8',
  );

  /**
   * The body of one declaration block, found by a marker that is unique in the
   * file. `:root` appears twice — once at top level and once nested inside the
   * media query — so the nested one is located by searching from the `@media`
   * rule rather than from the start of the file.
   */
  function blockAfter(marker: string, from = 0): string {
    const start = css.indexOf(marker, from);
    expect(start, `'${marker}' not found in tokens.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    return css.slice(open, css.indexOf('}', open));
  }

  /**
   * One token's value, resolving ONE level of `var()` indirection within the
   * same block.
   *
   * Three of the four `--chart-band-*` tokens are declared as
   * `var(--color-status-…)` rather than as hexes, deliberately: "the fastest
   * band is the passed colour" then stays true by construction instead of by
   * two hexes that happen to match today. Resolving the alias here is what
   * lets the drift check compare them against `theme.ts`'s compiled values —
   * and it proves something a literal hex would not, namely that the target is
   * declared in the SAME block. A block aliasing a token it does not define
   * yields an invalid value at runtime and a bare `var()` regex would have
   * called that a pass.
   */
  function tokenIn(block: string, name: string, where: string, depth = 0): string {
    const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6}|var\\(\\s*(--[\\w-]+)\\s*\\))`).exec(
      block,
    );
    expect(found?.[1], `${name} missing from ${where}`).toBeDefined();
    const alias = found![2];
    if (alias === undefined) return found![1]!.toUpperCase();
    // One level only. A chain deeper than this is a design-token smell, and an
    // unbounded recursion here would hang on a cycle rather than report one.
    expect(depth, `${name} in ${where} aliases more than one level deep`).toBe(0);
    return tokenIn(block, alias, `${where} (via ${name})`, depth + 1);
  }

  const mediaDark = css.indexOf('@media (prefers-color-scheme: dark)');

  const BLOCKS = [
    { where: ':root (light)', block: () => blockAfter(':root'), mode: 'light' as const },
    {
      where: '@media (prefers-color-scheme: dark) :root',
      block: () => blockAfter(':root', mediaDark),
      mode: 'dark' as const,
    },
    { where: "[data-theme='dark']", block: () => blockAfter("[data-theme='dark']"), mode: 'dark' as const },
  ];

  /**
   * `[data-theme='light']` is GONE, and its absence is the assertion. The media
   * query's own `:not([data-theme='light'])` is what lets an explicit light
   * override win over a dark OS setting, so a re-added block would be a second,
   * silently-diverging copy of the light values rather than a safety net.
   */
  it('declares no [data-theme=\'light\'] block', () => {
    expect(css).not.toContain("[data-theme='light'] {");
  });

  it('scopes the dark media block so an explicit light theme still wins', () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css.slice(mediaDark, mediaDark + 200)).toContain(":root:not([data-theme='light'])");
  });

  it.each(BLOCKS)('$where carries the palette theme.ts exports', ({ where, block, mode }) => {
    const body = block();
    const found = [1, 2, 3, 4, 5, 6].map((n) => tokenIn(body, `--chart-${n}`, where));
    expect(found).toEqual(paletteFor(mode).map((hex) => hex.toUpperCase()));
  });

  it.each(BLOCKS)('$where carries the gridline theme.ts exports', ({ where, block, mode }) => {
    expect(tokenIn(block(), '--chart-gridline', where)).toBe(GRIDLINE[mode].toUpperCase());
  });

  /**
   * The STATUS palette (Task 5), for the same reason and in the same four
   * blocks. `chartTheme` reads these off the live document and hands them to
   * ECharts as the indicator bands' and the donut's colours; `STATUS_COLORS` is
   * the compiled fallback the node-environment tests assert against. Two copies
   * of eight values that must not disagree.
   */
  const STATUS_TOKENS: readonly { role: StatusRole; token: string }[] = [
    { role: 'passed', token: '--color-status-passed' },
    { role: 'pending', token: '--color-status-pending' },
    { role: 'neutral', token: '--color-status-not-applicable' },
    { role: 'failed', token: '--color-status-failed' },
  ];

  it.each(BLOCKS)('$where carries the status colours theme.ts exports', ({ where, block, mode }) => {
    const body = block();
    const found = STATUS_TOKENS.map(({ token }) => tokenIn(body, token, where));
    expect(found).toEqual(
      STATUS_TOKENS.map(({ role }) => STATUS_COLORS[mode][role].toUpperCase()),
    );
  });

  /**
   * And the band ramp, in the same three blocks. Task 4's fix round
   * established that all three must carry the chart tokens: the
   * `[data-theme='dark']` block is inert today, and the two that are
   * actually in force were the ones nobody was checking.
   */
  it.each(BLOCKS)('$where carries the band ramp theme.ts exports', ({ where, block, mode }) => {
    const body = block();
    const found = BAND_RAMP.map((role) => tokenIn(body, `--chart-band-${role.slice(5)}`, where));
    expect(found).toEqual(BAND_RAMP.map((role) => BAND_COLORS[mode][role].toUpperCase()));
  });

  /** The SURFACE, text and accent tokens (Task 2), in the same three blocks. */
  const SURFACE_TOKENS_UNDER_TEST: readonly { role: SurfaceRole; token: string }[] = [
    { role: 'page', token: '--color-surface-page' },
    // Three tokens carry a longer name than their role so the @theme key can
    // hold the short one. A key that reads a var of its OWN name is circular.
    { role: 'card', token: '--color-surface-card' },
    { role: 'sidebar', token: '--color-surface-sidebar' },
    { role: 'sunken', token: '--color-surface-sunken' },
    { role: 'border', token: '--color-border' },
    { role: 'divider', token: '--color-rule' },
    { role: 'text-primary', token: '--color-text-primary' },
    { role: 'text-muted', token: '--color-text-muted' },
    { role: 'text-subtle', token: '--color-text-subtle' },
    { role: 'accent', token: '--color-accent-base' },
    { role: 'accent-foreground', token: '--color-accent-foreground' },
    { role: 'ring', token: '--color-ring' },
  ];

  it.each(BLOCKS)('$where carries the surface tokens theme.ts exports', ({ where, block, mode }) => {
    const body = block();
    const found = SURFACE_TOKENS_UNDER_TEST.map(({ token }) => tokenIn(body, token, where));
    expect(found).toEqual(
      SURFACE_TOKENS_UNDER_TEST.map(({ role }) => SURFACE_TOKENS[mode][role].toUpperCase()),
    );
  });
});

/**
 * `chartTheme`'s ink / inkMuted / surface FALLBACKS — a third copy of the same
 * few hexes, and the one `tokens.css` itself cannot guard, because these are
 * never read off a stylesheet at all. `token()` returns its fallback whenever
 * `document` is undefined (this file's own node environment; see
 * `vitest.config.ts`'s `environmentMatchGlobs`) or a custom property resolves
 * to `''` (jsdom, which parses no stylesheet — every `.test.tsx` in this
 * package, including the one that renders `Chart.tsx`). That is not a
 * theoretical corner: it is what every unit test that mounts a chart
 * actually exercises.
 *
 * `gridline` already sources its fallback from `GRIDLINE[mode]` rather than a
 * literal hex, so it cannot drift from the compiled palette by construction.
 * `ink`, `inkMuted` and `surface` are held to the same rule here: their
 * fallbacks must equal `SURFACE_TOKENS[mode]`, the same compiled truth this
 * file already pins `tokens.css` against, not an independently-typed copy of
 * three hexes that goes stale the next time someone edits `SURFACE_TOKENS`
 * and forgets this function exists.
 */
describe('chartTheme — the no-stylesheet fallbacks', () => {
  it.each(['light', 'dark'] as const)(
    'matches SURFACE_TOKENS in %s mode when no stylesheet defines the tokens',
    (mode) => {
      const theme = chartTheme(mode);
      expect(theme.ink).toBe(SURFACE_TOKENS[mode]['text-primary']);
      expect(theme.inkMuted).toBe(SURFACE_TOKENS[mode]['text-muted']);
      expect(theme.surface).toBe(SURFACE_TOKENS[mode].card);
    },
  );
});

/**
 * THE INDICATOR BAND RAMP (③, G-06…G-09) — and the one gate it does not meet.
 *
 * The bands are an ORDERED four-step severity scale, which is a different kind
 * of object from the categorical palette above. The categorical floor —
 * adjacent pairs at ΔE >= 15 — exists because categorical hues carry no
 * ordering, so a reader must be able to say "that is series 3, not series 4"
 * from colour alone. A ramp is the opposite: neighbouring steps are SUPPOSED to
 * resemble each other, and the resemblance is what makes it read as a scale
 * rather than as four unrelated warm colours.
 *
 * MEASURED, and reported rather than papered over. Adjacent ΔE on the shipped
 * ramp:
 *
 *   light  under→between 15.69   between→over  8.36   over→failed 7.81
 *   dark   under→between 17.92   between→over 10.57   over→failed 8.21
 *
 * Two pairs per mode fall below 15. That is not a defect in the hues chosen,
 * and re-picking cannot fix it: the ramp's endpoints are ΔE 30.69 apart
 * (light), so three adjacent gaps of >= 15 would need a path 47% longer than
 * the straight line between them — achievable only by swinging lightness
 * hard, which would make LIGHTNESS the dominant variable and stop the thing
 * reading as a hue ramp at all. Gatling's own four-step ramp fails the same
 * floor (`#FFDD00` → `#FFA900` is ΔE 12.65), which is the corroboration that
 * the floor, not the palette, is the wrong tool here.
 *
 * So what is asserted instead is what a ramp actually has to guarantee, and
 * these are the real gates:
 *
 *   1. All four pairwise distinct, in both modes.
 *   2. Every pair at ramp-distance >= 2 clears the SAME ΔE 15 floor the
 *      categorical palette is held to. Adjacent steps may resemble each other;
 *      steps two apart may not.
 *   3. Hue angle decreases monotonically green → red, so the ramp is ordered in
 *      the variable it claims to be ordered in. This is what the first cut
 *      failed: a neutral grey on `t >= higherMs` broke the ordering while
 *      leaving all four distinct.
 *
 * And colour is the SECOND signal regardless — every band carries its own
 * label, count and percentage in the data table.
 */
describe('the indicator band ramp', () => {
  const RAMP_MODES = ['light', 'dark'] as const;

  it.each(RAMP_MODES)('is four distinct colours in %s mode', (mode) => {
    const ramp = BAND_RAMP.map((role) => BAND_COLORS[mode][role]);
    expect(ramp).toHaveLength(4);
    expect(new Set(ramp).size).toBe(4);
  });

  it.each(RAMP_MODES)('separates every pair two or more steps apart by ΔE 15 (%s)', (mode) => {
    const lab = BAND_RAMP.map((role) => hexToOkLab(BAND_COLORS[mode][role]));
    const tooClose: { pair: string; dE: number }[] = [];
    for (let i = 0; i < lab.length; i++) {
      for (let j = i + 2; j < lab.length; j++) {
        const dE = Number(deltaE(lab[i]!, lab[j]!).toFixed(2));
        if (dE < SEPARATION_FLOOR) {
          tooClose.push({ pair: `${BAND_RAMP[i]} → ${BAND_RAMP[j]}`, dE });
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  /**
   * A regression guard on the adjacent steps, at the floor they actually meet
   * — NOT a claim that adjacent bands are independently distinguishable. The
   * number is the measured minimum rounded down; its job is to fail if someone
   * later nudges a step onto its neighbour, which `2.` above would not catch
   * for an adjacent pair.
   */
  const RAMP_STEP_FLOOR = 7.5;

  it.each(RAMP_MODES)('keeps every adjacent step at least ΔE 7.5 apart (%s)', (mode) => {
    const lab = BAND_RAMP.map((role) => hexToOkLab(BAND_COLORS[mode][role]));
    const tooClose = lab
      .slice(1)
      .map((next, i) => ({
        pair: `${BAND_RAMP[i]} → ${BAND_RAMP[i + 1]}`,
        dE: Number(deltaE(lab[i]!, next).toFixed(2)),
      }))
      .filter(({ dE }) => dE < RAMP_STEP_FLOOR);
    expect(tooClose).toEqual([]);
  });

  /**
   * The ordering, which is the whole point and the thing the status-token
   * version got wrong. Green (~148°) → amber (~75°) → orange (~45°) → red
   * (~25°): strictly decreasing hue angle, no wrap.
   */
  it.each(RAMP_MODES)('runs monotonically from green to red by hue angle (%s)', (mode) => {
    const hues = BAND_RAMP.map((role) => {
      const { a, b } = hexToOkLab(BAND_COLORS[mode][role]);
      const degrees = (Math.atan2(b, a) * 180) / Math.PI;
      return Number((degrees < 0 ? degrees + 360 : degrees).toFixed(1));
    });
    // Reported as the list, so a failure prints the angles rather than `false`.
    expect(hues).toEqual([...hues].sort((x, y) => y - x));
    // And it really spans the ramp, rather than being four neighbouring hues
    // that happen to be ordered.
    expect(hues[0]! - hues[3]!).toBeGreaterThan(90);
  });

  /**
   * The ramp's endpoints ARE the status colours — `--chart-band-under` and
   * `--chart-band-failed` are declared as `var()` aliases precisely so this
   * cannot drift. Asserted because it is what keeps red meaning "did not
   * succeed" in the bands, in `routes/marks.tsx`, and in the donut ④ that
   * paints the very same failed requests a few inches away.
   */
  it.each(RAMP_MODES)('shares its endpoints with the status palette (%s)', (mode) => {
    expect(BAND_COLORS[mode]['band-under']).toBe(STATUS_COLORS[mode].passed);
    expect(BAND_COLORS[mode]['band-failed']).toBe(STATUS_COLORS[mode].failed);
  });
});

/**
 * The status palette has to hold FOUR distinct colours, because the indicator
 * bands ③ spend all four at once in one stacked bar.
 *
 * Asserted here rather than only in the indicators test because it is a
 * property of the palette, not of the chart: an edit to `tokens.css` that
 * pointed `--color-status-not-applicable` at the same grey as something else
 * would merge two bands into one visually while every count stayed right.
 */
describe('the status palette', () => {
  it.each(['light', 'dark'] as const)('holds four distinct colours in %s mode', (mode) => {
    const colours = Object.values(STATUS_COLORS[mode]);
    expect(colours).toHaveLength(4);
    expect(new Set(colours).size).toBe(4);
  });

  /**
   * And none of them is a categorical hue. The two palettes answer different
   * questions — "which series is this?" versus "how bad is this?" — and a
   * status colour that collided with a series colour would make a band and an
   * unrelated line read as the same thing on one page.
   */
  it.each(['light', 'dark'] as const)('shares no colour with the categorical palette (%s)', (mode) => {
    const categorical = new Set<string>([...CATEGORICAL, ...CATEGORICAL_DARK]);
    for (const colour of Object.values(STATUS_COLORS[mode])) {
      expect(categorical.has(colour)).toBe(false);
    }
  });
});

/**
 * Six hues, and a seventh series must NOT wrap back to the first.
 *
 * `toConcurrentUsers` (Task 6) draws one series per scenario plus the total,
 * so a run with six scenarios already exceeds the palette. Silently cycling
 * would draw two different scenarios in the same colour, and nothing on the
 * chart would say so — the reader would simply be wrong about which line is
 * which.
 */
describe('assignPalette — more series than hues', () => {
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('gives six series six distinct colours, in fixed order', () => {
    const assigned = assignPalette(['a', 'b', 'c', 'd', 'e', 'f'], 'light');
    expect(assigned.drawn.map((d) => d.color)).toEqual([...CATEGORICAL]);
    expect(assigned.undrawn).toEqual([]);
    expect(assigned.limitation).toBeUndefined();
  });

  it('never draws two series in the same colour, however many it is handed', () => {
    const assigned = assignPalette(seven, 'light');
    const colours = assigned.drawn.map((d) => d.color);
    expect(new Set(colours).size).toBe(colours.length);
    // And specifically: the seventh did not become #0072B2 again.
    expect(assigned.drawn.map((d) => d.name)).not.toContain('g');
  });

  it('states the limitation and names what was left out, rather than dropping it silently', () => {
    const assigned = assignPalette(seven, 'light');
    expect(assigned.drawn).toHaveLength(6);
    expect(assigned.undrawn).toEqual(['g']);
    expect(assigned.limitation).toMatch(/g/);
    expect(assigned.limitation).toMatch(/not drawn|not plotted|data table/i);
  });

  /**
   * THE WHOLE PALETTE, not one slot — and the difference is not pedantry.
   *
   * This assertion used to read `assignPalette(['a'], 'dark').drawn[0]`, and it
   * could not fail: index 0 is `#0072B2` in BOTH palettes, the one slot where
   * the two are byte-identical, because it is one of the three Okabe–Ito hues
   * that already sat inside the dark lightness band. `assignPalette` reading
   * the light palette unconditionally would have passed that test — and drawn
   * dark mode in the exact three hues above the dark ceiling that this whole
   * file exists to exclude.
   *
   * Six names, so every slot is compared, including the three that differ.
   */
  it('assigns from the mode’s own palette — every slot, not just the first', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(assignPalette(six, 'dark').drawn.map((d) => d.color)).toEqual([...CATEGORICAL_DARK]);
    expect(assignPalette(six, 'light').drawn.map((d) => d.color)).toEqual([...CATEGORICAL]);

    // And the two really are different palettes, so the pair of assertions
    // above cannot both be satisfied by one array.
    expect([...CATEGORICAL_DARK]).not.toEqual([...CATEGORICAL]);
  });
});

/**
 * The cut is by declaration order — UNLESS a series says it must survive it.
 *
 * `toConcurrentUsers` orders its series `[...scenarios, total]`, so on a run
 * with six scenarios "keep the first six" keeps every scenario and drops the
 * TOTAL: the one line that answers "how loaded was the system", lost while the
 * six that only answer it in combination are all drawn. `essential` changes
 * WHICH six spend the hues; it never changes that there are six.
 */
describe('assignPalette — a series that must survive the cut', () => {
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'total'];

  it('keeps the essential series and drops an ordinary one instead', () => {
    const assigned = assignPalette(seven, 'light', [6]);
    expect(assigned.drawn.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'total']);
    expect(assigned.undrawn).toEqual(['f']);
  });

  /**
   * The index that makes the exemption safe to render. `drawn[5]` is `total`,
   * whose data lives at `series[6]` — a `Chart` pairing colours to data by
   * position in `drawn` would paint the total's colour over `f`'s numbers, on
   * every chart, silently.
   */
  it('reports each drawn series’ position in the ORIGINAL list', () => {
    const assigned = assignPalette(seven, 'light', [6]);
    expect(assigned.drawn.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 6]);
    // And the ordinary case is unchanged: index is the position.
    expect(assignPalette(seven, 'light').drawn.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('still spends six hues, all distinct, in declaration order', () => {
    const assigned = assignPalette(seven, 'light', [6]);
    expect(assigned.drawn.map((d) => d.color)).toEqual([...CATEGORICAL]);
    expect(new Set(assigned.drawn.map((d) => d.color)).size).toBe(6);
  });

  it('cannot conjure a seventh hue by marking everything essential', () => {
    const assigned = assignPalette(seven, 'light', [0, 1, 2, 3, 4, 5, 6]);
    expect(assigned.drawn).toHaveLength(6);
    expect(new Set(assigned.drawn.map((d) => d.color)).size).toBe(6);
    expect(assigned.undrawn).toHaveLength(1);
  });

  /**
   * "the first 6 of 7" is a claim about WHICH ones, and it is false as soon as
   * an essential series is kept over an earlier one. Both sentences are
   * asserted, because a limitation that misdescribes what is missing is worse
   * than a shorter one that does not.
   */
  it('says which series are missing, and does not claim they were the last ones', () => {
    expect(assignPalette(seven, 'light', [6]).limitation).toMatch(/Showing 6 of 7 series\./);
    expect(assignPalette(seven, 'light', [6]).limitation).toMatch(/\bf\b/);
    expect(assignPalette(seven, 'light').limitation).toMatch(/Showing the first 6 of 7 series\./);
  });

  it('changes nothing for a chart whose series all fit', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(assignPalette(six, 'light', [5])).toEqual(assignPalette(six, 'light'));
  });
});

/**
 * The dark set keeps Okabe–Ito's HUE ANGLES.
 *
 * This is the claim `theme.ts` rests its colour-vision-deficiency inheritance
 * on: the dark palette is not re-picked, it is the published palette with
 * lightness clamped into the dark band and the hue held. CVD confusability is
 * overwhelmingly a function of hue, so "same hues, different lightness" is what
 * makes inheriting the published property defensible — and until now it was
 * prose in a comment. A future edit that nudged a dark hex "to taste" would
 * break the inheritance silently.
 */
describe('the dark palette preserves Okabe–Ito’s hue angles', () => {
  /** OKLCH hue, in degrees. */
  const hueAngle = (hex: string): number => {
    const { a, b } = hexToOkLab(hex);
    return (Math.atan2(b, a) * 180) / Math.PI;
  };

  /** Signed separation of two angles, folded into (-180, 180]. */
  const hueDrift = (x: number, y: number): number => ((x - y + 540) % 360) - 180;

  it.each([0, 1, 2, 3, 4, 5])('slot %i holds its hue', (i) => {
    const drift = hueDrift(hueAngle(CATEGORICAL_DARK[i]!), hueAngle(CATEGORICAL[i]!));
    // Within a degree. The three unchanged hues drift by exactly 0; the three
    // re-derived ones drift only by 8-bit rounding.
    expect(Math.abs(drift)).toBeLessThan(1);
  });
});
