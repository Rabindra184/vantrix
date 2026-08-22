/**
 * The table look, in one place.
 *
 * ADOPTED by three of the app's six tables: `StatisticsTable.tsx`,
 * `ErrorsTable.tsx`, and every chart's `charts/DataTable.tsx`. A density
 * change to these three now has to be made once and agreed once, rather than
 * three times.
 *
 * NOT (yet) adopted by the other three — `RunList.tsx`, `RunDetail.tsx`'s
 * Assertions table, and `tables/ScopedStatistics.tsx` — which keep their own
 * `py-2 pr-4` density and left-aligned numerics. That is deliberate
 * deferral, not an oversight: none of the three was in this sub-project's
 * scope, and widening a fix wave to migrate them is exactly the kind of
 * scope creep this codebase's process tries to avoid. A future sub-project
 * that touches those pages can adopt these styles then.
 *
 * ── That future sub-project is this one. All six now use these styles, and
 * the paragraph above is kept because the reasoning it records is still the
 * reason the split existed. What changed is that the design pass has every
 * table on screen at once as its subject, so "make it once and agree it once"
 * finally applies to all of them.
 *
 * WHAT THE DESIGN PASS ADDED, and why each is not decoration:
 *
 *   `SCROLLER` — the wrapper every table now needs. A 13-column statistics
 *   table does not fit a phone and cannot be made to; the honest treatment is
 *   to let it scroll in its own box rather than let it widen the PAGE, which
 *   is what pushes the header off-screen and breaks every other row on the
 *   page. `tabIndex={0}` on it is load-bearing: a scroll container that is not
 *   focusable cannot be scrolled by keyboard at all, which is a real WCAG
 *   2.1.1 failure and the commonest one in dashboards.
 *
 *   `TH` IS NOT STICKY, and that is a correction rather than an omission. It
 *   was written `sticky top-0` first, for the obvious reason — scrolling 200
 *   request rows past a header that has left the viewport turns every column
 *   into a guess. It does not work here and would have shipped as a comment
 *   claiming a behaviour the page does not have. `SCROLLER` sets
 *   `overflow-x: auto`, and CSS resolves the other axis of an
 *   overflow pair to `auto` when only one is `visible` — so the wrapper is a
 *   scroll container in BOTH axes, and `top-0` sticks to the top of a box that
 *   is never itself scrolled vertically (it has no height limit; the PAGE
 *   scrolls). The header would simply never move. Making it real needs a
 *   max-height on the scroller, which trades a header that follows you for a
 *   table you can only see six rows of at a time — a worse deal on a page
 *   whose whole purpose is the table.
 *
 *   `ROW` gains a hover. In a 13-column row the eye loses the line between the
 *   name on the left and the p99 on the right; a full-row tint is what carries
 *   it across. It is a background change only — never a border or a font
 *   change, which would reflow the row under the pointer.
 *
 *   `TD_NUM` is MONO and tabular. It was already right-aligned, which is half
 *   of it: right alignment lines up the decimal point, and tabular figures
 *   line up every digit above it, so a column of response times can be
 *   compared by length as well as by reading. This is the same argument
 *   `StatTile` makes for the six headline numbers.
 */

/**
 * The horizontal scroll box a table lives in.
 *
 * Pair it with `tabIndex={0}` and a `role="region"` + `aria-label` on the
 * element that carries it, so the scrollable area is reachable and named.
 */
export const SCROLLER = '-mx-1 overflow-x-auto px-1 pb-1';

export const TABLE = 'w-full border-collapse text-left text-[13px]';
export const THEAD = 'bg-sunken';
/**
 * A column heading.
 *
 * `uppercase`, MONO AND WIDE-TRACKED — the instrument-panel column label the
 * control-room redesign draws.
 *
 * This constant carried the OPPOSITE rule for most of its life ("NOT
 * `uppercase`… Playwright's accessible-name computation APPLIES
 * `text-transform`, so `Percentage` becomes `PERCENTAGE` and every
 * `getByRole('columnheader', { name, exact: true })` breaks at once"). That
 * was re-measured on Playwright 1.62.1 and does not reproduce: with
 * `uppercase` on this constant the full e2e suite passes 94/94, including
 * `run-tables.spec.ts`'s exact-name columnheader sweep.
 *
 * `text-transform` is a RENDERING property — `th.textContent` is still
 * `Percentage`, so the computed name is unchanged and a screen reader reads
 * the sentence-case word rather than spelling out capitals. See CLAUDE.md's
 * corrected note for the measurement and for what genuinely IS still unsafe:
 * uppercasing the DATA or an `aria-label`, which is what the name is made of.
 */
export const TH =
  'bg-sunken px-3 py-2 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase whitespace-nowrap';
/**
 * A NUMERIC column heading — `TH` plus the right alignment its cells already
 * have.
 *
 * THE PAIRING IS THE RULE: a `TD_NUM` cell is right-aligned, so a `TH` above
 * it must be too, or the heading sits at one edge of the column and every
 * value at the other. On the statistics table that was thirteen columns of it
 * — "Total" at the left edge, `895` at the right, with the eye asked to bridge
 * a gap that widens with the column. Nothing failed, because alignment is not
 * something any of these tables assert on and jsdom lays out nothing.
 *
 * `CompareMatrix` had already written `${TH} text-right` inline, which is what
 * this constant is: the same fix, named once, so the next table gets it by
 * reaching for the right constant rather than by remembering.
 *
 * Use `TH` for a text column (a name, a message, a status) and `TH_NUM`
 * wherever the cells below are `TD_NUM`.
 */
export const TH_NUM =
  'bg-sunken px-3 py-2 text-right font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase whitespace-nowrap';

/**
 * A heading that SPANS a group of numeric columns (`colSpan` > 1).
 *
 * Centred, not right-aligned: it names the whole group rather than any one
 * column, and right-aligning it would park "EXECUTIONS" over the last of its
 * five columns, which reads as a label for that column. Left-aligned — what it
 * was — parks it over the FIRST, with the same wrong reading.
 */
export const TH_GROUP =
  'bg-sunken px-3 py-2 text-center font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase whitespace-nowrap';

export const ROW = 'transition-ui border-b border-divider last:border-0 hover:bg-sunken';

/**
 * A TOTALS row — the run's own aggregate, structurally apart in its own
 * `<tbody>`.
 *
 * TWO THINGS `ROW` ALONE GETS WRONG HERE, and both were live.
 *
 * `border-b` rather than relying on `ROW`: `last:border-0` matches the last
 * row OF ITS OWN `<tbody>`, and a totals row alone in its own body is always
 * that row. So the one row that most needs a rule under it was the only row in
 * the table without one — a silent consequence of the two-body structure,
 * because `last:border-0` reads as "the last row of the table" and is not.
 *
 * `bg-sunken` because font-weight alone is not a distinction a reader can use.
 * A totals row differing from thirteen columns of mono digits only by being
 * semibold is a difference you have to already know about to see; the fill is
 * what makes it read as a summary band at a glance, and it ties the row to the
 * `THEAD` above it, which carries the same fill. Colour is not doing this
 * alone — the weight stays, and the row is in its own `<tbody>` for anything
 * listening rather than looking.
 */
export const ROW_TOTAL = 'border-b border-divider bg-sunken font-semibold';

export const TD = 'px-3 py-2 align-middle';
export const TD_NUM = 'px-3 py-2 text-right align-middle font-mono tabular-nums whitespace-nowrap';

/**
 * A `<th scope="row">` cell — the row's own name or message, not a column
 * heading. It sits in the same row as `TD`/`TD_NUM` cells and has to line up
 * with them, so it takes `TD`'s spacing; `TH` is wrong here because it is
 * bold, and a `<th>` goes bold on every row by browser default with nothing
 * to say otherwise, which is exactly wrong for a row that is not a total.
 * `font-normal` is what cancels that default. Needed identically in all three
 * tables — the statistics table's row name, the errors table's message, and
 * the chart data table's row label — which is what earns it a name here
 * rather than three copies of the same three words.
 */
export const TH_ROW = 'px-3 py-2 align-middle font-normal';

/**
 * The caption above a table.
 *
 * `caption-top` is not the browser default — a `<caption>` renders BELOW the
 * table in some engines and above in others unless told — and these captions
 * are explanatory sentences the reader needs before the data, not after it.
 */
export const CAPTION = 'caption-top pb-3 text-left text-[13px] leading-relaxed text-muted';

/**
 * A text input.
 *
 * Lives here rather than in a `<Input>` component because the two inputs in
 * this app — the statistics filter and the login form's two fields — each
 * already have their own `<label htmlFor>`, id and change handler written out,
 * and a wrapper would either re-declare those props or hide them. What was
 * actually duplicated is the LOOK, and that is what this is.
 *
 * `h-8` with the 14px body size, and no `text-` class of its own: the
 * 16px-on-mobile rule that stops iOS Safari zooming on focus is applied
 * globally in `tokens.css` to `input, select, textarea` under a max-width
 * media query, so an explicit size here would override it and re-introduce
 * the zoom.
 *
 * `bg-sunken`, NOT `bg-surface`, and the difference is the whole affordance.
 * Every input in this app sits inside a card, and a card IS `bg-surface` —
 * so a field painted the same colour as its container has no fill at all,
 * only a hairline, and reads as an outlined box rather than as somewhere to
 * type. A recessed well is what says "this is an input", which is why the
 * redesign draws fields one step DOWN from the surface they sit on.
 */
export const INPUT =
  'transition-ui h-8 w-full min-w-0 rounded-lg border border-default bg-sunken px-2.5 ' +
  'placeholder:text-muted hover:border-muted';
