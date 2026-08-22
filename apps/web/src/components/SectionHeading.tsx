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
 * NOT `uppercase`, and the reason is now TYPOGRAPHIC rather than technical.
 * The old reason was that Playwright's accessible-name computation applies
 * `text-transform`, which would leave `getByRole('heading', { name:
 * 'Duration', exact: true })` — `group-detail.spec.ts` really does assert
 * that — hunting a heading named `DURATION`. That was re-measured on
 * Playwright 1.62.1 while the redesign uppercased `tableStyles.ts`'s `TH`
 * and `Badge`: the suite passes, because `text-transform` never touches
 * `textContent`. So it would be SAFE here too (see CLAUDE.md's corrected
 * note).
 *
 * It stays sentence case anyway. A section heading is prose — it names a
 * region of the page a reader is reading, and the redesign's uppercase is
 * chrome: column labels, overlines, status pills, the things that frame data
 * rather than being it. `Simulation assertions` set in capitals would read as
 * a label for the section rather than as its title.
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
