import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL,
  CATEGORICAL_DARK,
  assignPalette,
  paletteFor,
  type ChartMode,
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
 * `tokens.css` is the runtime source — `chartTheme` reads `--chart-N` off the
 * document — while `theme.ts` holds the compiled fallbacks and is what the
 * checks above run against. Two copies of six hex values is exactly the
 * arrangement that drifts, so the drift is a test failure rather than a
 * mystery about why a chart is the wrong colour in one theme only.
 */
describe('tokens.css and theme.ts agree about the palette', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
    'utf8',
  );

  /** The `--chart-1..6` declarations inside one selector's block. */
  function chartTokensIn(selector: string): string[] {
    const start = css.indexOf(selector);
    expect(start, `${selector} not found in tokens.css`).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf('}', start));
    return [1, 2, 3, 4, 5, 6].map((n) => {
      const found = new RegExp(`--chart-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
      expect(found?.[1], `--chart-${n} missing from ${selector}`).toBeDefined();
      return found![1]!.toUpperCase();
    });
  }

  it.each([
    // The explicit [data-theme] blocks are the ones checked: they are the
    // authoritative pair, and tokens.css's own comment records that they must
    // win over prefers-color-scheme in both directions.
    { selector: "[data-theme='light']", expected: CATEGORICAL },
    { selector: "[data-theme='dark']", expected: CATEGORICAL_DARK },
  ])('$selector carries the palette theme.ts exports', ({ selector, expected }) => {
    expect(chartTokensIn(selector)).toEqual(expected.map((hex) => hex.toUpperCase()));
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

  it('assigns from the mode’s own palette', () => {
    expect(assignPalette(['a'], 'dark').drawn[0]!.color).toBe(CATEGORICAL_DARK[0]);
    expect(assignPalette(['a'], 'light').drawn[0]!.color).toBe(CATEGORICAL[0]);
  });
});
