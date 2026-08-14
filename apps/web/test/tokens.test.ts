import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * `bg-[var(--color-surface)]` was how every component reached a token before
 * Tailwind v4's `@theme` gave them real names. The arbitrary-value form still
 * WORKS, which is exactly why it needs a gate: it is invisible in review, and
 * one of them re-introduced next to `bg-surface` leaves two spellings of the
 * same colour with nothing to notice the drift.
 *
 * THE PATTERN COVERS THE TYPE-HINTED FORM TOO. The original regex,
 * `/\[var\(--[a-z-]+\)\]/g`, matched `bg-[var(--color-surface)]` but not
 * `text-[color:var(--color-status-failed)]` — the `color:` type hint Tailwind
 * arbitrary values accept defeats a bracket immediately followed by `var(`.
 * `SignOutButton.tsx` and `Login.tsx` shipped exactly that spelling and this
 * gate passed on both, which is how the design's §10 criterion ("no `[var(--`
 * outside `marks.tsx`") was true on a technicality while two files still
 * reached a token by arbitrary value.
 *
 * Two exemptions, each named by REPO-RELATIVE PATH rather than by filename
 * suffix — the original `path.endsWith('marks.tsx')` would exempt any future
 * `somewhere/marks.tsx` too, which is a wider hole than intended:
 *
 *   - `routes/marks.tsx`. Its colour travels as DATA on a `Mark`, through an
 *     inline `style`, because `Marked` and `Badge` both render it. That is
 *     not a utility class and has no `@theme` equivalent.
 *   - `SignOutButton.tsx` and `Login.tsx`'s `text-[color:var(--color-status-failed)]`.
 *     Status colour is deliberately NOT published through `@theme` — a
 *     `text-status-failed` utility would invite its use as a chart FILL, and
 *     the fill palette (`--chart-status-*`) is a different set of values from
 *     the text palette (`--color-status-*`); see `theme.ts`'s `STATUS_COLORS`
 *     docstring. So these two reach the token the only way `@theme` leaves
 *     open, and stay exempt rather than growing a utility that would blur
 *     that split.
 */
const EXEMPT_PATHS = new Set([
  'routes/marks.tsx',
  'SignOutButton.tsx',
  'routes/Login.tsx',
]);

describe('components reach tokens by name, not by arbitrary value', () => {
  it('has no [var(--…)] utility (including type-hinted forms) outside the named exemptions', () => {
    const offenders = tsxFiles(SRC)
      .filter((path) => !EXEMPT_PATHS.has(path.slice(SRC.length + 1)))
      .flatMap((path) => {
        const hits = readFileSync(path, 'utf8').match(/\[(?:[a-z]+:)?var\(--[a-z-]+\)\]/g) ?? [];
        return hits.map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });
});
