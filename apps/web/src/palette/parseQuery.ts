/**
 * What the command palette reads out of a typed query.
 *
 * Pure and DOM-free on purpose: the palette decides WHICH requests to make
 * from this, and a decision that costs a request has to be testable without
 * rendering one.
 */
export interface PaletteQuery {
  /** The query, trimmed. What every free-text search is made with. */
  readonly text: string;
  /**
   * `<test text> #N` — "run N of the test this names". Null for anything else.
   *
   * `text` here is the part BEFORE the `#N`, because that is what is resolved
   * to a test; `n` is the run's number within it.
   */
  readonly runNumber: { readonly text: string; readonly n: number } | null;
}

/**
 * The largest number `GET /v1/runs?number=` accepts: a run's number is an
 * `int4` column, so anything above this is refused with `INVALID_RUN_NUMBER`
 * and the palette must not ask. Spelled out because the figure is the API's,
 * not this file's.
 */
const MAX_RUN_NUMBER = 2147483647;

/**
 * Lazy `.+?` so the whole of a multi-word name is the text and `\s*` takes the
 * space before the `#`, which a reader may or may not type. At least one
 * character must precede the `#`: a bare `#12` names no test, the API refuses
 * a `number` with no test (`NUMBER_NEEDS_TEST`), and so it is plain text.
 */
const RUN_NUMBER = /^(.+?)\s*#(\d+)$/;

export function parsePaletteQuery(raw: string): PaletteQuery {
  const text = raw.trim();
  const match = RUN_NUMBER.exec(text);
  if (match === null) return { text, runNumber: null };

  const inner = (match[1] ?? '').trim();
  const n = Number.parseInt(match[2] ?? '', 10);
  // `parseInt` of an absurdly long digit string is a large float, not NaN, so
  // the ceiling catches it; the floor catches `#0` and `#00`.
  if (inner === '' || !Number.isSafeInteger(n) || n < 1 || n > MAX_RUN_NUMBER) {
    return { text, runNumber: null };
  }
  return { text, runNumber: { text: inner, n } };
}
