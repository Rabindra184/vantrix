import { describe, expect, it } from 'vitest';
import {
  REPLAY_BUDGET_BYTES,
  REPLAY_MAX_ENTRIES,
  replayEntryCap,
} from '../src/live/fold-owner.js';

/**
 * The replay stream used to be capped at a flat `MAXLEN ~ 200`, which
 * bounds how many deltas it holds and nothing at all about how big they
 * are -- and a delta's size is decided by the run's shape. `users` is sent
 * whole every tick and `UserSeries` coalesces each SCENARIO against its own
 * 1200-bucket cap, so a 20-scenario soak carries ~24,000 user buckets in
 * every message. Two hundred of those is hundreds of megabytes for one
 * run's replay buffer.
 *
 * Every expectation below is COMPUTED from the body it is about
 * (CLAUDE.md's rule), so changing `REPLAY_BUDGET_BYTES` or
 * `REPLAY_MAX_ENTRIES` moves these cases with it instead of breaking them.
 */
describe('replayEntryCap', () => {
  /** A body whose byte length is exactly `bytes`, in plain ASCII. */
  const ascii = (bytes: number) => 'x'.repeat(bytes);

  it('keeps the full entry window while the deltas are small', () => {
    // Small enough that the byte budget is not the binding constraint.
    const body = ascii(Math.floor(REPLAY_BUDGET_BYTES / REPLAY_MAX_ENTRIES / 2));
    expect(replayEntryCap(body)).toBe(REPLAY_MAX_ENTRIES);
  });

  it('trims the window once the deltas are large, and holds the budget', () => {
    // Deliberately past the crossover: the entry cap can no longer be the
    // binding constraint, so what comes back is the byte budget's own
    // answer.
    const bytes = Math.floor(REPLAY_BUDGET_BYTES / REPLAY_MAX_ENTRIES) * 8;
    const cap = replayEntryCap(ascii(bytes));

    expect(cap).toBeLessThan(REPLAY_MAX_ENTRIES);
    expect(cap).toBe(Math.floor(REPLAY_BUDGET_BYTES / bytes));
    // The property the whole thing exists for: what the stream retains at
    // this cap fits in the budget.
    expect(cap * bytes).toBeLessThanOrEqual(REPLAY_BUDGET_BYTES);
  });

  it('never returns zero, however big one delta gets', () => {
    // MAXLEN 0 would make each XADD delete the entire stream it had just
    // written to -- a replay buffer that is always empty, silently. One
    // oversized entry is a bounded overshoot; zero is a broken feature.
    expect(replayEntryCap(ascii(REPLAY_BUDGET_BYTES * 3))).toBe(1);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // Redis stores bytes. A JS string's `length` counts code units, so a
    // run whose scenario or request names are non-ASCII would otherwise be
    // budgeted at up to a third of its real cost -- on exactly the runs
    // most likely to be large.
    const count = Math.floor(REPLAY_BUDGET_BYTES / REPLAY_MAX_ENTRIES) * 8;
    const asciiCap = replayEntryCap('x'.repeat(count));
    // U+00E9 is one UTF-16 code unit and two UTF-8 bytes.
    const accentedCap = replayEntryCap('é'.repeat(count));

    expect(accentedCap).toBe(Math.floor(asciiCap / 2));
  });
});
