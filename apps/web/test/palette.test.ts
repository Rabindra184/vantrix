import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL,
  CATEGORICAL_DARK,
  GRIDLINE,
  STATUS_COLORS,
  assignPalette,
  paletteFor,
  type ChartMode,
  type StatusRole,
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
 * ALL FOUR BLOCKS, not just the `[data-theme]` pair. This test used to check
 * only `[data-theme='light']` and `[data-theme='dark']` — and nothing in
 * `apps/web/src` sets `data-theme`, so those two blocks are the only ones
 * currently INERT. The blocks actually in force are `:root` and the
 * `prefers-color-scheme: dark` media block, and neither was checked: a typo
 * there ships a wrong hue or a gridline that competes with the data on every
 * machine, `chartTheme` reads it live, renders it faithfully, and nothing
 * notices.
 *
 * `--chart-gridline` is included for the same reason. It was in none of the
 * four.
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

  function tokenIn(block: string, name: string, where: string): string {
    const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    expect(found?.[1], `${name} missing from ${where}`).toBeDefined();
    return found![1]!.toUpperCase();
  }

  const mediaDark = css.indexOf('@media (prefers-color-scheme: dark)');

  const BLOCKS = [
    // The two that are IN FORCE today.
    { where: ':root (light)', block: () => blockAfter(':root'), mode: 'light' as const },
    {
      where: '@media (prefers-color-scheme: dark) :root',
      block: () => blockAfter(':root', mediaDark),
      mode: 'dark' as const,
    },
    // The two a future theme toggle will switch to.
    { where: "[data-theme='light']", block: () => blockAfter("[data-theme='light']"), mode: 'light' as const },
    { where: "[data-theme='dark']", block: () => blockAfter("[data-theme='dark']"), mode: 'dark' as const },
  ];

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
