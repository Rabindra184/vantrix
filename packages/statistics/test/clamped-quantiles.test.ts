import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/index.js';

/**
 * EVERY SKETCH QUANTILE IN PRODUCTION IS CLAMPED, AND THE LIST IS DERIVED.
 *
 * `clampPercentile`'s own docstring states the rule — "a percentile is clamped
 * against the same min and max reported beside it" — and then NAMED its call
 * sites in prose. That enumeration went stale the first time somebody added a
 * caller, which is exactly how `tool-assertions.ts` came to judge a Gatling
 * assertion against an estimate 12.46 ms above the run's own maximum: the
 * clamp branch listed `RollupBuilder.finish`, `bucketLatency`, `resolveMetric`
 * and the metrics controller, and that module is on none of them.
 *
 * A LIST A HUMAN MAINTAINS IS A LIST THAT DRIFTS — this file already records
 * that for `SCHEMA_TABLES` ("DERIVED … NEVER HAND-MAINTAINED. This was a
 * literal list, and it had already drifted"), for `allColumns` ("A NAME IS NOT
 * A CHECK"), for the cross-org endpoint array, and for the four hard-coded
 * rule scopes. So this asks the SOURCE instead: every `.quantile(` call under
 * `packages/<pkg>/src` and `apps/<app>/src` must either be wrapped in
 * `clampPercentile(...)` or be named in `EXEMPT` with its reason.
 *
 * ═══ WHY THIS IS SYNTACTIC, AND WHAT THAT COSTS ═══
 *
 * It cannot prove the clamp uses the RIGHT range — `clampPercentile(q, row)`
 * against some unrelated row satisfies it. What it catches is the shape that
 * actually happened: a caller that never clamps at all. The behavioural cases
 * live beside it (`tool-assertions.test.ts` asserts the verdict agrees with the
 * percentile the statistics table prints), which is the division of labour the
 * security guard in `session-auth.integration.test.ts` already uses.
 *
 * ═══ AFTER EXACT STATISTICS, ONE CALLER IS THE POINT ═══
 *
 * Since 2026-10-15 every rollup, bucket, SLA metric and Gatling assertion is a
 * nearest-rank read of an exact `Histogram`, whose method is `percentile` and
 * which has no `quantile` at all. The one production `Sketch#quantile` that
 * remains by design is the LEGACY path in `stored-percentiles.ts`: a row
 * written before 2026-10-15 recomputed from its stored DDSketch, clamped. So
 * the vacuity floor is ONE caller, not zero — a guard over a rule nobody can
 * break any more would still pass, which is exactly what the floor refuses —
 * and the second case pins why every `.quantile(` the collector finds can only
 * be a sketch's: `Histogram` has no such method, and no production line names
 * one as the receiver.
 *
 * ═══ COMMENTS ARE STRIPPED, AND THIS ONE IS NOT DEFENSIVE ═══
 *
 * Measured rather than asserted, which this file asks for after three branches
 * repaired a false load-bearing claim by ADDING prose instead of correcting the
 * sentence. Measured on 2026-10-16, after the metrics controller moved onto
 * `storedPercentiles`, so `stored-percentiles.ts` is the one caller: with the
 * strip replaced by the identity the collector finds FOUR calls rather than
 * one, and all three extras are prose —
 *
 *     packages/statistics/src/percentile.ts (twice)  the clamp's own docstring
 *     apps/web/src/routes/RunSummary.tsx              the docstring correcting Sketch
 *
 * The first is the one worth seeing. `percentile.ts` explains THIS guard, and
 * the sentence in which it does so says `.quantile(` — so without the strip the
 * rule's own documentation is reported as a caller breaking the rule. The strip
 * is load-bearing here, not defensive.
 */

const CLAMPER = 'clampPercentile';

/**
 * Call sites that legitimately do not clamp, each with the reason a reader can
 * check. Delete an entry the day its premise stops holding.
 */
const EXEMPT: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  // `packages/statistics/src/window.ts` was the one entry, because it took a
  // quantile off a `Histogram` rather than a `Sketch`. It calls
  // `Histogram#percentile` now — exact nearest-rank over observed values, so
  // inside its own range by construction — and no longer matches `.quantile(`
  // at all, so the exemption was deleted rather than left naming nothing.
];

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
  readonly clamped: boolean;
}

function quantileCalls(): QuantileCall[] {
  const calls: QuantileCall[] = [];
  for (const file of [...productionSources('packages'), ...productionSources('apps')]) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('.quantile(')) return;
      // The clamp may wrap the call on the same line or open on the line
      // above, which is how `tool-assertions.ts` and `bucket-latency.ts`
      // respectively spell it.
      const window = [lines[i - 1] ?? '', line].join(' ');
      calls.push({ file, line: i + 1, text: line.trim(), clamped: window.includes(CLAMPER) });
    });
  }
  return calls;
}

describe('every production sketch quantile is clamped', () => {
  it('finds no caller that neither clamps nor is exempt', () => {
    const calls = quantileCalls();

    // VACUITY: a collector that matches nothing passes exactly as quietly as
    // one that works, which this file records for the tokens guard and the
    // run-route sweep. The floor is ONE, and it holds with
    // `stored-percentiles.ts`'s legacy sketch path as the only caller — which
    // is what this guard protects once the metrics controller moves onto
    // `storedPercentiles`. `RollupBuilder.finish`, `bucketLatency`,
    // `tool-assertions.ts` and `packages/sla`'s `resolveMetric` read exact
    // histograms and take no `.quantile(` at all.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.some((c) => c.file.endsWith(join('packages', 'statistics', 'src', 'stored-percentiles.ts'))),
      'the legacy sketch path in stored-percentiles.ts is the caller this guard exists for',
    ).toBe(true);

    const exemptFiles = new Set(EXEMPT.map((e) => e.file));
    const offenders = calls
      .filter((c) => !c.clamped && !exemptFiles.has(c.file))
      .map((c) => `${c.file}:${c.line}  ${c.text}`);

    expect(
      offenders,
      'a percentile must be clamped against the min and max reported beside it — ' +
        `wrap the call in ${CLAMPER}(...), or add the file to EXEMPT with its reason`,
    ).toEqual([]);
  });

  it('no production code calls Histogram#quantile — it does not exist', () => {
    // BEHAVIOURAL: the exact histogram answers `percentile`, nearest-rank over
    // observed values, so it needs no clamp and offers no `quantile` to call.
    // This is what makes every `.quantile(` the case above collects a SKETCH
    // call — if a `quantile` ever came back on `Histogram`, an unclamped call
    // on it would type-check and this guard could no longer tell the two apart.
    expect('quantile' in Histogram.prototype).toBe(false);

    // SYNTACTIC: and no production line names a histogram as the receiver, so
    // a reintroduced method (or a structurally-typed stand-in) is caught at
    // the call site, not only at the class.
    const histogramReceivers = quantileCalls()
      .filter((c) => /histogram\w*!?\.quantile\(/i.test(c.text))
      .map((c) => `${c.file}:${c.line}  ${c.text}`);
    expect(histogramReceivers, 'a Histogram has percentile(p), never quantile(q)').toEqual([]);
  });

  it('keeps every exemption earning its place', () => {
    const calls = quantileCalls();

    // An exemption naming a file that no longer takes a quantile is a name
    // matching nothing, and the list would rot into three such names while the
    // guard reported green — the shape the remediation guard already pins.
    const stale = EXEMPT.filter((e) => !calls.some((c) => c.file === e.file)).map((e) => e.file);

    expect(stale, 'exempt files that no longer call .quantile( — delete them').toEqual([]);
  });
});
