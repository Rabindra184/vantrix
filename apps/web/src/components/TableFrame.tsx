import type { ReactNode } from 'react';
import Card from './Card';
import InfoTip from './InfoTip';
import { SCROLLER } from './tableStyles';

/**
 * The card and the scroll box every table in this app sits in.
 *
 * ═══ IT DRAWS NO CAPTION (clean UI, PR 1) ═══
 *
 * This component used to print each table's caption above the numbers — a
 * paragraph of methodology, or a short line with the paragraph behind a "How
 * these numbers are counted" disclosure — and a reader met it on every visit.
 * Under the clean-UI text rule (docs/superpowers/specs/2026-10-04-clean-ui-design.md):
 *
 *   - the table's accessible NAME is `name`, a few words, which the caller
 *     renders as the table's own `<caption class="sr-only">`. It keeps the
 *     word each e2e query finds its table by ("Statistics", "Errors"…);
 *   - a caveat that changes how the table should be read is `info`, behind an
 *     `InfoTip` named `About ${name}` at the frame's top-right — for a table
 *     with no section heading of its own. A table that has one passes its
 *     caveat to that heading's `info` slot instead, and gives this none;
 *   - text that only restated a heading is gone.
 *
 * The props that printed prose (`caption`, `summary`) no longer exist, so no
 * caller can bring a visible paragraph back without changing this file.
 *
 * WHY THE CAPTION WAS EVER OUTSIDE THE SCROLLER is worth keeping: a
 * `<caption>` is as wide as its TABLE, not its scroll box, so inside
 * `overflow-x-auto` it stopped wrapping at the viewport and scrolled sideways
 * with the columns. The `sr-only` caption has no width to speak of, and the
 * `InfoTip` sits outside the scroller, so neither can do that now.
 */
export default function TableFrame({
  name,
  label,
  info,
  children,
}: {
  /** The table's accessible name — the SAME string the caller renders as its `<caption class="sr-only">`. */
  readonly name: string;
  /** Names the scroll region, e.g. `Statistics table`. */
  readonly label: string;
  /** A caveat about the table, for a table with no section heading to carry it. */
  readonly info?: ReactNode;
  /** The `<table>`, including its own `sr-only` `<caption>{name}</caption>`. */
  readonly children: ReactNode;
}) {
  return (
    // `as="div"`: every caller already sits inside a region that names it, and
    // a nested unnamed `<section>` for the visual frame both means nothing and
    // breaks a `closest('section')` walk up from a cell. See `Card`'s `as`.
    <Card as="div" padding="none">
      {info !== undefined && (
        <div data-testid="table-info" className="flex justify-end px-3 pt-2">
          <InfoTip label={`About ${name}`}>{info}</InfoTip>
        </div>
      )}
      <div className={SCROLLER} tabIndex={0} role="region" aria-label={label}>
        {children}
      </div>
    </Card>
  );
}
