import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import RouteFallback from '../components/RouteFallback';
import { useQuery } from '@tanstack/react-query';
import TimeBrush from '../charts/TimeBrush';
import { useRunWindow, type RunWindowContext } from './useRunWindow';
import { runComparePath, runTrendsPath } from './paths';
import type { Assertion, RunIdentity, RunProcessing, RunResponse } from '@perfportal/contracts';
import { errorsQuery, usersQuery } from '../api/metrics';
import RunHeader from './RunHeader';
import { peakConcurrentUsers } from './runUsers';
import RunTabs from './RunTabs';
import LiveStatusStrip from './LiveStatusStrip';
import SlaBanner from './SlaBanner';
import RunDecisionBand from './RunDecisionBand';
import type { LiveRunState } from '../api/live';
import useDocumentTitle from '../useDocumentTitle';
import useIsCompact from '../useIsCompact';
import Button from '../components/Button';

/**
 * The chrome around one run's identity and its run-section navigation.
 *
 * A LAYOUT ROUTE, not sibling routes each rendering the page with a `tab`
 * prop. The sibling shape looks simpler and remounts this component on every
 * tab click — the header would flash and the run's queries would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 *
 * MOUNTS FOR EVERY STATUS NOW, not only a terminal run. `identity` is
 * `Partial<RunIdentity>` for exactly that reason — a pending or running run
 * supplies only what it knows at open time, the same partiality
 * `RunHeader`'s own prop already models — and `status`/`verdict`/`windowable`
 * are taken as their own props rather than read off a whole `RunResponse`,
 * because a non-terminal run has no `RunResponse` to hand this component at
 * all (`GET /v1/runs/:id` answers 202 for anything short of `complete`).
 */
export default function RunShell({
  identity,
  status,
  terminal,
  verdict,
  assertions,
  toolAssertions,
  windowable,
  live,
  capReached,
  onRetry,
}: {
  /**
   * PARTIAL, and the partiality is the point. A terminal run supplies every
   * field; a non-terminal one supplies what it knows at open time; a run read
   * from an API pod that predates the widened 202 supplies only its id. Each
   * part of `RunHeader` below renders only when its field is present.
   */
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  /**
   * RECEIVED, NOT RE-DERIVED (IMPORTANT 3). This used to be computed here as
   * `status === 'complete' || status === 'incomplete' || status === 'failed'`
   * — an allowlist that silently falls through to "not terminal" for any
   * status it does not name, which is precisely the `statusFor` trap
   * `CLAUDE.md` records: a future terminal status added to `RunStatusSchema`
   * without a matching branch HERE would render terminal tab content (the
   * metric queries below fire on `terminal`) under a live status strip and a
   * still-disabled socket, with nothing failing loudly. `RunDetail.tsx`
   * already computes this exact boolean two lines from its call here
   * (`detail.state === 'ready'`, the SAME discriminant `useRunTerminal` uses
   * for every tab) — passing it through means there is exactly one place in
   * the app that decides what "terminal" means, not two that happen to agree
   * today.
   */
  readonly terminal: boolean;
  /**
   * `undefined` means NOT EVALUATED YET and omits the badge; `null` means
   * evaluated with no verdict. `RunHeader`'s own prop draws the same
   * distinction, for the same reason.
   */
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly assertions?: readonly Assertion[];
  /** The simulation's own checks — reported beside the platform gate, never
   *  folded into it. See `RunDecisionBand`'s own prop docstring. */
  readonly toolAssertions?: RunResponse['toolAssertions'];
  /**
   * `RunResponse` only — identity carries no such field, which is exactly why
   * a live run is never offered a brush (see the `TimeBrush` block below).
   */
  readonly windowable: boolean | undefined;
  /** The live socket's state, or `null` for a run that is not streaming. */
  readonly live: LiveRunState | null;
  readonly capReached: boolean;
  readonly onRetry: () => void;
}) {
  // The run's identity, spelled the way `RunHeader`'s `<h1>` spells it — the
  // fully-qualified simulation, falling back to the short id for a run whose
  // header carried none. Two runs of the same simulation are then two tabs
  // that read alike, which is the honest rendering: the id in the breadcrumb
  // is what tells them apart, and a title long enough to include it would be
  // truncated to uselessness in a tab strip anyway.
  useDocumentTitle(identity.simulation ?? `Run ${identity.id.slice(0, 8)}`);

  // TERMINAL IS THE ONE GATE ON FETCHING, and it is now a PROP (see its own
  // docstring, IMPORTANT 3) rather than derived from `status` here. While a
  // run streams, `useLiveRun`'s `applyDelta` already writes both of these
  // keys directly; a REST fetch answers emptier for a run whose rows do not
  // exist yet, and TanStack applies whichever write resolves last. A pending
  // run has neither rows nor a socket, so `false` is right there too.

  // The Errors tab's own count, not the statistics row's `koCount`: that
  // figure is failed REQUESTS, a different number from the DISTINCT error
  // MESSAGES this tab is named after (24 vs 2 on the reference run). Reusing
  // the same `errorsQuery(identity.id)` key `RunErrorsTab` fetches means this
  // resolves from cache once that tab has ever been visited, and otherwise
  // fires the one request the count needs on its own — for a terminal run
  // only; see `terminal` above.
  const errors = useQuery({ ...errorsQuery(identity.id), enabled: terminal });

  // Read here and written here, so every tab below shares one window — and
  // declared BEFORE the fetches that key on it.
  const { window, setWindow } = useRunWindow(identity.durationMs ?? Number.MAX_SAFE_INTEGER);
  // §22.6's one JS breakpoint, read here because the brush below is a drag
  // control and a class could only hide it — leaving a phone to build a
  // 394px ECharts instance in order not to show it.
  const compact = useIsCompact();

  /* ═══ THE BRUSH ONLY WHERE A WINDOW MEANS SOMETHING ═══
   *
   * The brush lives in the shell so one selection serves every tab — which
   * also put it above the two tabs that cannot honour it. Trends' cohort query
   * is historical and takes no window; Compare's is the same. The control
   * accepted 10–30s there, announced that window, and changed nothing, so a
   * reader had no way to tell a trend line still covered the whole run.
   *
   * Withheld rather than disabled: a disabled control still asserts that a
   * window is a property of this page, which is the misreading.
   *
   * The PARAMETERS are untouched — `RunTabs` carries `from`/`to` across every
   * tab — so this hides the control without discarding the selection, and
   * Overview restores it on return. */
  const { pathname } = useLocation();
  const windowApplies =
    pathname !== runTrendsPath(identity.id) && pathname !== runComparePath(identity.id);

  // THE ONE FETCH OVERVIEW MAKES WHOSE ONLY CONSUMER HERE IS A LINE OF
  // HEADER TEXT. `/users` exists for the two charts on the Charts tab
  // (design §4b); asking for it here so the header can state a peak means
  // Overview's first paint makes one request it otherwise would not. It is
  // cached and shared under the same `usersQuery(identity.id)` key
  // `RunChartsTab` uses, and `usersQuery`'s `staleTime: Infinity`
  // (`api/metrics.ts`) is what actually makes opening Charts afterward cost
  // nothing: a completed run's `/users` payload never changes, so once this
  // fetch has resolved a later mount of the same key is never stale enough to
  // refetch — for a terminal run only; see `terminal` above.
  const users = useQuery({ ...usersQuery(identity.id, window), enabled: terminal });

  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        identity={identity}
        status={status}
        verdict={verdict}
        peakUsers={users.data ? peakConcurrentUsers(users.data) : null}
        /* THE SAME `compact` THE BRUSH BELOW READS, spent a second time —
           review M02 folds the header's secondary metadata behind a
           disclosure on a phone, and a `<details>`'s open state is the one
           thing a media query cannot set. See `RunHeader`'s own note. */
        compact={compact}
      />
      <RunDecisionBand
        identity={identity}
        status={status}
        verdict={verdict}
        assertions={assertions}
        toolAssertions={toolAssertions}
      />
      {/* `null`, not `0`, until the errors payload has actually resolved —
          the same "zero is a measurement" rule `peakUsers` above already
          follows (`runUsers.ts`). `errors.data?.errors.length ?? 0` used to
          sit here, reading "Errors (0)" for a count that had not arrived yet,
          and reading it forever if the fetch failed while the panel beneath
          it rendered `role="alert"` (`payload.tsx`'s `TableSection`) — a
          confident zero over a stated failure. */}
      <RunTabs runId={identity.id} errorCount={errors.data ? errors.data.errors.length : null} />

      {/* WHAT THE PAGE IS DOING, above the tab content and below the strip
          that selects it, so it is on screen whichever tab is open. Rendered
          only while the run is not terminal — a terminal run should never
          even be asked — but `LiveStatusStrip` does NOT always have
          something to say for a non-terminal one: a `running` run with no
          evidence yet (not connected, no delta ever received, no cap
          reached) renders nothing there, deliberately (its own docstring).
          That is the correct rendering for a compact viewport, which never
          enables the socket at all (§22.6), and for a desktop's first paint
          before the socket has opened once. Mounting the strip unconditionally
          for every non-terminal status is still right regardless — `partial`
          and the capped/finalizing states need to appear the moment they
          become true, whichever tab is open. `streamed` is EVIDENCE, not a
          derivation from `status`: `live?.lastDelta != null` is the same "a
          delta arrived this session, and that fact is never cleared" contract
          `useLiveRun` already documents elsewhere, and it is what stops a
          batch-uploaded run's `parsing` status alone from making this strip
          claim streaming ever happened. */}
      {!terminal && (
        <LiveStatusStrip
          status={status as RunProcessing['status']}
          connected={live?.connected ?? false}
          partial={live?.partial ?? false}
          capReached={capReached}
          streamed={live?.lastDelta != null}
          onRetry={onRetry}
        />
      )}

      {/* WHAT THE NUMBERS SAY, where the strip above says what the CONNECTION
          is doing. At shell level rather than on Overview: a rule breaching
          right now is a fact about the RUN, not about the tab in front of the
          reader, and someone watching Charts needs it as much as someone on
          Overview — which is the whole reason it moved here when `Live`, the
          standalone page it used to sit inside, stopped existing.

          NEVER VIEWPORT-GATED, the same call `LiveSummary` makes one component
          over: this is a few strings off a delta already in hand, not a chart,
          so §22.6's "a phone should not pay to mount ECharts" reasoning simply
          does not reach it. A phone watching a run needs to know a rule is
          breaching exactly as much as a desktop does.

          `live` is non-null only for a run in the processing union
          (`RunDetail`'s own `detail.state === 'processing' ? live : null`), so
          this needs no `terminal` gate of its own: a completed run has the
          finished report's assertions instead, and this disappears with the
          socket state that fed it. `frozen` is the same `status !== 'running'`
          flag `LiveSummary`'s Duration tile reads, and the two must never
          disagree about whether the run is still live on one render. */}
      {live?.lastDelta != null && (
        <SlaBanner sla={live.lastDelta.sla} frozen={status !== 'running'} />
      )}

      {/* ABOVE THE TABS' CONTENT, in the shell rather than in any one tab, so
          a window survives moving between them: a reader who narrows the
          charts and then opens the statistics table is still looking at the
          stretch they selected.

          OFFERED ONLY WHEN THE RUN CAN HONOUR IT. A run ingested before
          per-bucket histograms returns 400 WINDOW_UNAVAILABLE for every
          windowed call — correct of the API and useless to a reader who was
          invited to drag something. `windowable` is optional in the contract,
          so a server that predates the field is treated as unable. A live
          run never satisfies this either: identity carries no `windowable`
          at all, which is the mechanism — a live view is never narrowed,
          which is the reason (`useLiveRun`'s own module docstring). */}
      {/* ═══ NOT ON A PHONE, AND NOT SILENTLY EITHER (review M18) ═══
       *
       * Measured at 375x812 before this: the brush was 394px tall and sat
       * between the decision and the run's own numbers, which began at
       * y=1485 — two screens down. It is also a DRAG control, which is the
       * deepest kind of analysis §22.6 already calls a desktop task, and the
       * one gesture a phone is worst at.
       *
       * WITHHOLDING THE CONTROL IS NOT THE SAME AS IGNORING THE WINDOW. A
       * link carrying `?from=&to=` is exactly the link most likely to be
       * opened on a phone — somebody pasted it into a chat because of what it
       * shows — so the data stays narrowed and every tab keeps reading the
       * same range. What a compact reader loses is only the ability to DRAG a
       * new one, and dropping the control without saying so would leave them
       * reading a tenth of a run with nothing on screen admitting it. The
       * notice is one line and carries the one action that cannot be
       * reconstructed: widen back to the whole run. */}
      {windowable === true && identity.durationMs != null && windowApplies &&
        (compact ? (
          <CompactWindowNotice window={window} onClear={() => setWindow(null)} />
        ) : (
          <TimeBrush
            runId={identity.id}
            runDurationMs={identity.durationMs}
            window={window}
            // THE SNAPPED WINDOW A RESPONSE REPORTED, not the one that was
            // typed. Taken from `/users`, which this shell already fetches for
            // the header's peak-users figure — every windowed response carries
            // the same snapped range, so this needs no request of its own.
            applied={users.data?.window ?? null}
            onChange={setWindow}
          />
        ))}

      {/* THE WINDOW TRAVELS DOWN, it is not re-parsed per tab.
          Each tab used to call `useRunWindow` with its own duration, and a URL
          carrying only `?from=` then produced a DIFFERENT window object there
          than here — different query keys, so `/users` was fetched twice and
          the "one window for the whole page" this shell promises was not true.
          One parse, one object, one key. */}
      {/* The five tabs are five lazy chunks. Without a boundary here the
          nearest one is AppShell's, so the first click on Charts would
          replace the run header, the decision band and the tab strip with a
          loading line — losing the reader's place in the run they opened. */}
      <Suspense fallback={<RouteFallback />}>
        <Outlet
          context={{
            window,
            durationMs: identity.durationMs ?? null,
            // NOW REAL. This was hard-coded `null` for as long as no live run
            // reached this shell; a live run reaches it now, and this is what
            // `useTimeDomainFromShell` consults to grow the shared domain.
            liveDurationMs: live?.lastDelta?.summary.durationMs ?? null,
            live,
          } satisfies RunWindowContext}
        />
      </Suspense>
    </div>
  );
}

/**
 * The window a compact reader arrived with, and the one control they need.
 *
 * `null` — the ordinary case — renders NOTHING. A phone opening a run with no
 * window should not be told about a feature it is not being offered; the
 * notice exists for the reader who followed a narrowed link, and for nobody
 * else.
 *
 * Seconds, not milliseconds, because that is what the brush's own axis and
 * every time chart on this page label their ticks with. A notice reading
 * "10000–30000 ms" beside charts reading "10–30" would be the same number
 * spelled two ways on one screen.
 */
function CompactWindowNotice({
  window,
  onClear,
}: {
  readonly window: { readonly fromMs: number; readonly toMs: number } | null;
  readonly onClear: () => void;
}) {
  if (window === null) return null;
  const seconds = (ms: number) => Math.round(ms / 1000);
  return (
    <div
      data-testid="compact-window-notice"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem]"
    >
      <p className="text-muted">
        Showing{' '}
        <span className="text-primary tabular-nums">
          {seconds(window.fromMs)}–{seconds(window.toMs)} s
        </span>{' '}
        of this run.
      </p>
      {/* A BUTTON, not a link back to the bare URL: the window lives in the
          query string that every tab carries, and `setWindow(null)` is the one
          thing that clears it everywhere at once. */}
      <Button size="sm" variant="secondary" onClick={onClear}>
        Show whole run
      </Button>
    </div>
  );
}
