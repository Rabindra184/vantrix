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
 * `marks.tsx` is exempt and stays exempt: its colour travels as DATA on a
 * `Mark`, through an inline `style`, because `Marked` and `Badge` both render
 * it. That is not a utility class and has no `@theme` equivalent.
 */
describe('components reach tokens by name, not by arbitrary value', () => {
  it('has no [var(--…)] utility outside marks.tsx', () => {
    const offenders = tsxFiles(SRC)
      .filter((path) => !path.endsWith('marks.tsx'))
      .flatMap((path) => {
        const hits = readFileSync(path, 'utf8').match(/\[var\(--[a-z-]+\)\]/g) ?? [];
        return hits.map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });
});
