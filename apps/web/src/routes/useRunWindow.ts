import { useCallback, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { Window } from '@perfportal/contracts';
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
}

/** The window the shell parsed. Every tab reads it; none re-derives it. */
export const useWindowFromShell = (): Window | null =>
  useOutletContext<RunWindowContext>().window;

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
 */
export function useTimeDomainFromShell(): readonly [number, number] | undefined {
  const { window, durationMs } = useOutletContext<RunWindowContext>();
  if (window !== null) return [window.fromMs, window.toMs];
  return durationMs === null ? undefined : [0, durationMs];
}
