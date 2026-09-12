import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Badge from '../src/components/Badge';
import { VERDICT } from '../src/routes/marks';

// WITHOUT THIS THE FILE LEAKS between cases: every `render` appends to the
// same `document.body`, so a `getByText` in one test can resolve an element
// another test mounted. It went unnoticed while each case happened to use a
// different mark — the first case to reuse one (`not evaluated`, below)
// failed with "found multiple elements" for a reason that had nothing to do
// with what it was asserting.
afterEach(cleanup);

describe('Badge', () => {
  /**
   * The glyph is decorative and the WORD carries the meaning — the same rule
   * `Marked` follows, inherited rather than re-decided. A screen reader
   * announcing "white heavy check mark passed" says it twice, once badly.
   */
  it('exposes the word and hides the glyph', () => {
    render(<Badge mark={VERDICT.passed} />);
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('✓')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders each verdict with its own word', () => {
    render(<Badge mark={VERDICT.not_evaluated} />);
    expect(screen.getByText('not evaluated')).toBeInTheDocument();
  });

  /**
   * The third signal, and the only one with no unit coverage before this: a
   * shape and a word are asserted above, but nothing checked that the mark's
   * own colour — never a chart token — actually reaches the badge as text
   * colour. Uses VERDICT.failed, not .passed, so its text ("failed") doesn't
   * collide with the first test's render still sitting in the document —
   * this file has no afterEach(cleanup), matching Card.test.tsx's existing
   * convention of picking non-colliding text over adding that machinery.
   *
   * `getByText('failed')` returns the outer span (its only direct text-node
   * child is "failed"; the glyph lives in a nested element and doesn't count
   * toward that node's own text), which is the element Badge puts
   * `style={{ color: mark.colour }}` on.
   */
  it("uses the mark's own colour as the badge's text colour", () => {
    render(<Badge mark={VERDICT.failed} />);
    expect(screen.getByText('failed').style.color).toBe(VERDICT.failed.colour);
  });

  /**
   * ═══ `compact` TRADES TRACKING, NEVER THE WORD ═══
   *
   * It exists for `ProjectRail`, whose rows are a project name plus this, and
   * where the badge's width comes out of the name's budget. The width itself
   * is a layout fact jsdom cannot see — `project-rail.spec.ts` measures that
   * in a browser. What this file owns is the part that must NOT change: a
   * narrower badge still says the whole word, because in the rail the word is
   * the only thing separating an ingest failure from an SLA failure.
   */
  it('keeps the word and the glyph contract at either size', () => {
    const { rerender } = render(<Badge mark={VERDICT.not_evaluated} size="compact" />);
    expect(screen.getByText('not evaluated')).toBeInTheDocument();
    expect(screen.getByText('○')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('not evaluated').style.color).toBe(VERDICT.not_evaluated.colour);

    // And the default is unchanged by the prop existing.
    rerender(<Badge mark={VERDICT.not_evaluated} />);
    expect(screen.getByText('not evaluated')).toBeInTheDocument();
  });

  /**
   * REVIEW m01 — THE COMPACT/DEFAULT DIFFERENCE MOVED FROM TRACKING TO PADDING.
   *
   * This used to assert that `compact` spent less letter-spacing while keeping
   * `uppercase` and `font-mono` — the LED look the control-room redesign chose.
   * That treatment is gone: 10px uppercase mono, repeated down a status column
   * and a verdict column and again in every metadata strip, read as a wall of
   * tiny stencilled labels and spent width doing it.
   *
   * The size distinction still exists and still matters, so it is still pinned
   * — it is just carried by padding and gap now, which is where the width
   * actually goes once the tracking is gone.
   */
  it('spends less padding when compact, which is where the width goes', () => {
    const { rerender } = render(<Badge mark={VERDICT.passed} />);
    const wide = screen.getByText('passed').className;
    rerender(<Badge mark={VERDICT.passed} size="compact" />);
    const tight = screen.getByText('passed').className;

    expect(wide).toContain('px-2');
    expect(wide).toContain('gap-1.5');
    expect(tight).toContain('px-1.5');
    expect(tight).toContain('gap-1');
  });

  /**
   * PINNED SO IT CANNOT SILENTLY RETURN. The mono face and the uppercase were
   * a deliberate choice once, which is exactly why removing them needs an
   * assertion: without one, the next person restoring "the LED look" changes
   * the whole product's texture and no test says a word.
   *
   * Mono is kept for what mono is FOR — run ids, commit shas, numeric columns.
   * A status word is none of those.
   */
  it('reads as a word rather than an instrument label', () => {
    render(<Badge mark={VERDICT.passed} />);
    const className = screen.getByText('passed').className;
    expect(className).not.toContain('font-mono');
    expect(className).not.toContain('uppercase');
    expect(className).toContain('text-[12px]');
  });
});
