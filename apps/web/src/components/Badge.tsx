import type { Mark } from '../routes/marks';

/**
 * `Marked` in pill form, and deliberately NOT a second vocabulary: it takes the
 * same `Mark`, so a status that gains a glyph or changes a word changes in one
 * place and both renderings follow.
 *
 * The colour is the mark's TEXT colour (`--color-status-*`), which is gated at
 * 4.5:1 against the card — the brighter `--chart-status-*` values are for
 * fills, and would fail here.
 */
export default function Badge({ mark }: { readonly mark: Mark }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-sm"
      style={{ color: mark.colour }}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      {mark.label}
    </span>
  );
}
