/** One run of a Logs-tab message: plain text, or a value worth highlighting. */
export interface LogSegment {
  readonly text: string;
  readonly value: boolean;
}

/**
 * A quoted value (`'checkout load'`) or a standalone number (`1.8`, `137`),
 * the two things Gatling Enterprise's Logs tab colours. `\b` keeps digits
 * inside a word (`e0b6ec`) plain; the quoted alternative comes first, so a
 * number inside quotes stays part of its value.
 */
const VALUE = /('[^']*'|\b\d+(?:\.\d+)?\b)/;

/**
 * Splits a message into plain and value segments. `split` with a capturing
 * group puts every match at an odd index, which is the whole algorithm; the
 * empty strings it leaves at the edges are dropped.
 */
export function highlightLogMessage(message: string): readonly LogSegment[] {
  return message
    .split(VALUE)
    .map((text, index) => ({ text, value: index % 2 === 1 }))
    .filter((segment) => segment.text !== '');
}
