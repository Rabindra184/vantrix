import { useCallback, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import type { Window } from '@perfportal/contracts';
import type { LiveRunState } from '../api/live';
import { fetchRun, runQueryKey, type RunDetail } from '../api/run';
import { parseWindow, serialiseWindow } from './window';

/**
 * The run's time window, read from the URL and written back to it.
 *
 * ONE READER FOR THE WHOLE PAGE. Every tab, table and figure takes the window
 * from here, so the statistics table and the charts above it can never be
 * showing different stretches of the same run under one heading.
 *
 * `runDurationMs` bounds it: a window is only meaningful against the run it
 * describes, and clamping here means no figure ever asks the API for time that
 * does not exist.
 */
export function useRunWindow(runDurationMs: number): {
  window: Window | null;
  setWindow: (next: Window | null) => void;
} {
  const [params, setParams] = useSearchParams();

  const window = useMemo(
    () => parseWindow(params.get('from'), params.get('to'), runDurationMs),
    [params, runDurationMs],
  );

  const setWindow = useCallback(
    (next: Window | null) => {
      const updated = new URLSearchParams(params);
      const { from, to } = serialiseWindow(next);
      // DELETED rather than set empty when the window clears: `?from=&to=`
      // would parse back to a window of zero length and leave the URL claiming
      // a selection the reader has just removed.
      if (from === undefined) updated.delete('from'); else updated.set('from', from);
      if (to === undefined) updated.delete('to'); else updated.set('to', to);
      // `replace`, so dragging a brush does not bury the previous page under
      // forty history entries.
      setParams(updated, { replace: true });
    },
    [params, setParams],
  );

  return { window, setWindow };
}

/**
 * What `RunShell` passes down through its `<Outlet>`.
 *
 * The window is parsed ONCE, in the shell, where the run's real duration is
 * known. A tab that re-parsed it would need that duration too, and the only
 * value available there is a sentinel — which is how the two came to disagree
 * for a URL carrying just `?from=`.
 */
export interface RunWindowContext {
  readonly window: Window | null;
  /**
   * The run's own span, so a tab can pin every time chart to one domain.
   *
   * Here rather than re-read per tab for the same reason `window` is: the shell
   * is where the run object lives, and a tab that fetched it again would be a
   * second source for a number the two must agree on.
   */
  readonly durationMs: number | null;
  /**
   * The run's duration as of the latest live delta, while it is still
   * streaming — `useLiveRun(...).lastDelta?.summary.durationMs` (Task 8),
   * threaded through here for the same reason `durationMs` is: a tab that
   * read its own socket would be a second source for a number every time
   * chart on the page must agree on.
   *
   * CONSULTED ONLY WHEN `durationMs` IS NULL — see `useTimeDomainFromShell`.
   * A run that has already settled is the ground truth; a stale live delta
   * left over from before it finished must never override it.
   */
  readonly liveDurationMs: number | null;
  /**
   * The live socket's state, or `null` for a run that is not streaming.
   *
   * ON THE CONTEXT RATHER THAN AS A PROP because the tabs are `<Outlet/>`
   * children: they read `runId` from `useParams` and have no prop channel from
   * the shell at all. This is the same argument `window` and `durationMs`
   * already make one field up — the shell is where the run's state lives, and
   * a tab that opened its own socket would be a second consumer of one run's
   * stream.
   */
  readonly live: LiveRunState | null;
}

/** The window the shell parsed. Every tab reads it; none re-derives it. */
export const useWindowFromShell = (): Window | null =>
  useOutletContext<RunWindowContext>().window;

/** The live socket's state, as `RunShell` observed it. Every tab reads it
 *  from here; none opens a second socket for the run it is already under. */
export const useLiveFromShell = (): LiveRunState | null =>
  useOutletContext<RunWindowContext>().live;

/**
 * ONE HOOK FOR THE `run` READ EVERY TAB (AND `RunDetail` ITSELF) NEEDS.
 *
 * Before this, `RunOverviewTab`, `RunChartsTab` and `RunErrorsTab` each wrote
 * out the identical `useQuery({ queryKey: runQueryKey(runId ?? ''), queryFn:
 * () => fetchRun(runId!), enabled: runId !== undefined })` by hand, and
 * `RunDetail` itself carried a fourth copy — with its own `refetchInterval`
 * on top, which is why that stays an OPTION here rather than being folded
 * away entirely. Four identical reads of one run inside one file were about
 * to become six once `RunTelemetry` and `RunTrends` learned to ask the same
 * question (Task 11); this is the one place that question is asked now.
 *
 * PAINTS FROM THE SAME WARM CACHE ENTRY. `runQueryKey` never varies per tab —
 * one run, one key — so whichever caller mounts first seeds the entry every
 * later one reads synchronously on its own first render, exactly as each
 * hand-written copy already did.
 *
 * `terminal` is the one gate every metric query on every tab needs:
 * `useLiveRun`'s `applyDelta` already writes the shared metric cache keys
 * directly while a run streams, and `apiFetch` has no 202 branch — so firing
 * a metric query against a non-terminal run's rows, which do not exist yet,
 * draws an error panel where `WaitingPanel` (or a live branch) belongs
 * instead.
 *
 * NOT ALSO A `status` FIELD, deliberately. A caller that needs the run's own
 * `RunProcessing['status']` (`WaitingPanel`'s prop, or `LiveSummary`'s
 * `frozen`) reads it off `detail.data.run.status` after its own
 * `detail.data.state === 'processing'` check — the same discriminated-union
 * narrowing every one of those callers already needs for its OWN fields
 * (`run.assertions`, `run.toolAssertions`, …), so a second, separately
 * -computed `status` here would either duplicate that narrowing or need an
 * unsafe assertion to use.
 */
export function useRunTerminal(
  runId: string | undefined,
  options: { readonly refetchInterval?: UseQueryOptions<RunDetail>['refetchInterval'] } = {},
): {
  readonly detail: UseQueryResult<RunDetail>;
  readonly terminal: boolean;
} {
  const detail = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    queryFn: () => fetchRun(runId!),
    enabled: runId !== undefined,
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
  return { detail, terminal: detail.data?.state === 'ready' };
}

/**
 * `[0, durationMs]` — the domain a run without a narrowed window shares while
 * its span is still growing (or has just finished growing), factored out of
 * `useTimeDomainFromShell` below into its own named function rather than
 * inlined at that hook's one call to it.
 *
 * `useTimeDomainFromShell` IS THIS FUNCTION'S ONLY PRODUCTION CALLER NOW.
 * TASK 9 C4 split this out for a SECOND site that could not reach that hook
 * at all: the standalone `Live` component `RunDetail.tsx` used to render for
 * a still-processing run computed this exact tuple directly, because it
 * mounted no `<Outlet/>` — a still-processing run rendered no `RunShell` at
 * all back then — and so had no `RunWindowContext` to read. `Live` is gone;
 * `RunShell` now mounts for EVERY run status, processing included, so there
 * is no longer a code path that needs this arithmetic and cannot reach the
 * hook.
 *
 * The export survives that second call site's deletion anyway:
 * `timeAxis.test.ts`'s "growingDomainMs and useTimeDomainFromShell agree on
 * the growing-run domain formula" case imports this function and calls it
 * directly, rather than hand-writing `[0, durationMs]` a second time as a
 * literal the hook's own implementation could silently drift from. Inlining
 * this back into `useTimeDomainFromShell` would leave that test pinning
 * nothing but its own copy of the arithmetic.
 */
export function growingDomainMs(durationMs: number): readonly [number, number] {
  return [0, durationMs];
}

/**
 * The domain every time chart on the page shares, in elapsed milliseconds —
 * §22.5's "one time axis".
 *
 * THE WINDOW WINS WHEN THERE IS ONE. A narrowed page shows only the selected
 * span, and pinning those charts to the whole run instead would draw every one
 * of them as a sliver against 90% empty axis.
 *
 * `undefined` when the run reports no duration — a run still parsing, or one
 * that never completed. Each chart then auto-scales as it did before, which is
 * the honest fallback: there is no known span to share.
 *
 * THE DOMAIN GROWS WHILE A RUN IS LIVE, THROUGH THIS SAME FUNCTION — not a
 * live-only branch. `durationMs` is null for a run still streaming, so the
 * live duration is consulted only in that gap; once the run settles,
 * `durationMs` is the ground truth and wins unconditionally. Two ways of
 * deciding this domain would be two answers to "what instant is the shared
 * crosshair on" — one for a finished run, a different one for a live one —
 * which is exactly the failure mode this file's own axis-pointer rule exists
 * to rule out.
 */
export function useTimeDomainFromShell(): readonly [number, number] | undefined {
  const { window, durationMs, liveDurationMs } = useOutletContext<RunWindowContext>();
  if (window !== null) return [window.fromMs, window.toMs];
  const span = durationMs ?? liveDurationMs;
  return span === null ? undefined : growingDomainMs(span);
}
