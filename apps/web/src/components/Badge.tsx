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
export default function Badge({
  mark,
  size = 'default',
}: {
  readonly mark: Mark;
  /**
   * `compact` for a badge sharing a NARROW row with something that matters
   * more — today only `ProjectRail`, whose rows are a project name plus this.
   *
   * ═══ WHAT IT COSTS AND WHY THAT MATTERED ═══
   *
   * The LED look is mostly letter-spacing and uppercase, and both are paid for
   * in WIDTH. In the rail that came out of the project name's budget, because
   * the badge is `shrink-0` and the name is the flexible one: at a 272px rail,
   * `ingest failed` took 119px of a 235px row and truncated "Search Service"
   * — a fourteen-character name clipped not for being long but for standing
   * next to a status word. Measured: the name needed 94px and was given 84.
   *
   * So this trades tracking and padding, NOT the word. Dropping to a glyph
   * would have been narrower still and is exactly what `RAIL_INGEST_FAILED`
   * exists to prevent: `STATUS.failed` and `VERDICT.failed` share a glyph, so
   * a glyph-only rail badge cannot say whether a bundle failed to parse or a
   * run failed its gate. The words are the disambiguation and they stay.
   */
  readonly size?: 'default' | 'compact';
}) {
  return (
    // An LED readout, per the control-room redesign: squared corners and the
    // mono face are what separate a status STAMP from the rounded, sans
    // controls that share these rows. `rounded-md`, not `rounded-full` — the
    // pill silhouette moved to interactive chips, and a status is not one.
    // The label's case is whatever the mark data carries: `text-transform`
    // here would change the accessible name Playwright computes (CLAUDE.md's
    // uppercase rule), so the LED look leans on face and tracking instead.
    <span
      className={`tint inline-flex items-center whitespace-nowrap rounded-md border font-mono text-[10px] font-medium uppercase ${
        size === 'compact'
          ? 'gap-1 px-1.5 py-0.5 tracking-[0.02em]'
          : 'gap-1.5 px-2 py-0.5 tracking-[0.08em]'
      }`}
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
