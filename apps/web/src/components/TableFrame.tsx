import type { ReactNode } from 'react';
import Card from './Card';
import { CAPTION, SCROLLER } from './tableStyles';

/**
 * The card, the caption and the scroll box every table in this app sits in.
 *
 * THE PROBLEM IT SOLVES IS THE CAPTION, and it is a real one seen at 375px
 * rather than a tidiness exercise. A `<caption>` is a table-caption box, so it
 * is as wide as the TABLE — 1136px for the run list, far more for the
 * statistics table. Put that inside `overflow-x-auto` and the explanatory
 * sentence stops wrapping at the viewport and starts running off the side with
 * the columns: on a phone the reader sees "Every run in your organisation,
 * newest first, with the pro…" and has to scroll a data table sideways to
 * finish reading a paragraph. Every one of these captions is a sentence the
 * reader needs BEFORE the data — what "Started" means, what the percentages
 * are a percentage OF — so losing it is losing the point.
 *
 * THE CAPTION IS THEREFORE RENDERED TWICE, from one source:
 *
 *   - visibly, as a `<p aria-hidden="true">` OUTSIDE the scroll box, where it
 *     wraps to the card's width like any other paragraph;
 *   - programmatically, as the real `<caption class="sr-only">` inside the
 *     `<table>`, which is what gives the table its accessible name
 *     (`getByRole('table', { name: /statistics/i })`, `/errors/i`) and what
 *     `ErrorsTable.test.tsx` and `StatisticsTable.test.tsx` read the text of.
 *
 * `aria-hidden` on the visible copy is what stops that being a duplicate
 * announcement: assistive tech gets the caption once, from the element the
 * table standard says it should come from. Callers pass the SAME node to both
 * — that is the whole contract of this component — so the two cannot drift.
 *
 * `tabIndex={0}` on the scroll box is not optional. A container that scrolls
 * and cannot be focused cannot be scrolled by keyboard at all, which is a
 * WCAG 2.1.1 failure and the commonest one in dashboards. Focusable means it
 * also needs a name, hence `label` — an unnamed region is a landmark a screen
 * reader announces as nothing in particular.
 */
export default function TableFrame({
  caption,
  label,
  children,
  summary,
}: {
  /**
   * The caption, rendered in both places. Pass one node and use the SAME
   * variable for the `<caption class="sr-only">` inside `children`.
   */
  readonly caption: ReactNode;
  /** Names the scroll region, e.g. `Statistics table`. */
  readonly label: string;
  /** The `<table>`, including its own `sr-only` `<caption>`. */
  readonly children: ReactNode;
  /**
   * A short visible line, when the caption is a paragraph.
   *
   * ═══ THE EXPLANATION STOPS COMPETING WITH THE DATA (review m02) ═══
   *
   * Most tables here open with a paragraph about ingestion behaviour,
   * pagination semantics or percentile internals. The information is real and
   * worth having — but it is read ONCE and then met on every visit, above the
   * numbers somebody came for.
   *
   * When a `summary` is given, it is what shows and the full caption moves
   * behind a disclosure. THE `<caption>` ITSELF IS UNTOUCHED: it is the
   * table's accessible NAME, `ErrorsTable.test.tsx` and
   * `StatisticsTable.test.tsx` read its `textContent` for the denominator, and
   * the e2e suite finds these tables by it. Shortening the name to tidy the
   * page would break every one of those and tell a screen-reader user less
   * than a sighted one — which is the wrong direction.
   */
  readonly summary?: ReactNode;
}) {
  return (
    // `as="div"`: every caller already sits inside a `<section aria-labelledby>`
    // that names the region, and a nested unnamed `<section>` for the visual
    // frame both means nothing and breaks a `closest('section')` walk up from a
    // cell. See `Card`'s `as` prop.
    <Card as="div" padding="none">
      {summary === undefined ? (
        <p aria-hidden="true" className={`${CAPTION} px-4 pt-4`}>
          {caption}
        </p>
      ) : (
        <div aria-hidden="true" className="px-4 pt-4">
          <p className={CAPTION}>{summary}</p>
          {/* `<details>`, not a button and state: it is a native disclosure
              with native keyboard behaviour, and this is exactly the content
              it exists for. Closed by default — the whole point is that the
              prose is available rather than present. */}
          <details className="group -mt-1 pb-3">
            <summary className="w-fit cursor-pointer list-none text-[12px] font-medium text-accent hover:underline hover:underline-offset-2">
              <span className="group-open:hidden">How these numbers are counted</span>
              <span className="hidden group-open:inline">Hide the detail</span>
            </summary>
            <p className="pt-2 text-[13px] leading-relaxed text-muted">{caption}</p>
          </details>
        </div>
      )}
      <div className={SCROLLER} tabIndex={0} role="region" aria-label={label}>
        {children}
      </div>
    </Card>
  );
}
