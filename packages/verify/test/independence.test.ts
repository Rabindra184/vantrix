import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══ THE VERIFIER NEVER REACHES THE ENGINE IT CHECKS, OR THE DATABASE ═══
 *
 * The verifier's whole value is that it computes every figure a SECOND way:
 * if it imported the statistics engine, a defect there would be reproduced
 * here and the comparison would agree with itself. And it is handed stored
 * figures by the worker, so it has no business reading persistence.
 *
 * eslint.config.js's `FORBIDDEN_IN_VERIFIER` refuses both as `no-restricted-imports`,
 * and that rule has a hole the final review measured: it does not see a
 * DYNAMIC `import(...)`. An `await import('../../statistics/src/rank.js')` in
 * `packages/verify/src` linted clean while an `export *` on the next line was
 * caught — and the root `node_modules` holds the engine's package, so even a
 * bare dynamic specifier resolves. This reads every specifier in the package's
 * source and tests itself — static `from`, side-effect `import '…'`, dynamic
 * `import(…)` and `require(…)` — so the rule holds whichever spelling is used.
 *
 * Comments are stripped first: this package's docstrings name the engine and
 * the database layer while explaining why they are out of bounds, and prose
 * about the rule is not a breach of it. A specifier is matched only inside the
 * syntax that can import, never as a bare word.
 */

const ROOT = join('packages', 'verify');
const FORBIDDEN = /statistics|@perfportal\/persistence|\/persistence\//;

/** `/* *\/` and whole-line `//` removed, so prose about an import is never one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.ts` under `src` and `test` — never `dist` or `node_modules`. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'test'));
  return out;
}

/**
 * `from '…'`, `import '…'`, `import('…')` and `require('…')`, with any quote
 * — a template literal included, since `import(\`…\`)` is legal.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

function specifiers(): Array<{ file: string; specifier: string }> {
  const found: Array<{ file: string; specifier: string }> = [];
  for (const file of sources()) {
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(SPECIFIER)) {
      found.push({ file, specifier: m[2] ?? '' });
    }
  }
  return found;
}

describe('the verifier stays independent', () => {
  it('imports nothing from the statistics engine or persistence, by any spelling', () => {
    const all = specifiers();

    // VACUITY: a collector that matches nothing passes exactly as quietly as
    // one that works. The package's own sources import each other, core and
    // vitest dozens of times; fewer than twenty means the walk or the pattern
    // has rotted, not that the package became tiny.
    expect(sources().filter((f) => f.includes(join(ROOT, 'src'))).length).toBeGreaterThanOrEqual(5);
    expect(all.length).toBeGreaterThan(20);

    const breaches = all.filter((s) => FORBIDDEN.test(s.specifier)).map((s) => `${s.file}: ${s.specifier}`);
    expect(breaches).toEqual([]);
  });
});
