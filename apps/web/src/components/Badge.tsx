import type { Mark } from '../routes/marks';

/**
 * `Marked` in pill form, and deliberately NOT a second vocabulary: it takes the
 * same `Mark`, so a status that gains a glyph or changes a word changes in one
 * place and both renderings follow.
 *
 * The colour is the mark's TEXT colour (`--color-status-*`), which is gated at
 * 4.5:1 against the card — the brighter `--chart-status-*` values are for
 * fills, and would fail here.
 *
 * THE FILL AND THE BORDER ARE DERIVED FROM THAT SAME COLOUR, by `tint`
 * (`tokens.css`), which is `color-mix(in oklab, currentColor …)`. A pill drawn
 * as coloured text inside a neutral `border-default` reads as a generic chip
 * that happens to have coloured text; a tonal wash reads as a status. Deriving
 * it rather than adding `--color-status-*-bg` tokens matters for three
 * reasons: there is no fourth copy of the status palette to keep in step with
 * `theme.ts` and `tokens.css`; the wash is correct in both themes for free,
 * because it is mixed from a value that already moves with the theme; and
 * `Badge` still does not need to know WHICH status it is drawing, which is the
 * property that lets `ProjectRail` hand it a rail-local override
 * (`RAIL_INGEST_FAILED`) with no change here.
 *
 * `style={{ color: mark.colour }}` STAYS ON THE ELEMENT WHOSE OWN DIRECT TEXT
 * NODE IS THE LABEL. That is what `test/Badge.test.tsx`'s colour assertion
 * resolves — `getByText('failed')` returns this span, because the glyph is a
 * nested element and does not count toward this node's own text — and it is
 * also what `currentColor` in `tint` reads. Wrapping the label in an inner
 * span would break both at once, silently.
 */
export default function Badge({ mark }: { readonly mark: Mark }) {
  return (
    // An LED readout, per the control-room redesign: squared corners and the
    // mono face are what separate a status STAMP from the rounded, sans
    // controls that share these rows. `rounded-md`, not `rounded-full` — the
    // pill silhouette moved to interactive chips, and a status is not one.
    // The label's case is whatever the mark data carries: `text-transform`
    // here would change the accessible name Playwright computes (CLAUDE.md's
    // uppercase rule), so the LED look leans on face and tracking instead.
    <span
      className="tint inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em] uppercase"
      style={{ color: mark.colour }}
    >
      {/* `aria-hidden`, and the word beside it carries the meaning — a screen
          reader announcing "white heavy check mark passed" says it twice, once
          badly. Sized in `em` so the shape tracks the label rather than being
          a second thing to keep in step with the font size. */}
      <span aria-hidden="true" className="text-[0.9em] leading-none">
        {mark.glyph}
      </span>
      {mark.label}
    </span>
  );
}
