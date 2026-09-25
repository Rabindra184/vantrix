import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
 * ═══ COMMENTS ARE STRIPPED, AND THIS ONE IS NOT DEFENSIVE ═══
 *
 * Measured rather than asserted, which this file asks for after three branches
 * repaired a false load-bearing claim by ADDING prose instead of correcting the
 * sentence. Run with the strip replaced by the identity, the collector finds
 * TEN calls rather than seven, and all three extras are prose:
 *
 *     packages/statistics/src/percentile.ts:67    the clamp's own docstring
 *     packages/statistics/src/tool-assertions.ts  the comment explaining its clamp
 *     apps/web/src/routes/RunDetail.tsx           the docstring correcting Sketch
 *
 * The first is the one worth seeing. `percentile.ts` explains THIS guard, and
 * the sentence in which it does so says `.quantile(` — so without the strip the
 * rule's own documentation is reported as a caller breaking the rule. The other
 * two were written in the branch that fixed this defect class. The strip is
 * load-bearing here, not defensive, and the second mutation below proves it.
 */

const CLAMPER = 'clampPercentile';

/**
 * Call sites that legitimately do not clamp, each with the reason a reader can
 * check. Delete an entry the day its premise stops holding.
 */
const EXEMPT: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: 'packages/statistics/src/window.ts',
    // The receiver is a `Histogram`, not a `Sketch`: an exact 1 ms structure
    // whose `quantile` is nearest-rank over observed values and whose min/max
    // ARE observed values, so its answer is inside its own range by
    // construction rather than by estimate. Measured across five shapes
    // including ranges narrower than a bin, seven ranks each: worst escape
    // 0.000000 ms. If this file ever takes a quantile off a `Sketch`, that
    // call needs clamping and this exemption needs narrowing.
    why: 'Histogram quantiles are nearest-rank over observed values, so they cannot escape',
  },
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
    // run-route sweep.
    expect(calls.length).toBeGreaterThan(4);

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

  it('keeps every exemption earning its place', () => {
    const calls = quantileCalls();

    // An exemption naming a file that no longer takes a quantile is a name
    // matching nothing, and the list would rot into three such names while the
    // guard reported green — the shape the remediation guard already pins.
    const stale = EXEMPT.filter((e) => !calls.some((c) => c.file === e.file)).map((e) => e.file);

    expect(stale, 'exempt files that no longer call .quantile( — delete them').toEqual([]);
  });
});
