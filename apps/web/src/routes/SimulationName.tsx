import { Fragment, type ReactNode } from 'react';

/**
 * A fully qualified simulation class, drawn so a reader finds the CLASS and
 * no line ever ends mid-word (clean UI, PR 3).
 *
 * The run lists drew it `break-all`: UAX#14 gives no break after a full stop
 * followed by a letter, so `com.acme.checkout.simulations.CheckoutPeakLoad-
 * Simulation` is one 56-character word, and `break-all` was the only thing
 * stopping it pushing p95 and Errors off screen — at the price of
 * "example.P / aritySimul / ation".
 *
 * Here the package (with its trailing dot) is a small muted line above the
 * class, and EVERY BREAK-FREE PIECE IS ITS OWN `whitespace-nowrap` SPAN,
 * joined by `<wbr>`: each package segment, and each camelCase word of the
 * class — and after `_` or `-`. A line can end only between two pieces, so
 * the column's minimum width is its longest piece: about one word, and never
 * more than `MAX_PIECE` characters (see `namePieces`).
 *
 * NOTHING SITS BETWEEN THE SPANS, so the element's text is the full name:
 * search, a text copy and every `run-simulation` text assertion still read
 * `example.ParitySimulation`.
 */
export default function SimulationName({ name }: { readonly name: string }) {
  const pieces = namePieces(name);
  return (
    <>
      {pieces.package.length > 0 && (
        <span data-name-package className="block text-[0.6875rem] font-normal text-muted">
          {joined(pieces.package)}
        </span>
      )}
      {joined(pieces.className)}
    </>
  );
}

/**
 * The break-free pieces of `name`: package segments each keeping their dot,
 * then the class split before an upper-case letter that follows a lower-case
 * letter or a digit (`v2Smoke` → `v2`, `Smoke`), and anywhere after `_` or
 * `-` (`checkout_peak` → `checkout_`, `peak`).
 *
 * THEN NO PIECE IS LONGER THAN `MAX_PIECE` (final review, Important 1). Every
 * piece is no-wrap, so a word with no boundary at all — a 45-character
 * lowercase class — would otherwise set the column's minimum to its whole
 * length, push Errors off a 768px table and widen a phone's card past the
 * screen. Cut every `MAX_PIECE` characters, it is the one name that breaks
 * mid-word, which is the honest trade for a name no reader would call words.
 */
export function namePieces(name: string): { package: string[]; className: string[] } {
  const lastDot = name.lastIndexOf('.');
  const pkg = lastDot === -1 ? '' : name.slice(0, lastDot + 1);
  const cls = lastDot === -1 ? name : name.slice(lastDot + 1);
  return {
    package: (pkg.match(/[^.]*\./g) ?? []).flatMap(words),
    className: words(cls),
  };
}

/** A piece longer than this is cut, as the last resort above. */
const MAX_PIECE = 20;

/** `text` at its word boundaries, each piece at most `MAX_PIECE` long. */
function words(text: string): string[] {
  return text
    .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[_-])/)
    .filter((piece) => piece !== '')
    .flatMap((piece) => {
      const cut: string[] = [];
      for (let i = 0; i < piece.length; i += MAX_PIECE) cut.push(piece.slice(i, i + MAX_PIECE));
      return cut;
    });
}

/** Each piece in a no-wrap span, a `<wbr>` between consecutive pieces. */
function joined(pieces: readonly string[]): ReactNode {
  return pieces.map((piece, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      <span data-name-piece className="whitespace-nowrap">
        {piece}
      </span>
    </Fragment>
  ));
}
