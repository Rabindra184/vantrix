import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatDuration,
  formatElapsedClock,
  formatInstant,
  formatInstantSeconds,
  formatOffset,
  formatZoneName,
  formatZoneOffset,
} from '../src/routes/format';

/**
 * Pins the process zone for one case and restores it afterwards.
 *
 * THIS MACHINE'S OWN ZONE IS Asia/Kolkata, so a pin that silently failed to
 * take would still pass here and fail only on CI's UTC runners. Every case
 * asserts the flip landed before asserting anything else, and this file is
 * also run under `TZ=UTC` before it is trusted.
 */
function inZone(zone: string, body: () => void): void {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** Asia/Kolkata is +05:30, so UTC midnight reads 05. */
const kolkataTook = (): void => {
  expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
};

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

/**
 * REVIEW M21 — A WALL-TIME WITH NO ZONE IS TWO DIFFERENT FACTS.
 *
 * `Started` rendered as a local date and minute with no timezone, so two
 * engineers looking at the same run saw different wall times and neither could
 * tell. On an incident call that is a real cost: "it started at 14:03" is not
 * a shared statement.
 *
 * The zone is appended rather than the value converted — a reader wants their
 * OWN clock, plus enough to say which clock it is.
 */
describe('formatInstant — it says which clock it is on', () => {
  it('names the timezone', () => {
    const out = formatInstant('2026-08-14T10:43:49.546Z');
    // Not asserted verbatim: the abbreviation is the runner's own zone, and
    // pinning "GMT+5:30" would make this test a property of where it ran.
    expect(out).toMatch(/(GMT|UTC|[A-Z]{2,5})/);
    expect(out.length).toBeGreaterThan('14 Aug 2026, 10:43'.length);
  });

  it('still carries the date and the minute', () => {
    const out = formatInstant('2026-08-14T10:43:49.546Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

/**
 * REVIEW M21 — RAW SECONDS STOP SCANNING SOMEWHERE ABOVE A FEW MINUTES.
 *
 * A 63s run reads fine as "63s"; a four-hour soak as "14400s" does not. The
 * threshold is a judgement and is deliberately generous: below it the existing
 * rendering is what every table and every e2e expectation already reads, and
 * churning "62s" into "1m 2s" buys nothing.
 */
describe('formatDuration — long runs read as h/m/s', () => {
  it('leaves a short run in seconds', () => {
    expect(formatDuration(63_161)).toBe('63s');
    expect(formatDuration(1_900)).toBe('2s');
  });

  it('breaks a long run into minutes and seconds', () => {
    expect(formatDuration(10 * 60_000 + 5_000)).toBe('10m 5s');
  });

  it('carries hours when there are hours', () => {
    expect(formatDuration(4 * 3_600_000 + 7 * 60_000 + 3_000)).toBe('4h 7m 3s');
  });

  it('omits a zero seconds component rather than printing 0s', () => {
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
  });

  it('still reports an unmeasured duration as a dash, never as zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

/* ======================================================================== *
 * THE TIME WINDOW'S CLOCKS — Gatling Enterprise's Offset and Datetime
 * ======================================================================== */

describe('formatElapsedClock — Offset mode’s tick notation', () => {
  it('writes an offset into the run as HH:MM:SS', () => {
    expect(formatElapsedClock(0)).toBe('00:00:00');
    expect(formatElapsedClock(15_000)).toBe('00:00:15');
    expect(formatElapsedClock(75_000)).toBe('00:01:15');
  });

  it('floors, like a clock', () => {
    expect(formatElapsedClock(42_999)).toBe('00:00:42');
  });

  it('lets the hours run past 24 for a long soak', () => {
    expect(formatElapsedClock(26 * 3_600_000 + 61_000)).toBe('26:01:01');
  });
});

describe('formatClockTime — Datetime mode’s tick notation', () => {
  it('reads the reader’s own 24-hour clock', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      // Gatling Enterprise's own measured pair: elapsed 00:00:15 on a run
      // that began 17:12:09 (11:42:09Z) is 17:12:24.
      expect(formatClockTime(Date.UTC(2026, 7, 15, 11, 42, 9) + 15_000)).toBe('17:12:24');
    });
  });

  it('wraps at midnight', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const lateEvening = Date.UTC(2026, 7, 15, 18, 29, 50); // 23:59:50 IST
      expect(formatClockTime(lateEvening)).toBe('23:59:50');
      expect(formatClockTime(lateEvening + 20_000)).toBe('00:00:10');
    });
  });
});

describe('formatZoneOffset — what a wall-clock axis is labelled with', () => {
  /** What Intl itself prints for the same instant, so this is not a second opinion. */
  const intlShortOffset = (epochMs: number): string =>
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' })
      .formatToParts(epochMs)
      .find((part) => part.type === 'timeZoneName')!.value;

  it('agrees with Intl, including a half-hour zone and zero', () => {
    for (const zone of ['Asia/Kolkata', 'UTC', 'America/New_York']) {
      inZone(zone, () => {
        const at = Date.UTC(2026, 6, 1, 12, 0, 0);
        expect(formatZoneOffset(at)).toBe(intlShortOffset(at));
      });
    }
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      expect(formatZoneOffset(Date.UTC(2026, 7, 15))).toBe('GMT+5:30');
    });
  });

  it('takes the offset at the instant it is given, not today’s', () => {
    inZone('America/New_York', () => {
      expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(8);
      expect(formatZoneOffset(Date.UTC(2026, 6, 1, 12))).toBe('GMT-4');
      expect(formatZoneOffset(Date.UTC(2026, 0, 15, 12))).toBe('GMT-5');
    });
  });
});

describe('formatZoneName', () => {
  it('names the zone the page is in', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      // Derived, not written down: ICU spells this zone Asia/Calcutta or
      // Asia/Kolkata depending on its version.
      expect(formatZoneName()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(formatZoneName()).toMatch(/^Asia\/(Calcutta|Kolkata)$/);
    });
  });
});

describe('formatInstantSeconds — both ends of a window', () => {
  it('tells apart two instants inside one minute, which formatInstant cannot', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const start = Date.UTC(2026, 7, 15, 11, 42, 9);
      const end = start + 30_000;
      expect(formatInstant(new Date(start).toISOString())).toBe(
        formatInstant(new Date(end).toISOString()),
      );
      expect(formatInstantSeconds(start)).not.toBe(formatInstantSeconds(end));
    });
  });

  it('names the zone and carries the seconds', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const out = formatInstantSeconds(Date.UTC(2026, 7, 15, 11, 42, 9));
      expect(out).toContain('GMT+5:30');
      // `17:12:09` in a 24-hour locale, `5:12:09 PM` in a 12-hour one.
      expect(out).toMatch(/\b(17|5):12:09\b/);
      expect(out).toMatch(/2026/);
    });
  });
});
