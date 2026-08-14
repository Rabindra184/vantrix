import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/routes/format';

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
