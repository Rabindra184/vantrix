import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARD THAT KEEPS THE GUARD HONEST (FR-STAT-4, AC-STAT-3).
 *
 * `eslint.config.js` forbids averaging percentiles. A lint rule that matches
 * nothing passes exactly as quietly as one that works — `pnpm lint` is green
 * either way — so a selector that stops matching (an esquery change, a
 * rewritten attribute, somebody "simplifying" it) would disarm the check with
 * no signal at all.
 *
 * This is `infra/test/residue-broken.sql`'s pattern in the unit suite: run the
 * real assertion against a deliberately-offending input and fail if it PASSES.
 *
 * It shells out to the repo's own eslint rather than reimplementing the
 * selectors, because a second copy of them here could drift from the config
 * and would then be testing itself.
 */

const OFFENDING = `
declare const p95: number; declare const p99: number;
declare const row: { p95Ms: number; p99Ms: number };
declare const percentiles: Record<string, number> & { reduce: (f: unknown, i: number) => number };
export const a = (p95 + p99) / 2;
export const b = (row.p95Ms + row.p99Ms) / 2;
export const c = (percentiles['p95'] + percentiles['p99']) / 2;
export const d = percentiles.reduce((s: number, v: number) => s + v, 0) / 4;
`;

/**
 * Legitimate arithmetic ON a percentile, which must stay allowed.
 *
 * A unit conversion is not an average, and a rule that refused `p95 / 1000`
 * would be refused by its own callers within a week — `timeAxis.ts` and every
 * chart transform divide milliseconds by a thousand. The paired case is what
 * stops "forbid averaging" quietly becoming "forbid touching".
 */
const LEGITIMATE = `
declare const p95: number; declare const p99: number;
export const seconds = p95 / 1000;
export const spread = p99 - p95;
export const worst = Math.max(p95, p99);
`;

function lint(source: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      'node_modules/.bin/eslint',
      ['--stdin', '--stdin-filename', 'packages/statistics/src/lint-probe.ts'],
      { input: source, encoding: 'utf8', cwd: process.cwd() },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, out: e.stdout ?? '' };
  }
}

describe('eslint forbids averaging percentiles', () => {
  it('rejects every shape of it, once per offending expression', () => {
    const { code, out } = lint(OFFENDING);
    expect(code, out).not.toBe(0);
    // One report per defect, not one per percentile mentioned — the `:has()`
    // in the selector is what buys that, and a rewrite losing it would
    // double every message without failing anything.
    expect(out.match(/Averaging percentiles/g) ?? []).toHaveLength(3);
    expect(out.match(/Reducing a percentile/g) ?? []).toHaveLength(1);
  });

  it('leaves legitimate arithmetic on a percentile alone', () => {
    const { code, out } = lint(LEGITIMATE);
    expect(code, out).toBe(0);
  });
});
