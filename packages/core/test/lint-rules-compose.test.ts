import { execFileSync } from 'node:child_process';
import { ESLint, type Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * TWO `no-restricted-syntax` RULES, AND THE GUARD THAT KEEPS BOTH IN FORCE.
 *
 * `eslint.config.js` carries two selector sets under one rule name: the
 * conditional-spread ban (a mistyped key inside a spread literal is not
 * excess-property checked) and the averaged-percentiles ban (FR-STAT-4,
 * AC-STAT-3). ESLint flat config does not MERGE a rule's options across
 * config objects; when two objects match one file and both set the rule, the
 * later one REPLACES the earlier one's selectors outright.
 *
 * That is exactly what happened. The two sets lived in two blocks with no
 * `files:` key, both matching every file, and the percentile block — added
 * second — silently replaced the spread selector everywhere. Measured
 * 2026-10-06: `eslint --print-config` on files under apps/web/src,
 * apps/api/src and packages/statistics/src showed the percentile selectors
 * alone, and a probe holding a conditional spread linted with exit 0.
 * `pnpm lint` was green the whole time, because an inert rule and a clean
 * tree print the same thing — and one conditional spread had crept back in
 * while it was off.
 *
 * `no-averaged-percentiles.test.ts` beside the statistics package proves the
 * percentile selectors MATCH, at one path. It could not see this: the defect
 * is not a selector that stopped matching but a selector that stopped being
 * CONFIGURED, and it was the other rule that went. So this file asks two
 * questions, each of which a later block narrowing either set fails:
 *
 *   1. Do both rules FIRE on an offending snippet at real source paths in
 *      every app and package tree? (Behaviour, through the real config.)
 *   2. Is every selector set in force on EVERY file eslint lints? (The
 *      computed config of all ~650 of them, in under a second.) A block
 *      scoped to one glob would slip past any fixed list of probe paths
 *      outside that glob; this sweep cannot be outside it.
 *
 * It uses the ESLint API in-process rather than re-declaring any selector, for
 * the reason the percentile test shells out: a second copy here would drift
 * from the config and end up testing itself. Rules are recognised by their
 * MESSAGE, which a selector rewrite keeps; question 1 is what proves the
 * selectors themselves still match.
 */

const RULES = {
  spread: /^A conditional spread hides a mistyped key/,
  average: /^Averaging percentiles is a defect/,
  reduce: /^Reducing a percentile set/,
} as const;

type RuleName = keyof typeof RULES;

/**
 * Files a selector set is deliberately NOT in force on. Each entry is pinned
 * both ways: a file missing a set and not listed here fails, and a listed
 * file that has the set after all fails too, so this cannot rot into an
 * exemption nobody needs while the guard reports green.
 */
const EXEMPT: Record<RuleName, ReadonlyMap<string, string>> = {
  spread: new Map([
    [
      'apps/web/src/charts/Chart.tsx',
      'The ECharts option bag. EChartsOption carries index signatures, so the ' +
        'literal handed to setOption accepts any key and a spread loses no check ' +
        'there; measured with a bogus key as a plain property, typecheck exit 0. ' +
        'The percentile selectors are NOT exempt there and this list says so by ' +
        'leaving the other two sets empty.',
    ],
  ]),
  average: new Map(),
  reduce: new Map(),
};

/** One of each shape, so each rule's count is exactly one. */
const OFFENDING = `
declare const c: boolean;
declare const p95: number; declare const p99: number;
declare const percentiles: number[];
export const spread = { ...(c ? { k: 1 } : {}) };
export const mean = (p95 + p99) / 2;
export const total = percentiles.reduce((s, v) => s + v, 0);
`;

/**
 * What the spread rule must leave alone, and what it tells you to write
 * instead. The rule shipped with no test of its own, so nothing pinned that
 * a TYPED value in a conditional spread is fine — the line that keeps the
 * selector from being widened into "forbid every conditional spread" and then
 * switched off by the first caller it annoys.
 */
const LEGITIMATE = `
declare const c: boolean;
declare const typed: { k: number };
declare const p95: number;
export const spreadTyped = { ...(c ? typed : {}) };
export const named = { k: c ? 1 : undefined };
export const seconds = p95 / 1000;
`;

/**
 * A source path in every tree eslint lints. These are FILE NAMES, not files:
 * `lintText` resolves the config for the path and never reads it, so a probe
 * leaves nothing behind.
 */
const PROBES = [
  'apps/web/src/routes/lint-probe.tsx',
  'apps/web/src/lint-probe.ts',
  'apps/api/src/lint-probe.ts',
  'apps/worker/src/lint-probe.ts',
  'apps/runner/src/lint-probe.ts',
  'packages/contracts/src/lint-probe.ts',
  'packages/persistence/src/lint-probe.ts',
  'packages/statistics/src/lint-probe.ts',
];

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

async function counts(source: string, filePath: string): Promise<Record<RuleName, number> & { other: string[] }> {
  const [result] = await eslint.lintText(source, { filePath, warnIgnored: true });
  const out = { spread: 0, average: 0, reduce: 0, other: [] as string[] };
  for (const m of result?.messages ?? []) {
    const name = (Object.keys(RULES) as RuleName[]).find(
      (r) => m.ruleId === 'no-restricted-syntax' && RULES[r].test(m.message),
    );
    if (name) out[name] += 1;
    else out.other.push(`${m.ruleId ?? 'parse'}: ${m.message}`);
  }
  return out;
}

/** The selector sets in force on a file, by the rule each one belongs to. */
function inForce(config: Linter.Config | undefined): Set<RuleName> {
  const entry = config?.rules?.['no-restricted-syntax'];
  const found = new Set<RuleName>();
  if (!Array.isArray(entry)) return found;
  const [severity, ...options] = entry;
  if (severity !== 2 && severity !== 'error') return found;
  for (const option of options) {
    const message = typeof option === 'object' && option !== null ? (option as { message?: unknown }).message : undefined;
    if (typeof message !== 'string') continue;
    for (const r of Object.keys(RULES) as RuleName[]) if (RULES[r].test(message)) found.add(r);
  }
  return found;
}

describe('every no-restricted-syntax selector set stays in force', () => {
  it.each(PROBES)('both rules fire on an offending snippet at %s', async (path) => {
    const c = await counts(OFFENDING, path);
    expect(c, JSON.stringify(c)).toEqual({ spread: 1, average: 1, reduce: 1, other: [] });
  });

  it('keeps only the percentile rules on the spread rule’s one exemption', async () => {
    const c = await counts(OFFENDING, 'apps/web/src/charts/Chart.tsx');
    expect(c, JSON.stringify(c)).toEqual({ spread: 0, average: 1, reduce: 1, other: [] });
  });

  it('leaves a typed conditional spread and a named key alone', async () => {
    const c = await counts(LEGITIMATE, PROBES[0]!);
    expect(c, JSON.stringify(c)).toEqual({ spread: 0, average: 0, reduce: 0, other: [] });
  });

  it('is configured on every file eslint lints, bar the named exemptions', async () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'],
      { encoding: 'utf8', cwd: process.cwd() },
    )
      .split('\n')
      .filter(Boolean);

    const missing: Record<RuleName, string[]> = { spread: [], average: [], reduce: [] };
    let linted = 0;
    for (const file of tracked) {
      if (await eslint.isPathIgnored(file)) continue;
      const config = (await eslint.calculateConfigForFile(file)) as Linter.Config | undefined;
      if (config === undefined) continue;
      linted += 1;
      const present = inForce(config);
      for (const r of Object.keys(RULES) as RuleName[]) if (!present.has(r)) missing[r].push(file);
    }

    // Count the construct, never the verdict: a collector that found nothing
    // would report every rule present on every file it looked at.
    expect(linted, 'collected almost nothing to lint -- the file walk has rotted').toBeGreaterThan(300);

    for (const r of Object.keys(RULES) as RuleName[]) {
      const unexpected = missing[r].filter((f) => !EXEMPT[r].has(f));
      expect(unexpected, `the ${r} rule is not in force on these files`).toEqual([]);
      const stale = [...EXEMPT[r].keys()].filter((f) => !missing[r].includes(f));
      expect(stale, `exempt from the ${r} rule but the rule is in force there -- delete the entry`).toEqual([]);
    }
  });
});
