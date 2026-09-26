/**
 * How a viewer reads a run's time axes: `offset`, elapsed from the run's start
 * (Gatling Enterprise's default), or `datetime`, their own wall clock.
 *
 * A READING PREFERENCE, so per viewer and never in the URL. That is AC-DASH-4's
 * line: a shared link carries the question (the window), not how its sender
 * likes to read the answer. Stored the way `theme.ts` stores the theme and
 * `ProjectRail` its collapse: one key, every read and write inside `try`, and
 * anything unrecognised reading as the default.
 */
export type TimeAxisMode = 'offset' | 'datetime';

export const TIME_AXIS_STORAGE_KEY = 'perfportal-time-axis';

export function isTimeAxisMode(value: unknown): value is TimeAxisMode {
  return value === 'offset' || value === 'datetime';
}

/**
 * The stored mode, or `offset`, including when storage throws, which it does
 * in Safari's private mode. A preference is not worth a crash on first paint.
 */
export function readTimeAxisMode(): TimeAxisMode {
  try {
    const stored = localStorage.getItem(TIME_AXIS_STORAGE_KEY);
    return isTimeAxisMode(stored) ? stored : 'offset';
  } catch {
    return 'offset';
  }
}

export function writeTimeAxisMode(mode: TimeAxisMode): void {
  try {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, mode);
  } catch {
    // A choice that does not survive a reload is a smaller failure than one
    // that throws on the change that made it.
  }
}
