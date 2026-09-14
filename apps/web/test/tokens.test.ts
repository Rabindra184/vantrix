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
 * `.ts` AS WELL AS `.tsx`, AND THE DIFFERENCE COST A GUARD ITS WHOLE POINT.
 * `tsxFiles` above collects components; class strings also live in plain `.ts`
 * modules — `components/tableStyles.ts` holds `TH`, `TD` and `ROW`, which is
 * every table cell in the app. A rule written over `tsxFiles` alone passed
 * while a reintroduced `text-[12px]` sat in the file that styles the most
 * elements of any. Red-verified exactly that way.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') || path.endsWith('.ts') ? [path] : [];
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
 *   - `components/States.tsx`, for the same reason as those two, and added
 *     with the design pass. It is the app's ONE error/empty/loading component,
 *     and the six routes that previously each wrote their own failure markup
 *     now render it instead. That direction matters for this gate
 *     specifically: without it, every route that learns to fail is a candidate
 *     for a fourth, fifth and sixth exemption. With it, the count of files
 *     allowed to paint in the status palette goes DOWN as more pages handle
 *     errors properly.
 */
const EXEMPT_PATHS = new Set([
  'routes/marks.tsx',
  'SignOutButton.tsx',
  'routes/Login.tsx',
  'components/States.tsx',
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

  /**
   * ═══ TYPE IN `rem`, SO THE READER'S OWN FONT SIZE REACHES IT ═══
   *
   * MEASURED against the built app before this rule existed: doubling the root
   * font size took the run list's `<h1>` from 20px to 40px and left the table
   * header at 12px, the row text at 13px and the rail at 13px — because
   * headings use Tailwind's rem-based `text-xl` and everything else used
   * `text-[13px]`. A reader who sets a larger default font got bigger titles
   * over unchanged 12px data.
   *
   * 230 sites carried that, against 42 relative ones. They are `rem` now, at
   * the same values (0.8125rem IS 13px at a 16px root), so nothing moved for a
   * reader who changes nothing — and everything moves together for one who
   * does. Tailwind's spacing scale was already rem, so the boxes around the
   * text were never the problem.
   *
   * A SOURCE SCAN RATHER THAN A RENDER, deliberately: jsdom computes no font
   * size at all, and the browser half — that a data cell really does scale —
   * is asserted in `run-list.spec.ts`, where a real engine can answer it. This
   * catches the regression at the place it would be written.
   *
   * COMMENTS ARE STRIPPED FIRST. This file has three recorded incidents of a
   * source-scanning guard matching the prose that documents the rule; the
   * comment right above quotes `text-[13px]` and would fail this.
   */
  it('sizes type in rem, never in absolute px', () => {
    const strip = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const offenders = sourceFiles(SRC).flatMap((path) => {
      const hits = strip(readFileSync(path, 'utf8')).match(/text-\[\d+px\]/g) ?? [];
      return hits.map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * The shell header's height is ONE decision, consumed from one token.
 *
 * It used to be three files with three spellings that had to agree — `h-14`
 * on the header (`AppShell.tsx`), `lg:top-14` plus a `3.5rem` inside a calc
 * (`ProjectRail.tsx`), and `sticky top-14` (`RunTabs.tsx`). Nothing gated the
 * agreement, and the failure it allows is invisible to jsdom: resize the
 * header and the other two keep sticking at 56px, so the translucent tab
 * strip slides UNDER the taller header — a blurry ghost band that only shows
 * while scrolling a chart page in a real browser.
 *
 * The token is the same two-name shape the colour tokens use, for the same
 * reason (`@theme`'s self-reference trap, documented at the top of
 * `tokens.css`): the runtime value is `--header-height`, and `@theme inline`
 * publishes the spacing alias under the DIFFERENT name `--spacing-header`,
 * which is what generates `h-header` / `top-header`.
 *
 * `ProjectRail`'s rail height cannot be a named utility — no spacing utility
 * expresses `calc(100dvh - token)` — so it reaches the runtime token inside
 * a calc() arbitrary value. That does not violate the `[var(--…)]` gate
 * above, and not on a technicality: the gate exists to stop tokens that HAVE
 * a published name being reached by arbitrary value, and this calc is
 * exactly the case `@theme` leaves no name for.
 */
describe('the shell header height is one token', () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

  it('declares the runtime token once and aliases it as spacing under a different name', () => {
    const tokens = read('styles/tokens.css');
    expect(tokens.match(/--header-height:\s*3\.5rem;/g)).toHaveLength(1);
    expect(tokens).toContain('--spacing-header: var(--header-height);');
  });

  it('is consumed by token in every dependent, never as a hard-coded 14 or 3.5rem', () => {
    const appShell = read('AppShell.tsx');
    const rail = read('ProjectRail.tsx');
    const tabs = read('routes/RunTabs.tsx');

    expect(appShell).toContain('h-header');
    expect(rail).toContain('lg:top-header');
    expect(rail).toContain('var(--header-height)');
    expect(tabs).toContain('top-header');

    for (const [name, source] of [
      ['AppShell.tsx', appShell],
      ['ProjectRail.tsx', rail],
      ['routes/RunTabs.tsx', tabs],
    ] as const) {
      for (const spelling of ['h-14', 'top-14', '3.5rem']) {
        expect(source.includes(spelling), `${name} still spells the header height as ${spelling}`).toBe(
          false,
        );
      }
    }
  });
});
