import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// From its own module, NOT the package index: this guard has to LOAD to report
// a reintroduced DDSketch import, and a specifier for an uninstalled package
// anywhere in the index's graph would fail the file at import, naming nothing.
import { Histogram } from '../src/histogram.js';

/**
 * NO PRODUCTION CODE TAKES A QUANTILE, AND NOTHING IMPORTS A DDSKETCH.
 *
 * This guard began as "every production sketch quantile is clamped": a
 * DDSketch's estimate could lie up to 1% outside the sample it summarised, so
 * every `.quantile(` call had to be wrapped in `clampPercentile` against the
 * min and max reported beside it. The set of callers was DERIVED from the
 * source rather than listed, because the list `clampPercentile`'s docstring
 * once kept drifted — that is how `tool-assertions.ts` came to judge a Gatling
 * assertion against an estimate 12.46 ms above the run's own maximum.
 *
 * Exact statistics (2026-10-15) moved every rollup, bucket, SLA metric and
 * Gatling assertion onto exact `Histogram`s, whose method is `percentile` —
 * nearest-rank over observed values, inside its own range by construction —
 * and PR 5 dropped `run_stat.sketch`, then deleted the sketch wrapper and its
 * `@datadog/sketches-js` dependency. So the rule has two halves, and either
 * coming back is an estimate coming back — a decision to make on purpose, not
 * one to find in review:
 *
 *   - no production line calls `.quantile(` at all;
 *   - no production source and no workspace `package.json` names the DDSketch
 *     package. A manifest is scanned too, because a dependency re-added
 *     without an import yet is the first half of the same return.
 *
 * ═══ WHAT THE FLOOR COUNTS ═══
 *
 * A collector that matches nothing passes exactly as quietly as one that
 * works, and with no callers left a floor on CALLERS would have to be zero —
 * so the floor is on FILES SCANNED, for sources and for manifests alike. A
 * walk that stops finding them fails here rather than reporting a clean tree.
 *
 * ═══ COMMENTS ARE STRIPPED, AND THAT IS LOAD-BEARING ═══
 *
 * Measured on 2026-10-22, with no real caller left: replacing the strip with
 * the identity makes the quantile half fail on three `.quantile(` mentions,
 * all of them prose in `packages/statistics/src/percentile.ts` — the clamp's
 * own docstring, which explains this very guard. Prose about a quantile, or
 * about the DDSketch that was retired, is not a caller.
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

/** The retired estimator's package, spelled once so the two halves agree. */
const DDSKETCH_PACKAGE = '@datadog/sketches-js';

function scan(): { files: number; calls: QuantileCall[]; ddsketch: QuantileCall[] } {
  const files = [...productionSources('packages'), ...productionSources('apps')];
  const calls: QuantileCall[] = [];
  const ddsketch: QuantileCall[] = [];
  for (const file of files) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (line.includes('.quantile(')) calls.push({ file, line: i + 1, text: line.trim() });
      if (line.includes(DDSKETCH_PACKAGE)) ddsketch.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return { files: files.length, calls, ddsketch };
}

/**
 * The root manifest, and every workspace package's manifest under packages/
 * and apps/ — one level deep. The root is where an override or a dev
 * dependency would bring the estimator back without any package naming it.
 */
function workspaceManifests(): string[] {
  const out: string[] = ['package.json'];
  for (const root of ['packages', 'apps']) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(root, entry.name, 'package.json');
      if (existsSync(manifest)) out.push(manifest);
    }
  }
  return out;
}

describe('no production code computes a sketch quantile, and nothing imports a DDSketch', () => {
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

  it('finds no DDSketch specifier in any production source, the root manifest or a workspace manifest', () => {
    const { files, ddsketch } = scan();
    const manifests = workspaceManifests();

    // VACUITY: on what was scanned. Twelve workspace packages exist today.
    expect(files, 'the production-source walk found almost nothing — the collector has rotted').toBeGreaterThan(100);
    expect(manifests.length, 'the manifest walk found almost nothing — the collector has rotted').toBeGreaterThan(8);
    expect(manifests, 'the root manifest is scanned too').toContain('package.json');

    const inManifests = manifests.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes(DDSKETCH_PACKAGE) ? [`${file}:${i + 1}  ${line.trim()}`] : [])),
    );

    expect(
      [...ddsketch.map((c) => `${c.file}:${c.line}  ${c.text}`), ...inManifests],
      'the DDSketch was retired with exact statistics — percentiles are exact ' +
        'Histogram#percentile now, and a dependency on the estimator is a decision, not a drift',
    ).toEqual([]);
  });
});
