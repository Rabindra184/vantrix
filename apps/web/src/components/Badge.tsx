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
 * `role="img"` with `aria-label={mark.label}` on the ROOT, not left implicit:
 * a bare `<span>` has the ARIA "generic" role, whose accessible-name
 * computation is prohibited outright — Chromium reports `""` for it,
 * regardless of the `aria-hidden` glyph and visible label text sitting right
 * inside it. `RunList.tsx`'s badges never surfaced this, because each one sits
 * inside a `<td>` (role "cell"), and a cell computes its OWN name from its
 * descendants' content — the label text reaches the cell's name whether or
 * not Badge's root has a role of its own. Playwright's `toHaveAccessibleName`
 * is what caught it — `dom-accessibility-api` in jsdom does not implement
 * "generic" role's name-prohibition the same way a real engine does.
 * `role="img"` makes Badge self-labelling in ANY container, table cell or not.
 *
 * `data-testid`, spelled exactly as `Card.tsx` spells it, is what makes that
 * self-labelling reachable: a caller that wraps Badge in ITS OWN
 * `<span data-testid="…">` re-introduces the generic-role gap one level up —
 * that wrapper is the element `getByTestId` resolves to, and role="img"
 * on Badge's own root does not make an ANCESTOR's name computable. Taking the
 * testid here and putting it directly on Badge's root is what avoids that.
 */
export default function Badge({
  mark,
  'data-testid': testId,
}: {
  readonly mark: Mark;
  readonly 'data-testid'?: string;
}) {
  return (
    <span
      role="img"
      aria-label={mark.label}
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-sm"
      style={{ color: mark.colour }}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      {mark.label}
    </span>
  );
}
