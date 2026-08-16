import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
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
