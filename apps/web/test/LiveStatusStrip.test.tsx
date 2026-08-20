import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveStatusStrip from '../src/routes/LiveStatusStrip';

afterEach(cleanup);

const BASE = { connected: true, partial: false, capReached: false, onRetry: () => {} };

describe('LiveStatusStrip', () => {
  it('says the run is live while it streams and the socket is up', () => {
    render(<LiveStatusStrip {...BASE} status="running" />);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);
  });

  it('says it is reconnecting, not that the run stopped', () => {
    // A dropped socket is not a finished run, and saying so would be a lie
    // about the load test rather than about this page's connection.
    render(<LiveStatusStrip {...BASE} status="running" connected={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reconnect/i);
    expect(screen.queryByText(/stopped/i)).toBeNull();
  });

  it('says streaming stopped once the run leaves running', () => {
    // Two live regions render here too — the connection sentence and the
    // `finalizing` notice both carry `role="status"` — so this is queried by
    // text, the same way the partial case below is queried by count rather
    // than by a singular `getByRole('status')` that would throw on finding
    // two.
    const { getByText } = render(<LiveStatusStrip {...BASE} status="parsing" />);
    const notice = getByText(/streaming has stopped/i);
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('live-notice-finalizing')).toBeInTheDocument();
  });

  it('the capped block REPLACES the finalizing notice, never joins it', () => {
    // `finalizing` promises "this page will refresh with the full report once
    // they are ready" — a lie the moment polling has stopped.
    render(<LiveStatusStrip {...BASE} status="parsing" capReached />);
    expect(screen.queryByTestId('live-notice-finalizing')).toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
  });

  it('calls onRetry when the reader asks', async () => {
    const onRetry = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<LiveStatusStrip {...BASE} status="parsing" capReached onRetry={onRetry} />);
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

  it('renders nothing for a pending run that has never streamed', () => {
    const { container } = render(
      <LiveStatusStrip {...BASE} status="pending" connected={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders for a pending run once polling has capped', () => {
    // The one thing a never-streamed run still needs to be told: this page has
    // stopped asking, and here is the control.
    render(<LiveStatusStrip {...BASE} status="pending" connected={false} capReached />);
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
  });
});
