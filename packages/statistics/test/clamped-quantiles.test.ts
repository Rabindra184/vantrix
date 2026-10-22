import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/index.js';

/**
 * NO PRODUCTION CODE TAKES A QUANTILE ANY MORE.
 *
 * This guard began as "every production sketch quantile is clamped": a
 * DDSketch's estimate can lie up to 1% outside the sample it summarises, so
 * every `.quantile(` call had to be wrapped in `clampPercentile` against the
 * min and max reported beside it. The set of callers was DERIVED from the
 * source rather than listed, because the list `clampPercentile`'s docstring
 * once kept drifted — that is how `tool-assertions.ts` came to judge a Gatling
 * assertion against an estimate 12.46 ms above the run's own maximum.
 *
 * Exact statistics (2026-10-15) moved every rollup, bucket, SLA metric and
 * Gatling assertion onto exact `Histogram`s, whose method is `percentile` —
 * nearest-rank over observed values, inside its own range by construction —
 * and PR 5 dropped `run_stat.sketch`, which took the last caller with it:
 * `stored-percentiles.ts` now clamps a legacy row's FROZEN value and quantiles
 * nothing. So the rule is simpler and stricter: no production line calls
 * `.quantile(` at all. A caller that comes back is a sketch (or some other
 * estimate) coming back, and that is a decision to make on purpose, not one
 * to find in review.
 *
 * `packages/statistics/src/sketch.ts` still DEFINES `quantile(q)` until the
 * next task deletes the file, but it never CALLS `.quantile(` on anything, so
 * it needs no exclusion here — measured, not assumed.
 *
 * ═══ WHAT THE FLOOR COUNTS ═══
 *
 * A collector that matches nothing passes exactly as quietly as one that
 * works, and with no callers left a floor on CALLERS would have to be zero —
 * so the floor is on FILES SCANNED. A walk that stops finding production
 * sources fails here rather than reporting a clean tree.
 *
 * ═══ COMMENTS ARE STRIPPED, AND THAT IS LOAD-BEARING ═══
 *
 * Measured on 2026-10-22, with no real caller left: replacing the strip with
 * the identity makes the guard fail on three `.quantile(` mentions, all of
 * them prose in `packages/statistics/src/percentile.ts` — the clamp's own
 * docstring, which explains this very guard. Prose about a quantile is not a
 * caller.
 */

/** `/* *\/` and `//` removed, so prose about a quantile is never a caller. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Production `.ts`/`.tsx` under a root — no tests, no build output. */
function productionSources(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', 'test', 'e2e', '.turbo', 'prisma']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

interface QuantileCall {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(): { files: number; calls: QuantileCall[] } {
  const files = [...productionSources('packages'), ...productionSources('apps')];
  const calls: QuantileCall[] = [];
  for (const file of files) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (line.includes('.quantile(')) calls.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return { files: files.length, calls };
}

describe('no production code takes a quantile', () => {
  it('finds no .quantile( call in any production source', () => {
    const { files, calls } = scan();

    // VACUITY: on files scanned, not on callers — there are no callers left.
    expect(files, 'the production-source walk found almost nothing — the collector has rotted').toBeGreaterThan(100);

    expect(
      calls.map((c) => `${c.file}:${c.line}  ${c.text}`),
      'no production code calls .quantile( since the DDSketch was retired — ' +
        'percentiles come from an exact Histogram#percentile or a legacy row\'s frozen column',
    ).toEqual([]);
  });

  it('no production code calls Histogram#quantile — it does not exist', () => {
    // BEHAVIOURAL: the exact histogram answers `percentile`, nearest-rank over
    // observed values, so it needs no clamp and offers no `quantile` to call.
    expect('quantile' in Histogram.prototype).toBe(false);

    // SYNTACTIC: and no production line names a histogram as the receiver, so
    // a reintroduced method (or a structurally-typed stand-in) is caught at
    // the call site, not only at the class.
    const histogramReceivers = scan()
      .calls.filter((c) => /histogram\w*!?\.quantile\(/i.test(c.text))
      .map((c) => `${c.file}:${c.line}  ${c.text}`);
    expect(histogramReceivers, 'a Histogram has percentile(p), never quantile(q)').toEqual([]);
  });
});
