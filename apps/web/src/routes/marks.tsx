import type { AssertionOutcome, RunStatus, RunVerdict } from '@perfportal/contracts';

/**
 * The one vocabulary this app uses to render a status, a verdict or an
 * assertion outcome.
 *
 * Lifted out of RunList.tsx unchanged when the run detail page needed the
 * same three treatments. Copying it would have meant two lists of glyphs
 * drifting apart — and the one place drift would be least visible is exactly
 * the one that matters most here: a `not_applicable` that reads as a pass on
 * one screen and not the other is worse than one that reads wrong on both,
 * because nothing looks broken.
 */

/** A shape, a word, and a colour — in that order of importance. */
export type Mark = { glyph: string; label: string; colour: string };

/**
 * Text plus SHAPE, never colour alone (brief; WCAG 2.2 AA 1.4.1). Colour is
 * present and useful, but it is the third signal, not the only one: a
 * colour-blind reader, a monochrome print-out, or a user with a forced-colour
 * theme still tells ✓ passed from ✕ failed, because the glyph and the word
 * both say so.
 *
 * The glyph is `aria-hidden` — the word beside it already carries the
 * meaning, and a screen reader announcing "white heavy check mark passed"
 * says it twice, once badly.
 */
export function Marked({ mark }: { mark: Mark }) {
  return (
    <span style={{ color: mark.colour }}>
      <span aria-hidden="true">{mark.glyph}</span> {mark.label}
    </span>
  );
}

export const STATUS: Record<RunStatus, Mark> = {
  pending: { glyph: '○', label: 'pending', colour: 'var(--color-status-pending)' },
  parsing: { glyph: '◐', label: 'parsing', colour: 'var(--color-status-pending)' },
  // Pending-shaped, not terminal (RunStatusSchema, packages/contracts/src/run.ts)
  // -- same 202-poll family as pending/parsing, so it shares their colour. The
  // glyph continues the fill sequence pending/parsing already started (empty,
  // half) rather than reusing either: a live run streaming in is further along
  // than a bundle still being parsed, and the two states must read as visibly
  // different while a reader is watching one tick over into the other.
  running: { glyph: '◕', label: 'running', colour: 'var(--color-status-pending)' },
  complete: { glyph: '●', label: 'complete', colour: 'var(--color-status-passed)' },
  failed: { glyph: '✕', label: 'failed', colour: 'var(--color-status-failed)' },
  // Terminal (its data is retained, nothing further will happen to it), but
  // neither `complete`'s success nor `failed`'s error -- it stopped without
  // its producer saying why. Its verdict is always not_evaluated (run.ts), so
  // this borrows THAT verdict's colour rather than passed/failed's, and a
  // dotted, gapped circle rather than a solid one: the run has holes in it,
  // literally the reason its own SLA verdict cannot be trusted.
  incomplete: { glyph: '◌', label: 'incomplete', colour: 'var(--color-status-not-applicable)' },
};

/**
 * `none` is a NULL verdict, which is not the same thing as `not_evaluated`:
 * null means the run never got far enough to be judged, while
 * `not_evaluated` means it finished and no SLA rule applied to it. Flattening
 * the two would tell a user their still-pending run had been assessed.
 */
export const VERDICT: Record<RunVerdict | 'none', Mark> = {
  passed: { glyph: '✓', label: 'passed', colour: 'var(--color-status-passed)' },
  failed: { glyph: '✕', label: 'failed', colour: 'var(--color-status-failed)' },
  not_evaluated: {
    glyph: '○',
    label: 'not evaluated',
    colour: 'var(--color-status-not-applicable)',
  },
  none: { glyph: '–', label: 'no verdict yet', colour: 'var(--color-status-not-applicable)' },
};

/**
 * A single SLA rule's outcome — and the reason this module has a test of its
 * own in the e2e suite.
 *
 * `not_applicable` gets its OWN glyph, its own word and its own colour, none
 * of them `passed`'s. The ingest spine introduced this outcome deliberately:
 * "we checked and it was fine" and "we could not check" are different facts,
 * and a rule that could not be evaluated is not a rule that passed
 * (packages/sla/src/evaluate.ts). A UI that renders the two the same way
 * undoes that decision silently, and the person reading the report never
 * learns their SLA never ran.
 *
 * `○` is the same glyph the run-level `not_evaluated` verdict carries above,
 * on purpose — that verdict is precisely what a run made entirely of
 * `not_applicable` assertions produces, so the header and the table are
 * saying the same thing in the same shape.
 */
export const ASSERTION_OUTCOME: Record<AssertionOutcome, Mark> = {
  passed: { glyph: '✓', label: 'passed', colour: 'var(--color-status-passed)' },
  failed: { glyph: '✕', label: 'failed', colour: 'var(--color-status-failed)' },
  not_applicable: {
    glyph: '○',
    label: 'not applicable',
    colour: 'var(--color-status-not-applicable)',
  },
};
