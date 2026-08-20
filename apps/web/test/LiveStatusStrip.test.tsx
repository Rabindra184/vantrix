import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveStatusStrip from '../src/routes/LiveStatusStrip';

afterEach(cleanup);

/**
 * `streamed: true` by default — most cases below represent a run that WAS
 * live at some point (streaming now, or frozen having streamed earlier), the
 * scenario this strip originally had only `status` to distinguish. Cases
 * about a run that never streamed at all set `streamed: false` explicitly,
 * which is the fact CRITICAL 2 (fix round 1) added a whole prop to carry.
 */
const BASE = {
  connected: true, partial: false, capReached: false, streamed: true, onRetry: () => {},
};

describe('LiveStatusStrip', () => {
  it('says the run is live while it streams and the socket is up', () => {
    render(<LiveStatusStrip {...BASE} status="running" />);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);
    // Moved from RunDetail.live.test.tsx (Task 7): the finalizing notice is
    // gated on `frozen` (`status === 'parsing'`), so it cannot render while
    // `status` is still `running` — pinned here rather than left to follow
    // from the component's control flow alone.
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();
  });

  it('says it is reconnecting, not that the run stopped', () => {
    // A dropped socket is not a finished run, and saying so would be a lie
    // about the load test rather than about this page's connection.
    render(<LiveStatusStrip {...BASE} status="running" connected={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reconnect/i);
    expect(screen.queryByText(/stopped/i)).toBeNull();
  });

  it('says streaming stopped once the run leaves running, given evidence it streamed', () => {
    // Two live regions render here too — the connection sentence and the
    // `finalizing` notice both carry `role="status"` — so this is queried by
    // text, the same way the partial case below is queried by count rather
    // than by a singular `getByRole('status')` that would throw on finding
    // two.
    const { getByText } = render(<LiveStatusStrip {...BASE} status="parsing" streamed />);
    const notice = getByText(/streaming has stopped/i);
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('live-notice-finalizing')).toBeInTheDocument();
  });

  /**
   * CRITICAL 2 (fix round 1). Every batch-uploaded run passes through
   * `parsing` on its way to `complete` WITHOUT ever streaming — `status`
   * alone cannot tell that run apart from one that streamed and stopped.
   * Before `streamed` existed, this exact scenario made the strip claim
   * "Streaming has stopped. The numbers below are its last update." and
   * "This run has finished streaming. Finalizing the results…" for a run
   * that never streamed, with no numbers anywhere on the page for either
   * sentence to be about.
   */
  it('says NEITHER streaming sentence for a parsing run that never streamed', () => {
    render(<LiveStatusStrip {...BASE} status="parsing" streamed={false} />);
    expect(screen.queryByText(/streaming has stopped/i)).toBeNull();
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();
  });

  it('the capped block REPLACES the finalizing notice, never joins it', () => {
    // `finalizing` promises "this page will refresh with the full report once
    // they are ready" — a lie the moment polling has stopped.
    render(<LiveStatusStrip {...BASE} status="parsing" streamed capReached />);
    expect(screen.queryByTestId('live-notice-finalizing')).toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
  });

  it('calls onRetry when the reader asks', async () => {
    const onRetry = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<LiveStatusStrip {...BASE} status="parsing" streamed capReached onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('the partial notice renders ALONGSIDE, not instead', () => {
    // A partial seed is a fact about the DATA; the sentence above it is a fact
    // about the connection. Neither displaces the other.
    render(<LiveStatusStrip {...BASE} status="running" partial />);
    expect(screen.getByTestId('live-notice-partial')).toBeInTheDocument();
    // Two live regions: the connection sentence AND the partial notice. That
    // count IS the claim — `getByRole('status')` would throw on finding two,
    // and `{ name: '' }` is not a meaningful query for an unnamed region.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1);
  });

  /**
   * REVISED Ruling 2 (fix round 1). The "checks again" sentence was tried in
   * `WaitingPanel` first and reverted: that panel has no way to learn
   * `capReached`, so it could only ever say ONE thing regardless of whether
   * polling had actually stopped — which would have shown it directly under
   * THIS strip's own capped block once the cap fired, two contradictory
   * claims on screen together. Owning both halves here instead makes them
   * structurally exclusive, and closes the "pending page renders blank"
   * regression Task 7 left open: this strip now always has something to say
   * about polling for any non-terminal, non-capped, non-streaming run.
   */
  it('says the page keeps checking, not that it stopped, for a run that has never streamed', () => {
    render(<LiveStatusStrip {...BASE} status="pending" connected={false} streamed={false} />);
    expect(
      screen.getByText('This page checks again every few seconds; there is nothing to do.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('live-status-capped')).not.toBeInTheDocument();
  });

  /**
   * IMPORTANT 5 (fix round 1). `run-detail.test.ts`'s deleted "after the cap"
   * case pinned that the promise from the OTHER branch must be gone, not
   * merely joined — the same claim, now provable in one place because both
   * sentences live in the same component.
   */
  it('the capped block REPLACES the "keeps checking" sentence, never joins it', () => {
    render(
      <LiveStatusStrip {...BASE} status="pending" connected={false} streamed={false} capReached />,
    );
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(
      screen.queryByText('This page checks again every few seconds; there is nothing to do.'),
    ).not.toBeInTheDocument();
  });

  // Moved from RunDetail.live.test.tsx (Task 7), adapted to this component's
  // own props — the claim is unchanged, only its address.
  it('says nothing about a partial seed when the seed was complete', () => {
    render(<LiveStatusStrip {...BASE} status="running" partial={false} />);
    expect(screen.queryByTestId('live-notice-partial')).not.toBeInTheDocument();
  });

  // NOT moved: "says nothing about the cap while the run is still streaming"
  // held for the OLD `Live` component, whose own `frozen` gated the capped
  // block on `status !== 'running'` as well as on `capReached`. This
  // component's capped block is gated on `capReached` ALONE (see its own
  // docstring's precedence section) — Task 5/6's reviewed, accepted trade-off,
  // relying on `capReached && status === 'running'` being a caller invariant
  // RunDetail's own effect never produces (it resets `capReached` and arms no
  // timer while `running`). Asserting the old claim here would fail against
  // the current, accepted implementation; asserting the new behaviour would
  // just restate the invariant note already on this file's sibling ledger
  // entry, so it is left undone rather than added as a false or vacuous test.
  // Unaffected by fix round 1's `streamed` prop: `streaming` alone still
  // gates the connection sentence, independent of `frozen`.
});
