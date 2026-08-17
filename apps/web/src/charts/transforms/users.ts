import type { UsersResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * `GET /v1/runs/:id/users` → the two charts §13.2 draws from it: concurrent
 * users over time ⑦ (Appendix A G-18/G-19) and users started per second ⑦ᵇ
 * (G-26).
 *
 * Pure data in, pure data out — no React, no ECharts, nothing that needs a DOM
 * — so every number below is asserted in the node environment against the
 * captured payload fixture.
 *
 * WHY THESE ARE TWO CHARTS AND NOT ONE SERIES DRAWN TWICE. ⑦ plots
 * `maxConcurrent`; ⑦ᵇ plots `started`. They answer different questions, and
 * their DIVERGENCE is the signal: a constant arrival rate produces a *rising*
 * concurrency curve when the service slows. Reading one field into both
 * transforms destroys exactly that, while producing two charts that each look
 * entirely correct — which is why it is the design's falsification checkpoint
 * #2 and why `transforms.users.test.ts` measures the fixture before trusting
 * the test that catches it.
 */

/**
 * The total's name, and it is GATLING'S OWN. The reference report calls the
 * summed series "All users" in both charts; a migrating reader is looking for
 * that string.
 */
const ALL_USERS = 'All users';

/** Heads the label column of both data tables. See `ChartTableRow`. */
const TIME_COLUMN = 'Time (s)';

/** One bucket of either the per-scenario or the total array — the same shape. */
type UserBucket = UsersResponse['total'][number];

/** The two measures these charts draw, and the only fields either one reads. */
type Measure = 'maxConcurrent' | 'started';

/**
 * The bucket width, in milliseconds, inferred from the offsets.
 *
 * WHY THIS IS INFERRED RATHER THAN READ. `SeriesResponse` carries
 * `bucketWidthMs` — Task 1 added it precisely because a client assuming 1000 ms
 * scales every point of a rate chart by a power of two, equally, so the curve's
 * shape is unchanged and nothing looks wrong. `UsersResponse` carries no such
 * field, and `UserSeries` (`packages/statistics/src/users.ts`) halves its
 * resolution in place by the same mechanism once a run exceeds its bucket cap.
 * So the hazard is identical and the field to read is missing. Adding
 * `bucketWidthMs` to `UsersResponse` is the right fix and belongs in the API;
 * until then the only alternative to inferring it is to assume it, which is the
 * mistake itself.
 *
 * THE RULE IS THE SERVER'S, deliberately: `inferBucketWidthMs`
 * (`packages/statistics/src/buckets.ts`) takes the SMALLEST POSITIVE gap, not
 * the first gap, because absent buckets leave larger ones. Here the gap-filling
 * in `UserSeries#sweep` makes each scenario's own range contiguous, but the
 * total is the UNION of the scenarios' ranges — two scenarios that never
 * overlap leave a hole between them — so the smallest-gap rule is load-bearing
 * rather than defensive.
 *
 * Falls back to 1000 ms only when there is no gap to measure at all (a single
 * bucket), which is the same fallback the server takes.
 */
function inferBucketWidthMs(offsets: readonly number[]): number {
  let width = Number.POSITIVE_INFINITY;
  for (let i = 1; i < offsets.length; i++) {
    const gap = offsets[i]! - offsets[i - 1]!;
    if (gap > 0 && gap < width) width = gap;
  }
  return Number.isFinite(width) ? width : 1000;
}

interface Spec {
  readonly measure: Measure;
  /**
   * Divisor applied to every plotted value — `widthMs / 1000` for a per-second
   * RATE, 1 for a level. See `toUserStartRate` and `toConcurrentUsers`.
   */
  readonly perSecond: boolean;
  readonly empty: string;
}

/**
 * Both charts, from one builder: same x-axis, same series list, same table,
 * differing only in which field is read and whether it is a rate.
 *
 * THE X-AXIS IS `total`'s OFFSETS. The total is built server-side from every
 * scenario row, so it is the union of every offset any scenario recorded — the
 * one array guaranteed to span the run. Using the first scenario's offsets
 * instead would truncate the axis for any run whose scenarios are staggered,
 * which the reference run's are (`Checkout` starts five buckets in).
 *
 * PER-SCENARIO VALUES ARE PLACED BY OFFSET, NOT BY INDEX. `Checkout` has 55
 * buckets and the run has 63; zipping the arrays draws all 55 of its points
 * five seconds early — a smooth, plausible, entirely wrong line, with no
 * ragged edge to give it away.
 *
 * AN ABSENT BUCKET IS A ZERO, NOT A GAP. `ChartData` is explicit that `null`
 * means "no observation" and must not be drawn as zero — but here the absence
 * is a compression, not missing data: outside a scenario's own range no user of
 * it had started or was still running. The API agrees, and does so
 * arithmetically: its `total` is the per-scenario sum with absent buckets
 * counted as zero, which the test file asserts across all 63 buckets. Plotting
 * `null` would make the scenario lines stop summing to the total line drawn
 * directly above them.
 */
function usersChart(
  u: UsersResponse,
  spec: Spec,
  opts: { readonly x?: 'index' | 'ms' } = {},
): ChartData {
  const pairs = opts.x === 'ms';
  const offsets = u.total.map((b) => b.startOffsetMs);
  const widthMs = inferBucketWidthMs(offsets);
  const divisor = spec.perSecond ? widthMs / 1000 : 1;
  const read = (bucket: UserBucket | undefined): number =>
    bucket === undefined ? 0 : bucket[spec.measure] / divisor;

  const columns = [TIME_COLUMN, ...u.scenarios.map((s) => s.scenario), ALL_USERS];

  if (u.total.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Not a flat zero line: "nobody was running" and "this run has not been
      // parsed yet" are different facts a reader acts on differently, and an
      // empty chart cannot tell them apart.
      empty: spec.empty,
    };
  }

  const perScenario = u.scenarios.map((scenario) => {
    const byOffset = new Map(scenario.buckets.map((b) => [b.startOffsetMs, b]));
    return {
      name: scenario.scenario,
      data: offsets.map((offset) => read(byOffset.get(offset))),
    };
  });

  /**
   * THE TOTAL COMES FROM THE PAYLOAD, and is never recomputed here.
   *
   * `UsersResponse`'s own comment records that Gatling's "All users" series is
   * exactly the sum of per-scenario maxima — verified across all 63 buckets of
   * the reference run — even though `max(a+b) != max(a)+max(b)` in general. A
   * client that recomputed it would be re-deriving a number the API has already
   * committed to, and a client that "corrected" the arithmetic to a true
   * max-of-sums would silently lose parity.
   *
   * IT IS ALSO THE ONE SERIES THAT MUST BE DRAWN. The palette has six hues and
   * never cycles, and this list is `[...scenarios, total]` — so on a run with
   * six or more scenarios the default "keep the first six" rule would drop the
   * total and keep every scenario, losing the only line that answers "how
   * loaded was the system" while keeping six that answer it only in
   * combination. `essential` exempts it from that cut WITHOUT reordering:
   * `series.at(-1)` is still the total. See `ChartSeries.essential`.
   */
  const totalSeries: ChartSeries = {
    name: ALL_USERS,
    data: u.total.map((bucket) => read(bucket)),
    essential: true,
  };

  /**
   * THE SCALAR FORM, built once and kept — the rows below read it, and the
   * drawn series are derived from it.
   *
   * Split this way for the same reason `toRequestRate` splits it: the row
   * builder indexed `s.data` as `readonly number[]`, which is true of the
   * category form and false of the pair form. Deriving both from one array of
   * numbers is what stops a value axis from silently turning the data table
   * into a list of `[x, y]` tuples.
   */
  const measured: readonly ChartSeries[] = [...perScenario, totalSeries];

  const rows: ChartTableRow[] = offsets.map((offset, i) => ({
    label: String(offset / 1000),
    values: measured.map((s) => (s.data as readonly number[])[i]!),
  }));

  const series: ChartSeries[] = measured.map((s) => ({
    ...s,
    data: pairs
      ? offsets.map((offset, i) => [offset, (s.data as readonly number[])[i]!] as [number, number])
      : s.data,
  }));

  return {
    series,
    // Elapsed SECONDS, not milliseconds and not bucket indices: it is what
    // Gatling's own axis shows, and it is what makes the crosshair this chart
    // shares with requests/s (design §11, `Chart`'s `group`) read the same on
    // both charts.
    axisLabels: offsets.map((offset) => offset / 1000),
    columns,
    rows,
    limitation: spec.perSecond && widthMs !== 1000 ? widthNote(widthMs) : undefined,
  };
}

/**
 * Said in prose, because dividing silently would be its own kind of dishonesty:
 * the chart is titled "per second" and its points are then an average across a
 * window that is not a second, so a one-second spike inside a wide bucket is
 * flattened and cannot be recovered from what is drawn.
 */
function widthNote(widthMs: number): string {
  return (
    `This run is long enough that user activity was recorded in ${widthMs} ms buckets rather ` +
    'than one-second ones, so each point is the average number of users started per second ' +
    'across that window. A shorter spike inside a bucket is not visible at this resolution.'
  );
}

/**
 * ⑦ — concurrent users over time: one line per scenario plus the total
 * (G-18/G-19).
 *
 * NOT SCALED BY THE BUCKET WIDTH, and that is not an oversight. `maxConcurrent`
 * is a LEVEL — the peak number of users standing at some instant inside the
 * bucket — and a level does not change when the window widens; only its
 * resolution does. Dividing it would report "four users per second", which is
 * not a quantity anyone asked for. `started` is a COUNT of events in the
 * window, so it does scale; that asymmetry is the whole difference between this
 * function and the next.
 *
 * §13.2 ⑦ also asks for a source badge (`sessions` or `in-flight proxy`).
 * `UsersResponse` carries no such field, so it is not rendered here rather than
 * guessed — a badge asserting "sessions" would be a claim about the ingest path
 * that nothing in the payload supports.
 */
export function toConcurrentUsers(
  u: UsersResponse,
  opts: { readonly x?: 'index' | 'ms' } = {},
): ChartData {
  return usersChart(u, {
    measure: 'maxConcurrent',
    perSecond: false,
    empty: 'No user activity was recorded for this run, so there are no concurrent users to show.',
  }, opts);
}

/**
 * ⑦ᵇ — users started per second: the user ARRIVAL RATE, one line per scenario
 * plus the total (G-26).
 *
 * A different chart from ⑦ and not a redundant one: G-26 was missing from the
 * PRD's parity matrix until verification found `UserStartRateContainerId` in
 * Gatling's own report, and the note added there is the reason this file keeps
 * saying it — arrival rate and concurrency diverge exactly when the system
 * under test starts to struggle.
 */
export function toUserStartRate(
  u: UsersResponse,
  opts: { readonly x?: 'index' | 'ms' } = {},
): ChartData {
  return usersChart(u, {
    measure: 'started',
    perSecond: true,
    empty: 'No user activity was recorded for this run, so there is no arrival rate to show.',
  }, opts);
}
