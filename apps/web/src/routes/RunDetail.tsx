import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { linkButtonClasses } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { ErrorState, LoadingState } from '../components/States';
import { ChevronLeftIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { useLiveRun } from '../api/live';
import { POLL_CAP_MS, pollIntervalFor } from '../api/run';
import { ALL_RUNS_ROUTE } from './paths';
import { useRunTerminal } from './useRunWindow';
import RunShell from './RunShell';
import useIsCompact from '../useIsCompact';

/**
 * This module's default export renders ONE SHELL for every run state; it
 * renders neither a header nor the SLA rules itself any more. Those moved out
 * when the run page grew tabs: the header is `RunHeader`, rendered by
 * `RunShell`, and the assertions live on the Summary (`RunSummary`, which also
 * holds what the Overview and Errors tabs did; the charts are in `RunReport`).
 * What is left here is the one component that resolves the run, polls it and
 * hands the shell what it needs — the tab pages are their own modules.
 *
 * The last screen of the parity shell, and the end of the definition of done
 * — a person signs in, sees their org's runs, opens one, and reads it.
 *
 * `GET /v1/runs/:id` has three answers (see `fetchRun`): a readable run, a
 * run still being processed, and a problem. Loading and error still get their
 * own early returns below — there is no header to show and no tabs to hand a
 * window to until a run has resolved one way or the other. But a resolved,
 * non-error run — `ready` OR `processing` — now renders the SAME `RunShell`,
 * on the SAME code path, differing only in what `identity`/`status`/`verdict`/
 * `windowable`/`live` it is handed. `RunShell` is a layout route: mounting it
 * for a processing run is what makes `/runs/:id/report` and the other tab
 * URLs resolve to anything at all while a run is live, which they could not
 * do when a processing run rendered a standalone `Processing`/`Live` screen
 * with no `<Outlet/>` in it. `verdict`/`windowable` are `undefined` for a
 * processing run rather than branched on — a non-terminal run genuinely has
 * neither, and `undefined` is what `RunShell`/`RunHeader` already read as "not
 * evaluated yet" rather than "no verdict", which is what stops `0s` and "no
 * verdict yet" from appearing on screen as though they were measurements.
 */
export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();

  // The polling cap, held as state rather than computed at render time. A
  // derived `Date.now() - start > CAP` would be correct only at the moments
  // something else happens to re-render — and the whole point of the cap is
  // the moment polling STOPS, when by definition nothing else is happening.
  // A timer that sets state is what makes the message appear when it is true
  // rather than at the next unrelated render.
  const [capReached, setCapReached] = useState(false);

  // `useRunTerminal` is every tab's own read of this same query (see its own
  // docstring, `useRunWindow.ts`); this is the one copy that also needs
  // `refetchInterval` — the decision lives in api/run.ts as a pure function
  // so the cap is testable without waiting two real minutes in a browser.
  // That function also holds the OTHER half of the live exemption below: a
  // `running` run is polled whatever `capReached` says.
  const { detail: run } = useRunTerminal(runId, {
    refetchInterval: (query) => pollIntervalFor(query.state.data, capReached),
  });

  // Gated on the design's own rule (part 2b §4.1), literally:
  // `run.status === 'running' && !useIsCompact()`. `run.data` may still be
  // `undefined` on first paint, or already `ready` — `running` is false in
  // both, correctly, since there is nothing to stream for a run this page
  // is not CURRENTLY showing as running. §22.6: below 768px this page is a
  // read-only summary, and a socket held open to receive a delta every 5s
  // and draw none of it is exactly the "degrading badly" that rule exists
  // to prevent.
  const compact = useIsCompact();
  const running = run.data?.state === 'processing' && run.data.run.status === 'running';
  const live = useLiveRun(runId ?? '', running && !compact);

  // The polling cap, held as state rather than computed at render time. A
  // derived `Date.now() - start > CAP` would be correct only at the moments
  // something else happens to re-render — and the whole point of the cap is
  // the moment polling STOPS, when by definition nothing else is happening.
  // A timer that sets state is what makes the message appear when it is true
  // rather than at the next unrelated render.
  useEffect(() => {
    // Reset the FLAG as well as the timer. `[runId]` already says this
    // component instance can outlive the run it was showing (two /runs/:runId
    // locations in a row, no unmount); without this line, a second run opened
    // after the first hit the cap renders "stopped checking automatically" on
    // its first paint and never polls once.
    //
    // COVERED, finally, by `apps/web/test/RunDetail.polling.test.tsx` — both
    // halves: the timer that sets the flag, and this line that resets it for a
    // second run. That test mounts this component in jsdom and advances fake
    // timers past POLL_CAP_MS, which is what makes the two real minutes the
    // cap needs cost nothing. Until the DOM environment existed this effect
    // had no test that could fail; deleting it left every suite green.
    setCapReached(false);
    // ═══ NO TIMER AT ALL WHILE THE RUN IS STREAMING, AND `running` IS A DEP ═══
    // `pollIntervalFor`'s own exemption keeps a `running` run polling past the
    // cap, but that alone leaves a worse bug one state over: a two-hour soak
    // would trip this timer in its third minute, and the instant it stopped
    // streaming — the exact moment REST finally has something new to say —
    // polling would be capped ALREADY, so the finalizing page would never
    // reach the finished report. Arming the timer on the `running` ->
    // `!running` transition instead gives the frozen page a full, honest cap
    // window measured from when the run actually stopped.
    if (running) return;
    const timer = setTimeout(() => setCapReached(true), POLL_CAP_MS);
    return () => clearTimeout(timer);
  }, [runId, running]);

  // Not reachable through the router — `/runs/:runId` cannot match without a
  // segment — but `useParams` is typed as optional and silently rendering an
  // empty page for `undefined` would be worse than saying so.
  if (runId === undefined) return <NotARun />;

  if (run.isPending) {
    return (
      <LoadingState label="Loading run…">
        <div className="flex flex-col gap-6">
          {/* The shape the run page's first screen takes — the Summary's, which
              is where `/runs/:id` lands: heading block, tab strip, GE's four
              headline numbers, the two assertion bars, then the first chart.
              Reserving it is what stops the whole page jumping when the
              payload lands. The tile row follows `RunStats`' own grid rule
              (two across, four from `@xl` of the row's own width) rather than
              a viewport breakpoint, so a placeholder and the numbers it stands
              in for change columns at the same width. */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-80 max-w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-9 w-64" />
          <div className="@container">
            <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[92px]" />
              ))}
            </div>
          </div>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-72" />
        </div>
      </LoadingState>
    );
  }

  if (run.isError) {
    // Show what the server said — including the `remediation` every `/v1`
    // error is required to carry — rather than inventing copy. The 404 for a
    // run in another org arrives here, and the API's own sentence ("No run
    // <id> in this project.") is a better answer than a guess at one.
    const error = run.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      // `titleAs="h1"`: this branch replaces the entire page, so its title IS
      // the document's heading. `ErrorState` defaults to a paragraph for the
      // commoner case where a page keeps its own `<h1>` above the alert.
      <ErrorState
        titleAs="h1"
        title="This run could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
        remediationTestId="problem-remediation"
        action={<BackToRuns />}
      />
    );
  }

  // ONE SHELL FOR EVERY STATE. `RunDetail` used to return `Processing` or
  // `Live` INSTEAD of the shell, which is what made the run-section URLs resolve
  // to nothing while a run was live — `RunShell` is the layout route, so no
  // `<Outlet/>` mounted for them at all. Rendering it here is the whole
  // reachability fix, and it needs no router change.
  const detail = run.data;
  // Both arms of the union satisfy the shell's `LifecycleIdentity & { id }` —
  // a ready run supplies every field, `ingestedAt` included, a processing one
  // supplies what it knows — so this needs no branch, only the shared type.
  const identity = detail.run;

  return (
    <RunShell
      identity={identity}
      status={detail.run.status}
      // THE ONE PLACE THIS BOOLEAN IS DECIDED (IMPORTANT 3) — the same
      // discriminant `useRunTerminal` hands every tab, passed through rather
      // than left for `RunShell` to re-derive from `status` against its own
      // allowlist. See `RunShell`'s own `terminal` docstring for why the two
      // deciding it separately is the trap.
      terminal={detail.state === 'ready'}
      // `undefined`, not `null`, for a non-terminal run: the header omits the
      // badge rather than rendering "no verdict" over a run nobody has finished
      // measuring.
      verdict={detail.state === 'ready' ? detail.run.verdict : undefined}
      assertions={detail.state === 'ready' ? detail.run.assertions : undefined}
      toolAssertions={detail.state === 'ready' ? detail.run.toolAssertions : undefined}
      windowable={detail.state === 'ready' ? detail.run.windowable : undefined}
      live={detail.state === 'processing' ? live : null}
      capReached={capReached}
      onRetry={() => void run.refetch()}
    />
  );
}

function NotARun() {
  return (
    <ErrorState
      titleAs="h1"
      title="No run was named"
      detail="This address does not identify a run."
      action={<BackToRuns />}
    />
  );
}

/**
 * A `<Link>` wearing the secondary button's look — never a `<button>` with an
 * `onClick` that navigates. It is a destination, so it must middle-click into
 * a new tab and show its target in the status bar, which only a real anchor
 * does (see `Button`'s docstring on why there is no `asChild` escape hatch).
 *
 * To `ALL_RUNS_ROUTE`, because that is what "all runs" means — never the
 * default route, which was the same place until the home page took `/`.
 */
function BackToRuns() {
  return (
    <Link to={ALL_RUNS_ROUTE} className={`${linkButtonClasses} mt-1`}>
      <ChevronLeftIcon className="h-3.5 w-3.5" />
      Back to all runs
    </Link>
  );
}
