import type { UsersResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { assignPalette } from '../src/charts/theme.js';
import { toConcurrentUsers, toUserStartRate } from '../src/charts/transforms/users.js';
import type { ChartData } from '../src/charts/types.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑦ concurrent users over time (Appendix A G-18/G-19) and ⑦ᵇ users
 * started per second (G-26), both folded out of `GET /v1/runs/:id/users`.
 *
 * Read against `fixtures/reference-run.json`, the payload captured from the
 * live API for the real Gatling reference run — the same bytes the browser
 * receives.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The brief's three tests are kept verbatim
 * (they pin the headline facts), but two of them cannot fail against this
 * payload alone, and the fixture was MEASURED to find out which:
 *
 *   - "plots concurrency and arrival rate from DIFFERENT fields" DOES
 *     discriminate: `started !== maxConcurrent` in 54 of the 63 total buckets.
 *     `the fixture can tell concurrency from arrival rate` below pins that
 *     count, so the day someone re-captures the fixture against a run where
 *     the two coincide, the guard fails rather than the headline test quietly
 *     becoming a tautology.
 *   - "uses the API total rather than recomputing it" CANNOT fail here. The
 *     reference run's `total` is *exactly* the per-scenario sum at every one
 *     of the 63 offsets (0 mismatches), which is the whole point of the API's
 *     comment — so a transform that recomputes the sum instead of reading
 *     `total` produces byte-identical output. `follows the payload's own
 *     total…` is the version that discriminates: it moves `total` away from
 *     the sum and asserts the chart follows the array, not the arithmetic.
 *
 * And two hazards the brief does not test at all, both of which produce a
 * plausible, entirely wrong chart:
 *
 *   - PER-SCENARIO ALIGNMENT. `Checkout` has 55 buckets starting at 6000 ms;
 *     the run has 63 starting at 1000 ms. A transform pairing scenario bucket
 *     *i* with axis position *i* draws Checkout five seconds early, all 55
 *     points, smooth and wrong.
 *   - THE ARRIVAL RATE'S UNITS. `UsersResponse` carries no `bucketWidthMs`
 *     (unlike `SeriesResponse`, to which Task 1 added one for precisely this
 *     reason) and `UserSeries` halves resolution in place once a run exceeds
 *     its bucket cap. A chart titled "per second" plotting a per-bucket count
 *     is off by the width factor, equally at every point, so its shape is
 *     unchanged and nothing looks wrong.
 */

const users = fixture.users as UsersResponse;

/** Series order is `[...scenarios, total]`, so the total is always last. */
const total = (d: ChartData) => d.series.at(-1)!.data as readonly (number | null)[];

/* ------------------------------------------------------------------ *
 * what the fixture actually contains — the guards that keep the tests
 * below from certifying nothing
 * ------------------------------------------------------------------ */

describe('the reference payload', () => {
  /**
   * THE GUARD ON THE HEADLINE TEST. If `started` and `maxConcurrent` ever
   * coincided across the whole payload, "plots concurrency and arrival rate
   * from DIFFERENT fields" would pass against an implementation that read one
   * field twice — which is the exact failure the plan's checkpoint #2 exists
   * to catch. Measured: 54 of 63.
   */
  it('can tell concurrency from arrival rate', () => {
    const differing = users.total.filter((b) => b.started !== b.maxConcurrent);
    expect(differing.length).toBe(54);
    expect(users.total).toHaveLength(63);
  });

  /**
   * THE GUARD ON THE ALIGNMENT TESTS. They discriminate only because one
   * scenario does not span the run: `Checkout` runs 6000…60000 ms while the
   * run runs 1000…63000 ms. If both scenarios covered every bucket, index
   * alignment and offset alignment would agree everywhere.
   */
  it('has a scenario that does not span the whole run', () => {
    expect(users.scenarios.map((s) => s.scenario)).toEqual(['Browse', 'Checkout']);
    const checkout = users.scenarios[1]!;
    expect(checkout.buckets).toHaveLength(55);
    expect(checkout.buckets[0]!.startOffsetMs).toBe(6000);
    expect(users.total[0]!.startOffsetMs).toBe(1000);
  });

  /**
   * AND WHY the brief's "uses the API total" test cannot fail: the two
   * definitions agree here. Recorded as an assertion rather than a comment so
   * that a future payload where they diverge shows up as a failure in this
   * file, where the explanation is, rather than in the transform's tests.
   */
  it('has a total that is exactly the per-scenario sum, so recomputing it is indistinguishable', () => {
    const byOffset = users.scenarios.map((s) => new Map(s.buckets.map((b) => [b.startOffsetMs, b])));
    const recomputed = users.total.map((b) => ({
      started: byOffset.reduce((sum, m) => sum + (m.get(b.startOffsetMs)?.started ?? 0), 0),
      maxConcurrent: byOffset.reduce((sum, m) => sum + (m.get(b.startOffsetMs)?.maxConcurrent ?? 0), 0),
    }));
    expect(recomputed).toEqual(users.total.map((b) => ({ started: b.started, maxConcurrent: b.maxConcurrent })));
  });
});

/* ------------------------------------------------------------------ *
 * ⑦ and ⑦ᵇ are two different questions
 * ------------------------------------------------------------------ */

describe('toConcurrentUsers ⑦ / toUserStartRate ⑦ᵇ — the fields they read', () => {
  // The brief's Step 1 tests, kept verbatim.
  it('plots concurrency and arrival rate from DIFFERENT fields', () => {
    const u = users;
    const conc = toConcurrentUsers(u);
    const rate = toUserStartRate(u);
    // Not merely "not deepEqual": these must come from maxConcurrent and
    // started respectively, and the fixture has buckets where those differ.
    expect(total(conc)).toEqual(u.total.map((b) => b.maxConcurrent));
    expect(total(rate)).toEqual(u.total.map((b) => b.started));
    expect(total(conc)).not.toEqual(total(rate));
  });

  it('uses the API total rather than recomputing it', () => {
    // Gatling's own "All users" series is the SUM of per-scenario maxima,
    // verified across all 63 fixture buckets — even though max(a+b) != max(a)+max(b).
    expect(toConcurrentUsers(users).series.at(-1)!.data).toEqual(
      users.total.map((b) => b.maxConcurrent),
    );
  });

  it('draws one series per scenario plus the total', () => {
    expect(toConcurrentUsers(users).series).toHaveLength(users.scenarios.length + 1);
    expect(toUserStartRate(users).series).toHaveLength(users.scenarios.length + 1);
  });

  /**
   * THE VERSION OF "uses the API total" THAT CAN FAIL.
   *
   * `total` is moved away from the per-scenario sum — well-formed per the
   * schema, and the only input that separates "reads `u.total`" from "adds the
   * scenarios up". Against the captured payload the two are identical at every
   * one of the 63 offsets, so the brief's assertion above passes for both.
   *
   * This is not a hypothetical distinction. The API's own comment records that
   * summing maxima is normally wrong (`max(a+b) != max(a)+max(b)`) and that
   * Gatling nonetheless sums — so a client that "fixed" the arithmetic to a
   * true max-of-sums would lose parity, and nothing on the chart would say so.
   */
  it('follows the payload’s own total, rather than adding the scenarios up itself', () => {
    const moved: UsersResponse = {
      ...users,
      total: users.total.map((b) => ({ ...b, maxConcurrent: 99, started: 42 })),
    };
    expect(total(toConcurrentUsers(moved))).toEqual(users.total.map(() => 99));
    expect(total(toUserStartRate(moved))).toEqual(users.total.map(() => 42));
  });

  it('names the scenarios, then Gatling’s own "All users"', () => {
    for (const d of [toConcurrentUsers(users), toUserStartRate(users)]) {
      expect(d.series.map((s) => s.name)).toEqual(['Browse', 'Checkout', 'All users']);
    }
  });
});

/* ------------------------------------------------------------------ *
 * per-scenario alignment
 * ------------------------------------------------------------------ */

describe('toConcurrentUsers ⑦ — the per-scenario series (G-18)', () => {
  const d = toConcurrentUsers(users);
  const checkout = users.scenarios[1]!;

  /**
   * BY OFFSET, NOT BY INDEX. Checkout's first bucket is the run's SIXTH, so
   * `series[1].data[0]` is Checkout at t=1s (before it started), not
   * Checkout's first recorded bucket. A transform that zips the arrays draws
   * every Checkout point five seconds early — a smooth, plausible, wrong line.
   */
  it('places each scenario’s buckets at the offsets they were recorded at', () => {
    const drawn = d.series[1]!.data as readonly (number | null)[];
    const offsets = users.total.map((b) => b.startOffsetMs);

    for (const bucket of checkout.buckets) {
      expect(drawn[offsets.indexOf(bucket.startOffsetMs)]).toBe(bucket.maxConcurrent);
    }
    // And the five buckets before Checkout existed are not its first five values.
    expect(drawn.slice(0, 5)).not.toEqual(
      checkout.buckets.slice(0, 5).map((b) => b.maxConcurrent),
    );
  });

  /**
   * A scenario that has not started yet had zero users, and that is a
   * MEASUREMENT, not a gap — the API's own total says so: it is the sum over
   * scenarios with absent buckets counted as zero (asserted above). Drawing
   * null here would render an em dash in the table for a bucket whose value is
   * known, and would break the sum below.
   */
  it('carries zero — not a gap — where a scenario was not running', () => {
    const drawn = d.series[1]!.data as readonly (number | null)[];
    expect(drawn.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(drawn.slice(-3)).toEqual([0, 0, 0]);
    expect(drawn).toHaveLength(users.total.length);
  });

  /**
   * The chart's internal consistency, and the one assertion that catches every
   * alignment mistake at once: a scenario read by index, a scenario read from
   * the wrong field, or a null where a zero belongs all break it.
   */
  it.each([
    ['concurrency', toConcurrentUsers],
    ['arrival rate', toUserStartRate],
  ] as const)('sums the scenario lines to the total line at every bucket (%s)', (_label, transform) => {
    const chart = transform(users);
    const lines = chart.series.slice(0, -1).map((s) => s.data as readonly number[]);
    const totals = total(chart);
    for (let i = 0; i < totals.length; i++) {
      expect(lines.reduce((sum, line) => sum + line[i]!, 0)).toBe(totals[i]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * the data table — the parity surface
 * ------------------------------------------------------------------ */

describe('the data table both charts expose', () => {
  const conc = toConcurrentUsers(users);
  const rate = toUserStartRate(users);

  it('heads one column per series, after the time column', () => {
    expect(conc.columns).toEqual(['Time (s)', 'Browse', 'Checkout', 'All users']);
    expect(rate.columns).toEqual(['Time (s)', 'Browse', 'Checkout', 'All users']);
  });

  it('labels the rows with elapsed seconds, one row per bucket', () => {
    expect(conc.rows).toHaveLength(users.total.length);
    expect(conc.rows[0]!.label).toBe('1');
    expect(conc.rows.at(-1)!.label).toBe('63');
    expect(conc.axisLabels).toEqual(users.total.map((b) => b.startOffsetMs / 1000));
  });

  /**
   * The table is the parity surface (design §7), so it has to carry the same
   * numbers the lines do — read out of the row rather than off the series, in
   * the same order the columns declare.
   */
  it('carries every plotted value, in column order', () => {
    for (let i = 0; i < conc.rows.length; i++) {
      const bucket = users.total[i]!;
      const browse = users.scenarios[0]!.buckets.find((b) => b.startOffsetMs === bucket.startOffsetMs);
      const checkout = users.scenarios[1]!.buckets.find((b) => b.startOffsetMs === bucket.startOffsetMs);
      expect(conc.rows[i]!.values).toEqual([
        browse?.maxConcurrent ?? 0,
        checkout?.maxConcurrent ?? 0,
        bucket.maxConcurrent,
      ]);
      expect(rate.rows[i]!.values).toEqual([
        browse?.started ?? 0,
        checkout?.started ?? 0,
        bucket.started,
      ]);
    }
  });

  it('says nothing about missing data on a run that has some', () => {
    expect(conc.empty).toBeUndefined();
    expect(rate.empty).toBeUndefined();
    expect(conc.limitation).toBeUndefined();
    expect(rate.limitation).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * ⑦ᵇ is a RATE, and the bucket is not always a second
 * ------------------------------------------------------------------ */

describe('toUserStartRate ⑦ᵇ — per SECOND, whatever the bucket width is', () => {
  /**
   * `UserSeries` halves resolution in place once a run exceeds its bucket cap,
   * and `UsersResponse` — unlike `SeriesResponse` — carries no `bucketWidthMs`
   * to say so. A run long enough to have been halved reports 2000 ms buckets,
   * and 6 users started in a 2000 ms bucket is 3 per second, not 6.
   *
   * The counts here are deliberately different per bucket, so a transform that
   * divided by the wrong constant, or by nothing, produces different numbers
   * rather than an accidentally-equal set.
   */
  const wide = (): UsersResponse => ({
    runId: users.runId,
    window: null,
    scenarios: [
      {
        scenario: 'Browse',
        buckets: [
          { startOffsetMs: 0, started: 6, ended: 0, maxConcurrent: 6 },
          { startOffsetMs: 2000, started: 4, ended: 2, maxConcurrent: 8 },
          { startOffsetMs: 4000, started: 0, ended: 8, maxConcurrent: 8 },
        ],
      },
    ],
    total: [
      { startOffsetMs: 0, started: 6, ended: 0, maxConcurrent: 6 },
      { startOffsetMs: 2000, started: 4, ended: 2, maxConcurrent: 8 },
      { startOffsetMs: 4000, started: 0, ended: 8, maxConcurrent: 8 },
    ],
  });

  it('divides the count by the bucket width, rather than assuming one second', () => {
    const d = toUserStartRate(wide());
    expect(total(d)).toEqual([3, 2, 0]);
    expect(d.rows.map((r) => r.values)).toEqual([
      [3, 3],
      [2, 2],
      [0, 0],
    ]);
  });

  it('says so beside the chart, because "per second" is then an average over a wider window', () => {
    expect(toUserStartRate(wide()).limitation).toMatch(/2000 ms/);
  });

  /**
   * CONCURRENCY IS NOT SCALED, and this is not an oversight. `maxConcurrent`
   * is a level — the peak number of users standing at an instant inside the
   * bucket — and a level does not change when the window widens; only its
   * resolution does. Dividing it would report "4 users per second", which is
   * not a quantity.
   */
  it('leaves concurrency alone, because a level is not a count', () => {
    expect(total(toConcurrentUsers(wide()))).toEqual([6, 8, 8]);
  });

  it('leaves a one-second run’s counts untouched', () => {
    // The reference run's buckets are 1000 ms, so the divisor is exactly 1 and
    // G-26's "exact per bucket" parity holds byte-for-byte.
    expect(total(toUserStartRate(users))).toEqual(users.total.map((b) => b.started));
  });

  it('keeps the axis in elapsed seconds even when a bucket is not a second wide', () => {
    // 0, 2, 4 — the offsets in seconds, not bucket indices. An axis numbered
    // 0,1,2 would put the run's 4-second mark at t=2.
    expect(toUserStartRate(wide()).axisLabels).toEqual([0, 2, 4]);
    expect(toUserStartRate(wide()).rows.map((r) => r.label)).toEqual(['0', '2', '4']);
  });
});

/* ------------------------------------------------------------------ *
 * more scenarios than the palette has hues
 * ------------------------------------------------------------------ */

/**
 * A run with seven scenarios is one more series than the six hues
 * `assignPalette` will spend, and the series order is `[...scenarios, total]`.
 *
 * The default cut keeps the first six, which here means keeping every scenario
 * and dropping the TOTAL — the one line that answers "how loaded was the
 * system", while the six that answer it only in combination are all drawn. The
 * total is marked `essential` so the cut falls on a scenario instead.
 *
 * Asserted through `assignPalette` itself, not against a rendered chart: it is
 * the function `Chart` calls to decide what gets drawn, so this is the same
 * decision the browser makes, reached without a DOM.
 */
describe('a run with more scenarios than the palette has hues', () => {
  const many: UsersResponse = {
    runId: users.runId,
    window: null,
    scenarios: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((scenario, i) => ({
      scenario,
      buckets: [{ startOffsetMs: 0, started: i + 1, ended: 0, maxConcurrent: i + 1 }],
    })),
    total: [{ startOffsetMs: 0, started: 28, ended: 0, maxConcurrent: 28 }],
  };

  it.each([
    ['concurrent users', toConcurrentUsers],
    ['user start rate', toUserStartRate],
  ] as const)('still draws the total, and still draws it last (%s)', (_label, transform) => {
    const d = transform(many);
    expect(d.series).toHaveLength(8);
    expect(d.series.at(-1)!.name).toBe('All users');

    const assigned = assignPalette(
      d.series.map((s) => s.name),
      'light',
      d.series.flatMap((s, i) => (s.essential === true ? [i] : [])),
    );
    // Six hues, and the total holds one of them — a scenario was dropped
    // instead. Last in the drawn list too, so it keeps reading as the summary
    // of the lines above it rather than being shuffled among them.
    expect(assigned.drawn.map((s) => s.name)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'All users']);
    expect(assigned.undrawn).toEqual(['S6', 'S7']);
    expect(new Set(assigned.drawn.map((s) => s.color)).size).toBe(6);
  });

  it('marks the total, and only the total, as essential', () => {
    const d = toConcurrentUsers(many);
    expect(d.series.filter((s) => s.essential === true).map((s) => s.name)).toEqual(['All users']);
  });

  /**
   * The undrawn scenarios are still in the data table — the parity surface —
   * so the honest trade is "you can read it, you cannot see it", never "two of
   * these lines are the same colour".
   */
  it('keeps every scenario in the data table, drawn or not', () => {
    const d = toConcurrentUsers(many);
    expect(d.columns).toEqual([
      'Time (s)',
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
      'All users',
    ]);
    expect(d.rows[0]!.values).toEqual([1, 2, 3, 4, 5, 6, 7, 28]);
  });
});

/* ------------------------------------------------------------------ *
 * a run with nothing in it
 * ------------------------------------------------------------------ */

describe('a run with no recorded users', () => {
  const nothing: UsersResponse = { runId: users.runId, window: null, scenarios: [], total: [] };

  it.each([
    ['concurrent users', toConcurrentUsers],
    ['user start rate', toUserStartRate],
  ] as const)('explains itself instead of drawing empty axes (%s)', (_label, transform) => {
    const d = transform(nothing);
    expect(d.empty).toBeDefined();
    expect(d.series).toEqual([]);
    expect(d.rows).toEqual([]);
    // The data table renders unconditionally, so its header still has to
    // exist — built from the same list as a populated chart's, which with no
    // scenarios is the time column and the total.
    expect(d.columns).toEqual(['Time (s)', 'All users']);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);
  });
});
