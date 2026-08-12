import { describe, expect, it } from 'vitest';
import { ASSERTION_OUTCOME, STATUS, VERDICT } from '../src/routes/marks.js';

/**
 * The one invariant this whole task exists to protect, asserted against the
 * vocabulary itself rather than against a copy of it.
 *
 * The e2e suite checks the not_applicable cell as it renders, but the older of
 * those tests compares it to constants MIRRORED into the spec file — which
 * catches a change to `not_applicable` and not a change to `passed`. Moving
 * `passed`'s glyph onto `not_applicable`'s would make the two shapes identical
 * while the mirror went stale and kept reporting success.
 *
 * Comparing the two entries to EACH OTHER, here at the source, has nothing to
 * go stale. It is also the cheapest possible statement of the rule: whatever
 * these two render as, it must not be the same thing.
 */
describe('ASSERTION_OUTCOME', () => {
  /**
   * `not_applicable` is not `passed`. The ingest spine introduced the outcome
   * deliberately (packages/sla/src/evaluate.ts): "we checked and it was fine"
   * and "we could not check" are different facts, and a UI that renders them
   * identically undoes that decision silently — the reader never learns their
   * SLA never ran.
   */
  it('renders not_applicable with a different word from passed', () => {
    expect(ASSERTION_OUTCOME.not_applicable.label).not.toBe(ASSERTION_OUTCOME.passed.label);
  });

  // Text plus SHAPE, never colour alone (WCAG 2.2 AA 1.4.1). The glyph is the
  // half a colour-blind reader, a monochrome print-out or a forced-colour
  // theme still gets, so it carries the distinction on its own.
  it('renders not_applicable with a different shape from passed', () => {
    expect(ASSERTION_OUTCOME.not_applicable.glyph).not.toBe(ASSERTION_OUTCOME.passed.glyph);
  });

  it('renders failed distinctly from both', () => {
    expect(ASSERTION_OUTCOME.failed.glyph).not.toBe(ASSERTION_OUTCOME.passed.glyph);
    expect(ASSERTION_OUTCOME.failed.glyph).not.toBe(ASSERTION_OUTCOME.not_applicable.glyph);
    expect(ASSERTION_OUTCOME.failed.label).not.toBe(ASSERTION_OUTCOME.passed.label);
    expect(ASSERTION_OUTCOME.failed.label).not.toBe(ASSERTION_OUTCOME.not_applicable.label);
  });

  // Generalises the three assertions above: no two outcomes may share a
  // treatment, including pairs nobody has thought to name. Asserted on the
  // SIZE of the set so a future fourth outcome is covered the day it is added.
  it('gives every outcome its own glyph and its own label', () => {
    const marks = Object.values(ASSERTION_OUTCOME);
    expect(new Set(marks.map((m) => m.glyph)).size).toBe(marks.length);
    expect(new Set(marks.map((m) => m.label)).size).toBe(marks.length);
  });

  // Colour is the third signal and must still be present — but it is never
  // the only one, which is what the glyph/label assertions above establish.
  it('gives every outcome a colour as well', () => {
    for (const mark of Object.values(ASSERTION_OUTCOME)) {
      expect(mark.colour).toMatch(/^var\(--color-status-/);
    }
  });
});

/**
 * The same rule for the run-level tables. `not_evaluated` and `none` are the
 * pair most at risk here: null means the run never got far enough to be
 * judged, `not_evaluated` means it finished and no rule applied to it, and
 * flattening them would tell a user their still-pending run had been assessed.
 */
describe('STATUS and VERDICT', () => {
  it('gives every verdict its own glyph and its own label', () => {
    const marks = Object.values(VERDICT);
    expect(new Set(marks.map((m) => m.glyph)).size).toBe(marks.length);
    expect(new Set(marks.map((m) => m.label)).size).toBe(marks.length);
  });

  it('gives every status its own glyph and its own label', () => {
    const marks = Object.values(STATUS);
    expect(new Set(marks.map((m) => m.glyph)).size).toBe(marks.length);
    expect(new Set(marks.map((m) => m.label)).size).toBe(marks.length);
  });
});
