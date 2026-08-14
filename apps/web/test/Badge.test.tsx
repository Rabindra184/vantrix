import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from '../src/components/Badge';
import { VERDICT } from '../src/routes/marks';

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
});
