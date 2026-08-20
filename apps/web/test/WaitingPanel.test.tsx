import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import WaitingPanel from '../src/routes/WaitingPanel';

afterEach(cleanup);

describe('WaitingPanel', () => {
  it('says WHICH of pending and parsing is happening', () => {
    // A spinner says "something is happening". This says which — the one fact
    // a reader can act on, since a run stuck in `pending` never reached the
    // worker at all.
    render(<WaitingPanel status="pending" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it('distinguishes parsing from pending', () => {
    render(<WaitingPanel status="parsing" />);
    expect(screen.getByText(/parsing/i)).toBeInTheDocument();
  });

  it('renders no heading — the run header above it owns the h1', () => {
    render(<WaitingPanel status="parsing" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders no back link — the breadcrumb above it owns that', () => {
    render(<WaitingPanel status="pending" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says the page checks again on its own, and that there is nothing to do', () => {
    // The one sentence `Processing` used to carry that nothing else on the new
    // shell says: this is about the PAGE's own polling, not about a socket —
    // which is why it lives here rather than on `LiveStatusStrip` (that strip
    // renders nothing at all for a pending run that has never streamed).
    render(<WaitingPanel status="pending" />);
    expect(
      screen.getByText('This page checks again every few seconds; there is nothing to do.'),
    ).toBeInTheDocument();
  });
});
