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
 * ═══ `frozen` NEEDS EVIDENCE, NOT JUST `status === 'parsing'` ═══
 *
 * Every BATCH-uploaded run passes through `parsing` on its way to `complete`
 * without ever streaming — `status` alone cannot tell that run apart from one
 * that streamed and then stopped. Gating `frozen` on `status === 'parsing'`
 * alone made this strip tell a batch run "Streaming has stopped. The numbers
 * below are its last update." and "This run has finished streaming.
 * Finalizing the results…" — both false: nothing ever streamed, and there
 * are no numbers anywhere on the page for either sentence to be pointing at.
 * `streamed` is the caller's evidence a socket actually delivered at least
 * one delta THIS SESSION (`RunShell` passes `live?.lastDelta != null`, the
 * same test `useLiveRun`'s own contract already relies on elsewhere) — never
 * cleared once true, which is exactly why it is the right gate for a state
 * that itself never resets once a run leaves `running`.
 *
 * ═══ PRECEDENCE, BECAUSE FOUR THINGS COMPETE FOR THIS BAND ═══
 *
 * Capped REPLACES finalizing. `LiveNotice[kind="finalizing"]` promises "this
 * page will refresh with the full report once they are ready", which is a lie
 * the moment polling has stopped — so the capped block makes the same
 * situation readable and hands the reader the control instead.
 *
 * THE "CHECKS AGAIN" SENTENCE IS THE CAPPED BLOCK'S OWN ELSE BRANCH, for a run
 * that is neither streaming nor frozen — a run this page has nothing dynamic
 * to report on yet, `pending` or a not-yet-evidenced `parsing`. It used to be
 * `Processing`'s (deleted, Task 7) and was tried once in `WaitingPanel`
 * instead; that placement was wrong for the same reason `frozen` needs
 * evidence — `WaitingPanel` cannot see `capReached` (no tab's outlet context
 * carries it), so it would keep promising "there is nothing to do" directly
 * under this strip's OWN capped block once polling had, in fact, stopped.
 * One component owning both halves of "is this page still checking on its
 * own" makes them structurally exclusive instead — the reader is told one
 * story, never two contradictory ones on the same screen. A pending or
 * not-yet-evidenced `parsing` run is never blank because of it — that is
 * exactly what this else branch (`!streaming && !frozen && !capReached`)
 * catches. A `running` run with no evidence yet — `!connected && !streamed`,
 * exactly the state a compact viewport is in (`useLiveRun` is never enabled
 * below 768px, §22.6) and the state a desktop is in before its socket has
 * opened even once — renders NOTHING here, and that silence is deliberate:
 * there is nothing true yet to say about a connection this page has not
 * evidenced, and inventing a reconnect sentence for a socket that was never
 * open would be exactly the false claim `streamed` exists to prevent, one
 * paragraph up.
 *
 * `partial` renders ALONGSIDE any of the above, because it is a fact about
 * the DATA (the seed this view was built from had a hole) and every other
 * sentence here is a fact about the CONNECTION or the POLLING. Neither
 * displaces the other.
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
  streamed,
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
  /**
   * Evidence a socket delivered at least one delta THIS SESSION — never a
   * derivation from `status` alone. See this file's own docstring on the
   * false claim `status === 'parsing'` made for a batch-uploaded run before
   * this prop existed.
   */
  readonly streamed: boolean;
  readonly onRetry: () => void;
}) {
  const streaming = status === 'running';
  const frozen = status === 'parsing' && streamed;

  return (
    <div className="flex flex-col gap-3">
      {streaming && connected && (
        <p role="status" className="text-[13px] text-muted">
          Live — updating as the run streams.
        </p>
      )}

      {/* NEEDS `streamed`, NOT JUST `!connected` (IMPORTANT 2). Below 768px
          `RunDetail` passes `enabled: false` to `useLiveRun` (§22.6) — a
          phone must not hold a socket open to draw nothing — so `connected`
          is permanently `false` and no delta will EVER arrive there, exactly
          the identical class of defect `streamed` was introduced for on the
          `frozen` branch below and, before this fix, simply was not applied
          here too. Without this gate the strip claimed a reconnect that
          would never happen on every phone, and also on a desktop's first
          paint (before the socket has opened once) and while `unauthorized`
          (which never sets a delta either) — all three read `connected:
          false, streamed: false`, and the honest thing to say about a
          connection this page never opened, or has not yet opened, is
          nothing at all. */}
      {streaming && !connected && streamed && (
        <p role="status" className="text-[13px] text-muted">
          Reconnecting — showing the last update received.
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

      {/* THE ELSE BRANCH OF `capReached`, for a run that is neither streaming
          nor (evidenced-)frozen — see this file's own docstring. Mutually
          exclusive with the capped block by construction: this page either
          promises to keep checking on its own, or says it stopped, never
          both. */}
      {!streaming && !frozen && !capReached && (
        <p role="status" className="text-[13px] text-muted">
          This page checks again every few seconds; there is nothing to do.
        </p>
      )}

      {partial && <LiveNotice kind="partial" />}
    </div>
  );
}
