import { expect } from 'vitest';

/**
 * ═══ THE TWO CLAIMS A CHART'S "NOTHING WAS RECORDED" SENTENCE CAN MAKE ═══
 *
 * The Report's charts read the same empty payload from a run that recorded
 * nothing and from a time window that selected nothing, and the sentence under
 * the figure must be about the thing the reader asked about. A run-wide claim
 * said of a window is FALSE whenever the run recorded anything elsewhere — the
 * reference run fails 24 requests and a one-second window holding none of them
 * used to say "No requests failed in this run."
 *
 * These are asserted as CLAIMS, not as strings. The wording belongs to each
 * transform and is free to be improved; what must hold is who the sentence is
 * about, and that the tail ("so there is no distribution to show") survives the
 * switch, since that half tells the reader what they are not looking at.
 * Two helpers rather than one flag because every case is an exclusive pair:
 * the window sentence must not name the run, and the run sentence must not name
 * a window — either alone passes against a transform that ignored the flag.
 */

/** The sentence is about the selected window, and not about "this run". */
export function expectAboutTheWindow(empty: string | undefined, tail?: RegExp): void {
  expect(empty, 'an empty chart must say why').toBeTruthy();
  expect(empty).toMatch(/selected window/i);
  expect(empty).not.toMatch(/\bthis run\b/i);
  if (tail !== undefined) expect(empty).toMatch(tail);
}

/** The sentence is about the run, and a window is not mentioned. */
export function expectAboutTheRun(empty: string | undefined, tail?: RegExp): void {
  expect(empty, 'an empty chart must say why').toBeTruthy();
  expect(empty).toMatch(/\bthis run\b/i);
  expect(empty).not.toMatch(/window/i);
  if (tail !== undefined) expect(empty).toMatch(tail);
}
