import { describe, expect, it } from 'vitest';
import { formatDuration, formatOffset } from '../src/routes/format';

describe('formatDuration', () => {
  /**
   * The docstring's own example: flooring a 1,900ms run reports "1s", wrong
   * by nearly a second in the direction a reader is least likely to
   * question. Rounding puts it at "2s" instead — this is the assertion that
   * fails if `Math.round` ever regresses to `Math.floor`.
   */
  it('rounds rather than floors', () => {
    expect(formatDuration(1900)).toBe('2s');
    // The other side of "rounds, not floors": a value that floors AND
    // rounds to the same second proves nothing about which one ran, so this
    // is paired with a value below the midpoint too.
    expect(formatDuration(1400)).toBe('1s');
  });

  it('renders whole seconds for a real run duration', () => {
    // The reference run's own duration (read.integration.test.ts pins
    // durationMs > 60_000) — an ordinary value with no rounding ambiguity.
    expect(formatDuration(63161)).toBe('63s');
  });

  /**
   * `durationMs` is nullable in the contract: a run whose header the parser
   * never produced has no duration at all, and a dash is the honest
   * rendering of that absence — never `0s`, which would assert a
   * measurement that was never taken.
   */
  it('is a dash, not zero, when there is no duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatOffset', () => {
  it('is zero seconds, not a dash or an empty string, at the very start of a run', () => {
    expect(formatOffset(0)).toBe('0s');
  });

  /**
   * The same rounding direction `formatDuration`'s own first test pins,
   * checked here independently: `formatOffset` rounds through its own
   * `Math.round`, not `formatDuration`'s, and a shared-looking formatter
   * that quietly forked to `Math.floor` would report "0s" here instead.
   */
  it('rounds up a sub-second offset rather than floors it to zero', () => {
    expect(formatOffset(999)).toBe('1s');
  });

  /**
   * The minute/second split's own boundary: `60_000 / 1000 = 60` total
   * seconds, and the failure mode this guards is `seconds % 60` never being
   * taken — which would print "1m 60s" instead of rolling over into the
   * next minute.
   */
  it('rolls a whole minute over into the minutes column, never "1m 60s"', () => {
    expect(formatOffset(60_000)).toBe('1m 0s');
  });

  it('renders minutes and seconds together past the first minute', () => {
    // The docstring's own worked example, and the value `SlaBanner.test.tsx`
    // also renders through the component — pinned here directly, at the
    // function, independent of anything React does with it.
    expect(formatOffset(62_000)).toBe('1m 2s');
  });
});
