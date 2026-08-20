import type { RunProcessing } from '@perfportal/contracts';
import Button from '../components/Button';
import { RefreshIcon } from '../components/icons';
import LiveNotice from './LiveNotice';

/**
 * What the PAGE is doing, on every tab.
 *
 * Mounted by `RunShell` between the tab strip and the `<Outlet/>` rather than
 * on any one tab, because a dropped socket is not a fact about Overview: a
 * reader watching Charts needs it exactly as much.
 *
 * ═══ PRECEDENCE, BECAUSE THREE THINGS COMPETE FOR THIS BAND ═══
 *
 * Capped REPLACES finalizing. `LiveNotice[kind="finalizing"]` promises "this
 * page will refresh with the full report once they are ready", which is a lie
 * the moment polling has stopped — so the capped block makes the same
 * situation readable and hands the reader the control instead.
 *
 * `partial` renders ALONGSIDE either, because it is a fact about the DATA (the
 * seed this view was built from had a hole) and the sentence above it is a
 * fact about the CONNECTION. Neither displaces the other.
 *
 * ═══ `role="status"`, NEVER `alert` ═══
 *
 * Nothing here is a problem — the same distinction `LiveNotice` and
 * `DesktopOnly` already make for their own notices.
 */
export default function LiveStatusStrip({
  status,
  connected,
  partial,
  capReached,
  onRetry,
}: {
  readonly status: RunProcessing['status'];
  readonly connected: boolean;
  readonly partial: boolean;
  /**
   * `RunDetail`'s polling cap. It can only be ACTED on once the run has
   * stopped streaming: `pollIntervalFor` exempts a `running` run from the cap
   * entirely, so while `status === 'running'` the page is still polling
   * whatever this flag says, and claiming otherwise would be the "appears to be
   * working while making no requests" failure inverted.
   */
  readonly capReached: boolean;
  readonly onRetry: () => void;
}) {
  const streaming = status === 'running';
  const frozen = status === 'parsing';

  // A pending run has never opened a socket and has nothing to say about one.
  // Rendering an empty bordered band under its tabs would be furniture.
  if (!streaming && !frozen && !capReached) return null;

  return (
    <div className="flex flex-col gap-3">
      {streaming && (
        <p role="status" className="text-[13px] text-muted">
          {connected
            ? 'Live — updating as the run streams.'
            : 'Reconnecting — showing the last update received.'}
        </p>
      )}

      {frozen && (
        <p role="status" className="text-[13px] text-muted">
          Streaming has stopped. The numbers below are its last update.
        </p>
      )}

      {frozen && !capReached && <LiveNotice kind="finalizing" />}

      {capReached && (
        <div
          role="status"
          data-testid="live-status-capped"
          className="flex flex-col items-start gap-2 rounded-xl border border-default bg-surface px-4 py-3 text-[13px] text-muted"
        >
          <p className="leading-relaxed">
            PerfPortal stopped checking automatically after two minutes. The numbers above are the
            last update this page received.
          </p>
          <Button variant="primary" size="sm" onClick={onRetry}>
            <RefreshIcon className="h-3.5 w-3.5" />
            Check again
          </Button>
        </div>
      )}

      {partial && <LiveNotice kind="partial" />}
    </div>
  );
}
