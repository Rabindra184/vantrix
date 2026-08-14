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
});
