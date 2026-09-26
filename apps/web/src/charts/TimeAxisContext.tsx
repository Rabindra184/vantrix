import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readTimeAxisMode, writeTimeAxisMode, type TimeAxisMode } from '../timeAxisPreference';

/**
 * Which clock one run's time axes read, and the instant that clock starts at.
 *
 * `anchorMs` is the run's `toolStartedAt`, and it shares its zero with every
 * series offset: the worker writes it from the engine's own run start, and
 * every series is built from that same start. So wall-clock time is exactly
 * `anchorMs + offsetMs`, with no lead-in to correct for.
 *
 * `mode` is the VIEWER'S CHOICE and `anchorMs` the RUN'S FACT. A chart reads
 * the wall clock only when both allow it; a run with no anchor reads elapsed
 * whatever was chosen.
 */
export interface TimeAxisContextValue {
  readonly mode: TimeAxisMode;
  readonly anchorMs: number | null;
  readonly setMode: (mode: TimeAxisMode) => void;
}

/**
 * Elapsed, no anchor, nothing to change. The value outside any provider, so a
 * chart rendered on its own reads as it always has, and the one `ElapsedOnly`
 * pins for a figure spanning several runs.
 */
const ELAPSED_ONLY: TimeAxisContextValue = {
  mode: 'offset',
  anchorMs: null,
  setMode: () => {},
};

const TimeAxisContext = createContext<TimeAxisContextValue>(ELAPSED_ONLY);

/**
 * One run's time axis, for everything beneath it.
 *
 * THE ANCHOR ARRIVES AS A PROP, from the run read the page already holds
 * (`RunShell`'s `identity`, a drill-down's `useRunTerminal`), so this adds no
 * query and no observer. The mode lives here, seeded from storage, so every
 * chart on a page switches together and a drill-down opened afterwards reads
 * the same choice back.
 */
export function TimeAxisProvider({
  anchor,
  children,
}: {
  /** The run's `toolStartedAt`, when it is known. */
  readonly anchor: string | null | undefined;
  readonly children: ReactNode;
}) {
  const [mode, setModeState] = useState<TimeAxisMode>(readTimeAxisMode);
  const setMode = useCallback((next: TimeAxisMode) => {
    setModeState(next);
    writeTimeAxisMode(next);
  }, []);
  const parsed = anchor == null ? Number.NaN : Date.parse(anchor);
  const anchorMs = Number.isFinite(parsed) ? parsed : null;
  const value = useMemo(() => ({ mode, anchorMs, setMode }), [mode, anchorMs, setMode]);
  return <TimeAxisContext.Provider value={value}>{children}</TimeAxisContext.Provider>;
}

/**
 * Elapsed time for everything beneath, whatever the viewer chose.
 *
 * FOR A FIGURE THAT SPANS RUNS. Compare overlays up to five, each with its own
 * wall clock and no single anchor; Gatling Enterprise's comparison stays
 * elapsed for the same reason.
 */
export function ElapsedOnly({ children }: { readonly children: ReactNode }) {
  return <TimeAxisContext.Provider value={ELAPSED_ONLY}>{children}</TimeAxisContext.Provider>;
}

/** The time axis the nearest provider describes. */
export function useTimeAxis(): TimeAxisContextValue {
  return useContext(TimeAxisContext);
}
