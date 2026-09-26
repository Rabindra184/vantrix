import { describe, expect, it } from 'vitest';
import { clockStepMs, MAX_TIME_INTERVALS } from '../src/charts/timeTicks';

describe('clockStepMs — a tick step a clock would choose', () => {
  it('ticks a two-minute run every 15 seconds, as Gatling Enterprise did', () => {
    // The spec's measured pair: elapsed 00:00:15 is wall-clock 17:12:24 on a
    // run that began 17:12:09.
    expect(clockStepMs(120_000)).toBe(15_000);
  });

  it('ticks the reference run every 10 seconds', () => {
    expect(clockStepMs(63_161)).toBe(10_000);
  });

  it('never prints 00:01:40: longer runs step in whole clock units', () => {
    expect(clockStepMs(10 * 60_000)).toBe(2 * 60_000);
    expect(clockStepMs(3_600_000)).toBe(10 * 60_000);
    expect(clockStepMs(4 * 3_600_000)).toBe(30 * 60_000);
  });

  it('never ticks finer than a second', () => {
    expect(clockStepMs(500)).toBe(1_000);
    expect(clockStepMs(0)).toBe(1_000);
  });

  it('keeps every step within the interval budget up to a month', () => {
    for (const span of [1_000, 7_000, 45_000, 90_000, 20 * 60_000, 5 * 3_600_000, 3 * 86_400_000, 30 * 86_400_000]) {
      expect(span / clockStepMs(span)).toBeLessThanOrEqual(MAX_TIME_INTERVALS);
    }
  });
});
