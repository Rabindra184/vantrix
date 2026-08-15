import type { ReactNode } from 'react';

/**
 * A section's `<h2>` — the one rung between a page's `<h1>` and a card's
 * `<h3>`.
 *
 * WHY IT NEEDED A COMPONENT. Four files rendered this heading and three
 * spellings existed: `text-xl font-semibold` (RunDetail's Assertions and
 * `payload.tsx`'s TableSection), `text-lg font-semibold` (the chart titles it
 * sat above), and `sr-only` (the Charts tab's own). The first is the same size
 * the page `<h1>` was, so the heading LADDER was flat — three levels of
 * structure rendered at two sizes, with the `<h1>` distinguishable from an
 * `<h2>` only by sitting higher up the page. The ladder is now
 * 20/24 → 16 → 15px, which is shallow on purpose: this is a dense data
 * product, not an article, and a 32px section heading above a 13px table
 * spends a whole row of vertical space on a word.
 *
 * NOT `uppercase`, for the reason `tableStyles.ts`'s `TH` is not: Playwright's
 * accessible-name computation applies `text-transform`, so
 * `getByRole('heading', { name: 'Duration', exact: true })` — which
 * `group-detail.spec.ts` really does assert — would be looking for a heading
 * named `DURATION`. jsdom would not have caught it. The overline treatment is
 * fine for a `<dt>` or a rail label, where nothing queries by accessible name;
 * it is not fine on a heading.
 */
export default function SectionHeading({
  children,
  id,
}: {
  readonly children: ReactNode;
  readonly id?: string;
}) {
  return (
    <h2 id={id} className="text-base font-semibold tracking-tight text-primary">
      {children}
    </h2>
  );
}
