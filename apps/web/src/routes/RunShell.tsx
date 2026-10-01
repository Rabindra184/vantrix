import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import RouteFallback from '../components/RouteFallback';
import RouteErrorBoundary from '../components/RouteErrorBoundary';
import { useQuery } from '@tanstack/react-query';
import TimeBrush from '../charts/TimeBrush';
import { TimeAxisProvider } from '../charts/TimeAxisContext';
import { useRunWindow, type RunWindowContext } from './useRunWindow';
import { runPath, runReportPath } from './paths';
import type { Assertion, RunProcessing, RunResponse } from '@perfportal/contracts';
import { usersQuery } from '../api/metrics';
import RunHeader from './RunHeader';
import RunNote from './RunNote';
import RunTabs from './RunTabs';
import LiveStatusStrip from './LiveStatusStrip';
import SlaBanner from './SlaBanner';
import RunDecisionBand from './RunDecisionBand';
import RunLifecycle from './RunLifecycle';
import { lifecycleSteps, type LifecycleIdentity } from './lifecycle';
import type { LiveRunState } from '../api/live';
import useDocumentTitle from '../useDocumentTitle';
import useIsCompact from '../useIsCompact';
import Button from '../components/Button';
import { runName } from '../runNumber';

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

/** The live Load test's span, off the socket's latest delta — the "Duration so
 *  far" tile's own `activityMs ?? durationMs` (`RunDetail`), so the strip and
 *  the tile say one number. Null without a delta. */
function liveSpanOf(live: LiveRunState | null): number | null {
  const summary = live?.lastDelta?.summary;
  return summary === undefined ? null : (summary.activityMs ?? summary.durationMs);
}

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
   * A finished run's body also carries `ingestedAt` — processing's end, not
   * an identity field — which the lifecycle strip reads; `LifecycleIdentity`
   * says so.
   */
  readonly identity: LifecycleIdentity & { readonly id: string };
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
  // A numbered run's tab names its test and its number — two tabs on two runs
  // of one test used to read alike, both titled with the simulation. A run
  // with no number keeps the title it always had: the simulation, else its
  // short id.
  useDocumentTitle(
    identity.runNumber !== null && identity.runNumber !== undefined && identity.test
      ? `${identity.test.name} · ${runName(identity.runNumber)}`
      : (identity.simulation ?? `Run ${identity.id.slice(0, 8)}`),
  );

  // TERMINAL IS THE ONE GATE ON FETCHING, and it is now a PROP (see its own
  // docstring, IMPORTANT 3) rather than derived from `status` here. While a
  // run streams, `useLiveRun`'s `applyDelta` already writes the shared metric
  // keys directly; a REST fetch answers emptier for a run whose rows do not
  // exist yet, and TanStack applies whichever write resolves last. A pending
  // run has neither rows nor a socket, so `false` is right there too.

  // Read here and written here, so every section below shares one window — and
  // declared BEFORE the fetches that key on it.
  const { window, setWindow } = useRunWindow(identity.durationMs ?? Number.MAX_SAFE_INTEGER);
  // §22.6's one JS breakpoint, read here because the brush below is a drag
  // control and a class could only hide it — leaving a phone to build a
  // 394px ECharts instance in order not to show it.
  const compact = useIsCompact();

  /* ═══ WHICH PAGE THIS IS, DECIDED ONCE ═══
   *
   * Gatling Enterprise's Summary and Report are two pages with two jobs, and
   * the shell draws around them what belongs to each: the lifecycle strip and
   * the verdict band on the Summary, the time window on the Report. Both are
   * read off the one pathname here, so what the tab strip says is current and
   * what the shell draws cannot disagree.
   *
   * THE TRAILING SLASH IS STRIPPED because `/runs/:id/` and `/runs/:id` are the
   * same page to the router and different strings to a comparison. The window
   * parameters live in the SEARCH, which `pathname` does not carry, so a
   * narrowed link still reads as the page it names. */
  const { pathname } = useLocation();
  const here = pathname.replace(/\/$/, '');
  const onSummary = here === runPath(identity.id);
  const onReport = here === runReportPath(identity.id);

  /* ═══ THE BRUSH ONLY WHERE A WINDOW MEANS SOMETHING ═══
   *
   * The window applies on the Report, where Gatling Enterprise puts it, and
   * nowhere else. Every other section answers a whole-run question — the
   * Summary never sends a window, Trends' and Compare's cohort queries are
   * historical, and Logs reads a run's events whole (`GET /v1/runs/{id}/events`
   * takes no `from`/`to`) — so a control over one of them would accept 10–30s,
   * announce that window, and change nothing: a claim about a page that
   * ignores it (review C03). This used to be a list of the sections that
   * ignored a window, and a hand-written list is how a new section gets missed;
   * a section now has to be NAMED here to be offered one.
   *
   * Withheld rather than disabled: a disabled control still asserts that a
   * window is a property of this page, which is the misreading.
   *
   * The PARAMETERS are untouched — `RunTabs` carries `from`/`to` across every
   * tab — so this hides the control without discarding the selection, and the
   * Report restores it on return. */

  // THE ONE FETCH THE SHELL MAKES, AND ITS ONLY CONSUMER IS THE BRUSH.
  // `/users` is asked for here to learn the SNAPPED window a response reports,
  // which the brush states as "Showing …" — every windowed response carries
  // the same snapped range, so any one of them will do. It shares its key with
  // the Report's Virtual users section, so while that section is open the two
  // are one request; the Report opens only Requests by default, so usually
  // this is the one. Every other section has no use for it: the Summary sends
  // no window and fetches its own unwindowed `/users` for its Peak users tile,
  // and a request from here on those pages would be paid for by every reader
  // who is not looking at a brush. `enabled` carries the gate and the hook
  // stays unconditional — a conditional call would change the hook order on
  // the very navigation between sections this shell exists to survive. For a
  // terminal run only; see `terminal` above.
  const users = useQuery({ ...usersQuery(identity.id, window), enabled: terminal && onReport });

  return (
    // THE RUN'S CLOCK, for every section and for the time window: the anchor
    // comes off the identity this shell already holds, so nothing reads the
    // run a second time to learn when it started.
    <TimeAxisProvider anchor={identity.toolStartedAt}>
    <div className="flex flex-col gap-6">
      <RunHeader
        identity={identity}
        status={status}
        verdict={verdict}
        /* THE SAME `compact` THE BRUSH BELOW READS, spent a second time —
           review M02 folds the header's secondary metadata behind a
           disclosure on a phone, and a `<details>`'s open state is the one
           thing a media query cannot set. See `RunHeader`'s own note. */
        compact={compact}
        /* `key={identity.id}`, NOT a reset-during-render inside RunNote:
           the `/runs/:runId` route is not keyed and this shell does not
           remount between runs, so without it a still-open editor's
           `editing`/`draft` state — AND an in-flight save's `useMutation`
           closure, still pointed at the OLD run id's `onSuccess` — would
           survive navigating from one run to another (Back, or the
           baseline note's "vs previous" link). A same-instance reset can
           clear the draft but cannot re-point a save already in flight;
           the key forces a fresh instance instead, so a stale save's
           `onSuccess` writes into a component that is no longer mounted. */
        note={<RunNote key={identity.id} runId={identity.id} note={identity.note} />}
      />
      <RunTabs
        runId={identity.id}
        hasLogs={identity.runnerJobId !== null && identity.runnerJobId !== undefined}
      />

      {/* WHAT THE PAGE IS DOING, above the section's content and below the strip
          that selects it, so it is on screen whichever section is open. Rendered
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
          become true, whichever section is open. `streamed` is EVIDENCE, not a
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
          is doing. At shell level rather than on the Summary: a rule breaching
          right now is a fact about the RUN, not about the section in front of
          the reader, and someone watching the Report needs it as much as
          someone on the Summary — which is the whole reason it moved here when
          `Live`, the standalone page it used to sit inside, stopped existing.

          NEVER VIEWPORT-GATED, the same call `LiveSummary` makes one component
          over: this is a few strings off a delta already in hand, not a chart,
          so §22.6's "a phone should not pay to mount ECharts" reasoning simply
          does not reach it. A phone watching a run needs to know a rule is
          breaching exactly as much as a desktop does.

          `live` is non-null only for a run in the processing union
          (`RunDetail`'s own `detail.state === 'processing' ? live : null`), so
          this needs no `terminal` gate of its own: a completed run has the
          finished report's assertions instead, and this disappears with the
          socket state that fed it. `frozen` is `status !== 'running'`: a run
          that has stopped streaming keeps its last delta, but nothing will
          re-evaluate its rules, so the banner must not claim a live
          evaluation. */}
      {live?.lastDelta != null && (
        <SlaBanner sla={live.lastDelta.sla} frozen={status !== 'running'} />
      )}

      {/* THE RUN'S JOURNEY AND ITS DECISION, ON THE SUMMARY ONLY, and BELOW the
          tab strip. Gatling Enterprise draws its strip on the Summary alone,
          under the run's title and the page's buttons; here it sits under the
          tab strip instead, so the strip stays in one place on every page
          rather than moving down by a card on one of them. The band keeps the
          release decision and its evidence; the strip says how the run got
          there (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md).

          A reader on the Report, Trends, Compare or Logs asked a different
          question — what the load looked like, how it compares, what the
          runner did — and a release verdict above each of them answered one
          they had not asked. */}
      {onSummary && (
        <>
          <RunLifecycle
            steps={lifecycleSteps({ identity, status, verdict, assertions, liveSpanMs: liveSpanOf(live) })}
            compact={compact}
          />
          <RunDecisionBand
            identity={identity}
            status={status}
            verdict={verdict}
            assertions={assertions}
            toolAssertions={toolAssertions}
          />
        </>
      )}

      {/* THE TIME WINDOW, ON THE REPORT ONLY (`onReport`, above), and in the
          shell rather than inside the Report: the window is parsed once here
          and travels down in the outlet context, so the control that writes it
          and every chart that reads it hold the same object — and a window
          survives a trip to another section and back, because the parameters
          stay in the URL while the shell stays mounted.

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
       * shows — so the data stays narrowed and the Report keeps reading the
       * same range. What a compact reader loses is only the ability to DRAG a
       * new one, and dropping the control without saying so would leave them
       * reading a tenth of a run with nothing on screen admitting it. The
       * notice is one line and carries the one action that cannot be
       * reconstructed: widen back to the whole run. */}
      {windowable === true && identity.durationMs != null && onReport &&
        (compact ? (
          <CompactWindowNotice window={window} onClear={() => setWindow(null)} />
        ) : (
          <TimeBrush
            runId={identity.id}
            runDurationMs={identity.durationMs}
            runActivityMs={identity.activityMs}
            window={window}
            // THE SNAPPED WINDOW A RESPONSE REPORTED, not the one that was
            // typed. Taken from `/users`, the one request this shell makes on
            // the Report (`users`, above) — every windowed response carries
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
      {/* Each run section is a lazy chunk. Without a boundary here the nearest
          one is AppShell's, so the first click on the Report would replace the
          run header and the tab strip with a loading line — losing the
          reader's place in the run they opened. */}
      {/* Innermost of the three: a failed SECTION chunk keeps the run header
          and the tab strip, so the reader can pick another section rather
          than losing the run. */}
      <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Outlet
          context={{
            window,
            durationMs: identity.durationMs ?? null,
            warmupMs: identity.warmupMs ?? null,
            // NOW REAL. This was hard-coded `null` for as long as no live run
            // reached this shell; a live run reaches it now, and this is what
            // `useTimeDomainFromShell` consults to grow the shared domain.
            liveDurationMs: live?.lastDelta?.summary.durationMs ?? null,
            live,
          } satisfies RunWindowContext}
        />
      </Suspense>
      </RouteErrorBoundary>
    </div>
    </TimeAxisProvider>
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
