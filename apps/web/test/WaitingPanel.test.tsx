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

  // NOT here (fix round 1): the "checks again every few seconds" sentence
  // moved to `LiveStatusStrip` instead — this panel has no way to learn
  // `capReached`, so it cannot avoid contradicting that strip's own capped
  // block once polling actually stops. See `LiveStatusStrip.test.tsx` and
  // this component's own docstring.
});
