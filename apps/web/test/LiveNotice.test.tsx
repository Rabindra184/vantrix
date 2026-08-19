import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LiveNotice from '../src/routes/LiveNotice';

afterEach(cleanup);

/**
 * §4.3/§4.4 of the part 2b design: the statistics table, the distribution
 * chart and the percentile-distribution chart cannot be live, and the page
 * as a whole cannot show its final numbers the instant a run stops
 * streaming — both are honest gaps, not failures, and this component is the
 * one place that says so.
 *
 * NEITHER STATE MAY LOOK LIKE LOADING. A spinner claims something is
 * arriving; nothing is, on any path, until the run finishes.
 */
describe('LiveNotice', () => {
  it('says what it is waiting for, not that something is loading', () => {
    render(<LiveNotice kind="withheld" subject="Statistics" />);
    expect(screen.getByText(/available when the run finishes/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says the run finished and results are being finalized', () => {
    render(<LiveNotice kind="finalizing" />);
    expect(screen.getByRole('status')).toHaveTextContent(/finalizing/i);
  });

  // The subject names WHICH thing is withheld, the same way DesktopOnly's
  // `what` does — a generic "not available yet" would leave a reader unable
  // to tell the statistics table's notice from the distribution chart's.
  it('names the withheld thing rather than a generic apology', () => {
    render(<LiveNotice kind="withheld" subject="Response time distribution" />);
    expect(screen.getByText(/Response time distribution/)).toBeInTheDocument();
  });

  /**
   * The gateway's `partial` reaching the reader at all. It parses off the
   * snapshot frame, and before this kind existed nothing rendered it — so a
   * seed with a hole in it, or one made entirely of `emptyDelta`'s zeros,
   * drew as a complete dashboard.
   */
  it('says the seed was incomplete without claiming anything is loading', () => {
    render(<LiveNotice kind="partial" />);
    expect(screen.getByRole('status')).toHaveTextContent(/missing/i);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  // No `<svg>`, anywhere, ever — CLAUDE.md's chart-figure invariant: nine
  // e2e specs count SVG elements inside a chart `<figure>` to prove it drew,
  // and an icon in a figure that wraps this notice would break that count.
  // Asserted for every kind, since any can end up inside a chart's slot.
  it('renders no svg, in any kind', () => {
    const { container: withheld } = render(<LiveNotice kind="withheld" subject="Statistics" />);
    expect(withheld.querySelector('svg')).toBeNull();
    cleanup();
    const { container: finalizing } = render(<LiveNotice kind="finalizing" />);
    expect(finalizing.querySelector('svg')).toBeNull();
    cleanup();
    const { container: partial } = render(<LiveNotice kind="partial" />);
    expect(partial.querySelector('svg')).toBeNull();
  });
});
