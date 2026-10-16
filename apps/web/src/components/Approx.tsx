import type { ReactNode } from 'react';

/**
 * ≈ before a figure an ESTIMATED run produced, and nothing before an exact
 * run's.
 *
 * A run processed before exact statistics (`statsMethod: 'estimated'`, or an
 * API that predates the field — `isExact`) reports its percentiles from the
 * retired sketch, within 1%. The caveat saying so already exists behind the
 * figure's ⓘ; this is the mark that tells a reader there IS a caveat to open,
 * without a new sentence under any title (clean UI).
 *
 * DRAWN FOR THE EYE, SPOKEN AS A WORD. A screen reader reads "≈" as "almost
 * equal to" or skips it, so the glyph is `aria-hidden` and "approximately"
 * is visually hidden beside it. Inside a `<th>` the column's accessible name
 * then reads "approximately 95th" for an estimated run — and stays exactly
 * "95th" for an exact one, which is what every name-based query over an
 * exact run's table relies on.
 *
 * Plain text, so it is safe inside a `<th>` or a heading, where an `InfoTip`
 * never is.
 *
 * `exact` IS REQUIRED, with no default: a forgotten prop would either mark an
 * exact figure as approximate or drop the mark from an estimate, and nothing
 * would fail.
 */
export function Approx({ exact, children }: { readonly exact: boolean; readonly children: ReactNode }) {
  if (exact) return <>{children}</>;
  return (
    <>
      <span aria-hidden="true">≈</span>
      <span className="sr-only">approximately</span>
      {/* The space is its own text node, outside both spans: a trailing space
          INSIDE the visually hidden one is dropped by the name computation,
          which then reads "approximately95th". */}{' '}
      {children}
    </>
  );
}
