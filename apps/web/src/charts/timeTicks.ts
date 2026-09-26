/**
 * Tick steps a clock would choose, for an axis written as `HH:MM:SS`.
 *
 * ECharts picks a value axis' step as `nice(span / 5)`, a 1, 2, 3 or 5 × 10^k
 * number. Under clock notation that prints `00:01:40` and `00:03:20` on a
 * ten-minute run and `00:16:40` on an hour, steps no clock uses. Gatling
 * Enterprise ticks at clock steps: the spec's measured pair, elapsed
 * `00:00:15` beside wall-clock `17:12:24` on a run that began 17:12:09, is a
 * 15-second tick on a two-minute run.
 */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CLOCK_STEPS_MS: readonly number[] = [
  SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY,
];

/**
 * The most intervals an axis is cut into. Eight is what reproduces Gatling's
 * 15-second step on a two-minute run: ten-second steps would make twelve.
 */
export const MAX_TIME_INTERVALS = 8;

/**
 * The finest clock step that cuts `spanMs` into at most `MAX_TIME_INTERVALS`
 * intervals. Never finer than a second, which is also the finest thing an
 * `HH:MM:SS` label can tell apart.
 */
export function clockStepMs(spanMs: number): number {
  for (const step of CLOCK_STEPS_MS) {
    if (spanMs / step <= MAX_TIME_INTERVALS) return step;
  }
  // Longer than eight weeks: whole weeks, as many as it takes.
  return Math.ceil(spanMs / MAX_TIME_INTERVALS / (7 * DAY)) * 7 * DAY;
}
