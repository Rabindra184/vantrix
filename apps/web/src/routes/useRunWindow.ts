import { useCallback, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { Window } from '@perfportal/contracts';
import type { LiveRunState } from '../api/live';
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
 * `[0, durationMs]` — the domain a run without a narrowed window shares while
 * its span is still growing (or has just finished growing), factored out of
 * `useTimeDomainFromShell` below so it can be called from a SECOND site that
 * cannot reach that hook at all (TASK 9 C4).
 *
 * `Live` in `RunDetail.tsx` computes this exact tuple directly rather than
 * through `useTimeDomainFromShell`, because that hook reads `RunWindowContext`
 * off an `<Outlet/>` — and a still-processing run renders no `RunShell`, so
 * there is no `<Outlet/>` for `Live` to be inside of at all (see that
 * component's own docstring). The two sites cannot be UNIFIED into one call,
 * since one needs the shell's outlet context and the other structurally
 * cannot have it — but the ARITHMETIC both apply once they have a span is the
 * same formula, and leaving it written out twice would let the two silently
 * diverge with nothing to notice. Routing both through this one function is
 * what actually closes that gap: `timeAxis.test.ts`'s "Live and
 * useTimeDomainFromShell agree on the growing-run domain formula" pins it,
 * and `RunDetail.tsx`'s own call site names this function in its comment the
 * same way this one names `RunDetail.tsx`.
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
