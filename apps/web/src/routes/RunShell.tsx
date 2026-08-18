import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import TimeBrush from '../charts/TimeBrush';
import { useRunWindow, type RunWindowContext } from './useRunWindow';
import type { RunResponse } from '@perfportal/contracts';
import { errorsQuery, usersQuery } from '../api/metrics';
import { useLiveRun } from '../api/live';
import useIsCompact from '../useIsCompact';
import RunHeader from './RunHeader';
import { peakConcurrentUsers } from './runUsers';
import RunTabs from './RunTabs';
import useDocumentTitle from '../useDocumentTitle';

/**
 * The chrome around one run's identity and its three tabs.
 *
 * A LAYOUT ROUTE, not three sibling routes each rendering the page with a
 * `tab` prop. The sibling shape looks simpler and remounts this component on
 * every tab click — the header would flash and the run query would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 */
export default function RunShell({ run }: { readonly run: RunResponse }) {
  // The run's identity, spelled the way `RunHeader`'s `<h1>` spells it — the
  // fully-qualified simulation, falling back to the short id for a run whose
  // header carried none. Two runs of the same simulation are then two tabs
  // that read alike, which is the honest rendering: the id in the breadcrumb
  // is what tells them apart, and a title long enough to include it would be
  // truncated to uselessness in a tab strip anyway.
  useDocumentTitle(run.simulation ?? `Run ${run.id.slice(0, 8)}`);

  // The Errors tab's own count, not the statistics row's `koCount`: that
  // figure is failed REQUESTS, a different number from the DISTINCT error
  // MESSAGES this tab is named after (24 vs 2 on the reference run). Reusing
  // the same `errorsQuery(run.id)` key `RunErrorsTab` fetches means this
  // resolves from cache once that tab has ever been visited, and otherwise
  // fires the one request the count needs on its own.
  const errors = useQuery(errorsQuery(run.id));

  // Read here and written here, so every tab below shares one window — and
  // declared BEFORE the fetches that key on it.
  const { window, setWindow } = useRunWindow(run.durationMs ?? Number.MAX_SAFE_INTEGER);

  // THE ONE FETCH OVERVIEW MAKES WHOSE ONLY CONSUMER HERE IS A LINE OF
  // HEADER TEXT. `/users` exists for the two charts on the Charts tab
  // (design §4b); asking for it here so the header can state a peak means
  // Overview's first paint makes one request it otherwise would not. It is
  // cached and shared under the same `usersQuery(run.id)` key `RunChartsTab`
  // uses, and `usersQuery`'s `staleTime: Infinity` (`api/metrics.ts`) is what
  // actually makes opening Charts afterward cost nothing: a completed run's
  // `/users` payload never changes, so once this fetch has resolved a later
  // mount of the same key is never stale enough to refetch. That `staleTime`
  // is load-bearing, not decorative — `main.tsx` sets no default, and
  // TanStack's own default of `0` means a newly mounted observer for
  // already-fetched data refetches on mount regardless of a shared key. This
  // comment used to claim the free reuse while that refetch was still
  // happening; the honest alternative, if the request ever matters even once
  // cached, is to drop the peak-users line, not to fetch it lazily and have
  // the header flicker a value in.
  const users = useQuery(usersQuery(run.id, window));

  // ALWAYS WIRED, gated by the design's own rule (`run.status === 'running'
  // && !useIsCompact()`, part 2b §4.1) rather than by "this shell only ever
  // renders a ready run" — that fact is true of `RunShell`'s one caller
  // today (`RunDetail`'s `Ready` branch, itself only reachable once
  // `run.status` is `complete`/`failed`/`incomplete`), so `enabled` here is
  // always false and `live.lastDelta` always null. The gate is written out
  // in full anyway: a `run` object with `status: 'running'` typechecks
  // against `RunResponse` even though today's server never serves one at
  // 200 (`RunsService.statusFor` answers 202 for anything short of
  // `complete`), and coding the literal rule rather than a hard-coded
  // `false` is what keeps this correct if that ever changes, instead of
  // silently wrong.
  const compact = useIsCompact();
  const live = useLiveRun(run.id, run.status === 'running' && !compact);

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} peakUsers={users.data ? peakConcurrentUsers(users.data) : null} />
      {/* `null`, not `0`, until the errors payload has actually resolved —
          the same "zero is a measurement" rule `peakUsers` above already
          follows (`runUsers.ts`). `errors.data?.errors.length ?? 0` used to
          sit here, reading "Errors (0)" for a count that had not arrived yet,
          and reading it forever if the fetch failed while the panel beneath
          it rendered `role="alert"` (`payload.tsx`'s `TableSection`) — a
          confident zero over a stated failure. */}
      <RunTabs runId={run.id} errorCount={errors.data ? errors.data.errors.length : null} />

      {/* ABOVE THE TABS' CONTENT, in the shell rather than in any one tab, so
          a window survives moving between them: a reader who narrows the
          charts and then opens the statistics table is still looking at the
          stretch they selected.

          OFFERED ONLY WHEN THE RUN CAN HONOUR IT. A run ingested before
          per-bucket histograms returns 400 WINDOW_UNAVAILABLE for every
          windowed call — correct of the API and useless to a reader who was
          invited to drag something. `windowable` is optional in the contract,
          so a server that predates the field is treated as unable. */}
      {run.windowable === true && run.durationMs != null && (
        <TimeBrush
          runId={run.id}
          runDurationMs={run.durationMs}
          window={window}
          // THE SNAPPED WINDOW A RESPONSE REPORTED, not the one that was
          // typed. Taken from `/users`, which this shell already fetches for
          // the header's peak-users figure — every windowed response carries
          // the same snapped range, so this needs no request of its own.
          applied={users.data?.window ?? null}
          onChange={setWindow}
        />
      )}

      {/* THE WINDOW TRAVELS DOWN, it is not re-parsed per tab.
          Each tab used to call `useRunWindow` with its own duration, and a URL
          carrying only `?from=` then produced a DIFFERENT window object there
          than here — different query keys, so `/users` was fetched twice and
          the "one window for the whole page" this shell promises was not true.
          One parse, one object, one key. */}
      {/* `liveDurationMs` reads the shell's own `live` socket above, for the
          same reason `durationMs` reads the shell's own `run`: a tab that
          asked its own `useLiveRun()` for this number would be a second
          source for a value every time chart on the page must agree on. As
          explained above, `live.lastDelta` is always null for every run this
          component renders today (a `ready` run has already left
          `running`), so `useTimeDomainFromShell` never actually consults
          this field in practice — `durationMs` is never null here either —
          but the expression is the honest one rather than a hard-coded
          placeholder. */}
      <Outlet
        context={{
          window,
          durationMs: run.durationMs ?? null,
          liveDurationMs: live.lastDelta?.summary.durationMs ?? null,
        } satisfies RunWindowContext}
      />
    </div>
  );
}
