import type { Assertion, StatRow, StatsResponse, TrendRun } from '@perfportal/contracts';
import StatTile from '../components/StatTile';
import {
  clampPercentile,
  formatCount,
  formatMs,
  formatRate,
  type PercentileRange,
} from '../tables/StatisticsTable';

/**
 * §13.2's headline numbers, above the tables.
 *
 * EVERY VALUE COMES FROM THE RUN-SCOPE STATS ROW the page already fetched —
 * `statsQuery` is asked for twice on this page and served once from cache, so
 * this adds no request. Nothing here is derived from anywhere else: a tile that
 * disagreed with the statistics table directly beneath it would be worse than
 * no tile.
 *
 * The nine fields these six tiles read — `count`, `errorRate`, `okCount`,
 * `koCount`, `throughputRps`, `meanMs`, `maxMs`, `percentiles.p95`,
 * `percentiles.p99` — are exactly the run-scope row's own fields, read
 * straight off it as a headline value or a hint (some, like `count`, in more
 * than one tile's hint) and never recombined into a new quantity the row does
 * not already carry.
 *
 * EVERY NUMBER IS WRITTEN DOWN THE SAME WAY THE TABLE WRITES IT: `formatCount`,
 * `formatMs`, `formatRate` and `clampPercentile` are all imported from
 * `StatisticsTable`, never re-derived here. `formatCount` in particular is
 * `String(value)` — no grouping separator — and that is not a style choice
 * this file gets to make independently: `StatisticsTable`'s own docstring
 * (`formatCount`) explains that a locale-dependent separator would make what a
 * reader (or a test) sees depend on where it ran, and a count tile that used
 * `.toLocaleString()` would read "1,234" beside a table row reading "1234" for
 * any run at four digits or more — a real disagreement, not a hypothetical
 * one, and the exact class of bug this whole component exists to rule out.
 *
 * `null`, not zeroed tiles, when the payload carries no run-scope row: a
 * statistics table with nothing to show already renders its own "no
 * statistics were recorded" message (`StatisticsTable`), and six tiles
 * reading 0/0.00%/— above that sentence would assert measurements nobody
 * took.
 */
type DeltaTone = 'better' | 'worse' | 'neutral';

export default function RunStats({
  stats,
  baseline,
  assertions,
  windowed,
}: {
  readonly stats: StatsResponse;
  readonly baseline?: TrendRun | null;
  /**
   * The run's SLA results, used ONLY to tint a tile whose metric a rule
   * actually targets. `undefined` for a run nobody has evaluated, which
   * leaves every tile untinted — see `slaTone`.
   */
  readonly assertions?: readonly Assertion[];
  /**
   * Is a time window applied? Three things below change with it, and every one
   * of them was wrong under a window before this prop existed — see the empty
   * branch, the percentile note and `slaTone`.
   */
  readonly windowed?: boolean;
}) {
  const run = stats.stats.find((row) => row.scope === 'run');
  if (run === undefined) {
    /* ═══ AN EMPTY WINDOW IS A MEASUREMENT, NOT AN ABSENCE ═══
     *
     * This returned `null`, on the reasoning — written here — that "a
     * statistics table with nothing to show already renders its own 'no
     * statistics were recorded' message, and six tiles reading 0/0.00%/—
     * above that sentence would assert measurements nobody took".
     *
     * The first half of that is true of a run with no statistics and FALSE of
     * a window with none. MEASURED on the reference run at `?from=62000&to=63000`
     * — a real, in-range second of a 62s run that happens to hold no requests
     * — the whole "Run totals" section vanished and the statistics table
     * printed no such message either. A reader who dragged the brush one
     * second too far got a page with its headline numbers silently removed and
     * nothing anywhere saying why.
     *
     * The second half stays right, which is why this is a sentence and not
     * zeroed tiles: `0 requests` is a claim about the window (true) that reads
     * as a claim about the run (false). So the section keeps its landmark and
     * says what happened.
     *
     * The whole-run case is untouched and still renders nothing: there the
     * table's own message IS on screen, and this component has no scope to
     * add. */
    if (windowed !== true) return null;
    return (
      <section aria-label="Run totals" data-testid="stats-empty-window">
        <p className="rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-muted">
          No requests fall inside the selected window, so this run’s totals cannot be computed for
          it. The run’s own figures are unchanged — widen the window to see them.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Run totals" className="@container">
      {/* SIX ACROSS ONLY AT `xl`, not at `lg`. The six-column grid was
          breaking at 1024px: `14.40 req/s` is the widest value any tile
          renders, and in a ~150px column it wrapped onto a second line, which
          pushed that one tile's hint down and left the row's baselines
          visibly out of step. Three across from `sm` to `xl` gives every value
          a line to itself at the widths a laptop actually uses, and the row
          only goes to six when there is room for it. */}
      {/* AND THE THRESHOLDS ARE CONTAINER-RELATIVE NOW, for the reason the
          comment above already half-states: what decides whether six columns
          fit is the width this list HAS and the size of the text in it, and
          `xl:` knows neither. Tailwind's container thresholds are in rem, so
          at a 32px root `@5xl` is 2048px and the section never reaches it —
          the row drops back to three and then two instead of spilling.

          `@container` GOES ON THE `<section>`, NOT ON THIS `<dl>`. A container
          query cannot query the element that declares the context — put both
          on one element and the variant simply never matches, silently. Done
          that way first here, and it cost `run-tables.spec.ts`'s M01 geometry
          bound: the tiles fell to two columns at every width, which made the
          block tall enough to push the run totals past 900px. */}
      <dl className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @5xl:grid-cols-6">
        <StatTile
          label="Requests"
          value={formatCount(run.count)}
          tone={slaTone(windowed === true ? undefined : assertions, 'count')}
          /* "successful / failed", not "OK / KO" — review N01. Those two are
             Gatling's words, and nothing in this repo requires them: the PRD
             binds QUANTITIES (count, ok/ko count, % KO, count/second…) and
             both parity suites compare only numbers, never a label. The
             statistics table keeps them where a reader may be diffing this
             against Gatling's own report side by side; a totals tile is not
             that surface. */
          hint={`${formatCount(run.okCount)} successful, ${formatCount(run.koCount)} failed`}
          delta={deltaFor(run.count, baseline?.count, 'neutral')}
          data-testid="stat-total-requests"
        />
        <StatTile
          label="Error rate"
          // The field and expression `StatisticsTable`'s `% KO` column uses
          // (`r.errorRate * 100`), at the same two-decimal precision — never
          // `koCount / count`, which would be a second definition of one
          // number sitting a few hundred pixels from the first.
          value={`${(run.errorRate * 100).toFixed(2)}%`}
          tone={slaTone(windowed === true ? undefined : assertions, 'error_rate')}
          hint={`${formatCount(run.koCount)} of ${formatCount(run.count)} requests`}
          delta={deltaFor(run.errorRate, baseline?.errorRate, 'lower')}
          data-testid="stat-error-rate"
        />
        <StatTile
          /* "Requests/s", the spelling N01 standardises on, and it replaces
             BOTH halves of the old tile: the label said "Mean Throughput" and
             the unit said "req/s", so the row named one quantity twice and
             agreed with neither the chart axis nor the statistics column. The
             unit is gone because the label now carries it — repeating it would
             render "Requests/s 14.40 req/s". */
          label="Requests/s"
          value={formatRate(run.throughputRps)}
          tone={slaTone(windowed === true ? undefined : assertions, 'throughput_rps')}
          hint={`${formatCount(run.count)} requests over the run`}
          delta={deltaFor(run.throughputRps, baseline?.throughputRps, 'higher')}
          data-testid="stat-throughput"
        />
        <StatTile
          /* ═══ "Mean", "p95", "p99" — THE TABLE'S OWN WORDS ═══
           *
           * Review N01 asks for `p95 response time` as the standard spelling,
           * and these three deliberately fall short of it. MEASURED: at
           * 1280x800 the six-across grid gives each tile 147px and the label
           * box 113px, where "Mean response time" wraps to two lines (h=36
           * against 18) and pushes that tile's value 18px below its five
           * neighbours — the baseline defect the grid comment above records
           * fixing once already. Every other width was clear (1440, 1024, 390).
           *
           * What the finding is actually about is DRIFT: one quantity spelled
           * differently on each surface. These now match `StatisticsTable`'s
           * columns and `SLA_METRIC_SCALARS`' own names exactly, so the tile,
           * the table and the metric a gate is authored against are one word.
           * That is a stronger standardisation than the review's phrasing, and
           * it fits. The long form belongs in PROSE, where `ProjectRules`
           * already writes it out in full.
           *
           * The `ms` unit beside each value is what says these are times. */
          label="Mean"
          value={formatMs(run.meanMs)}
          unit="ms"
          tone={slaTone(windowed === true ? undefined : assertions, 'mean')}
          hint={`up to ${formatMs(run.maxMs)} ms`}
          delta={deltaFor(run.meanMs, baseline?.meanMs, 'lower')}
          data-testid="stat-mean-response"
        />
        <StatTile
          label="p95"
          value={percentileValue(run, 'p95')}
          unit={percentileUnit(run, 'p95')}
          tone={slaTone(windowed === true ? undefined : assertions, 'p95')}
          hint="estimate"
          delta={deltaFor(percentileMs(run, 'p95'), percentileMs(baseline, 'p95'), 'lower')}
          data-testid="stat-p95"
        />
        <StatTile
          label="p99"
          value={percentileValue(run, 'p99')}
          unit={percentileUnit(run, 'p99')}
          tone={slaTone(windowed === true ? undefined : assertions, 'p99')}
          hint="estimate"
          delta={deltaFor(percentileMs(run, 'p99'), percentileMs(baseline, 'p99'), 'lower')}
          data-testid="stat-p99"
        />
      </dl>

      {/* ═══ THE METHODOLOGY ONCE, NOT ONCE PER TILE (review 09-13 N02) ═══
       *
       * Both percentile tiles carried "an estimate, accurate to within 1%" —
       * the same sentence, twice, in a six-tile row where every other hint is
       * a fact about ITS OWN tile. The tiles keep the one word that is a
       * property of the value (`estimate`, so nobody reads p95 as exact) and
       * the reasoning moves here, where it is said once and can be longer for
       * it.
       *
       * IT IS WORTH SAYING AT ALL, which is why this is a disclosure and not a
       * deletion: the 1% is a CLAIM ABOUT THIS PLATFORM, not a disclaimer.
       * Gatling's own percentiles are histogram estimates — measured 9.47% low
       * on the p99 of a real run, reporting a value that occurs nowhere in the
       * data — and the sketch behind these answers the same question within 1%
       * against the true distribution. A reader comparing the two reports needs
       * that, and it is the kind of thing they need once.
       *
       * NO HEADING. `run-tables.spec.ts` asserts the Overview tab's heading
       * outline is exactly ['Platform gates', 'Simulation assertions',
       * 'Statistics']; a `<summary>` contributes a group, not a heading, so
       * this cannot break that outline the way an <h2> would. */}
      <details className="group mt-3" data-testid="percentile-method">
        <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
          <span className="group-open:hidden">How percentiles are measured</span>
          <span className="hidden group-open:inline">Hide how percentiles are measured</span>
        </summary>
        <p className="pt-2 text-[0.75rem] leading-relaxed text-muted">
          {/* "of the whole run" IS FALSE UNDER A WINDOW, and this paragraph
              said it unconditionally. The sketch is rebuilt from the buckets
              the window selects, so under one the rank is read from that
              stretch — which is the whole point of applying it. A methodology
              note that names the wrong population is worse than none, because
              a reader checks it precisely when the number surprises them. */}
          Percentiles are read from a sketch of {windowed === true ? 'the selected window' : 'the whole run'} rather than from a bucketed
          histogram, which answers any rank — p95, p99, p99.9 — to within 1% of the true
          distribution. The tool&rsquo;s own report estimates from fixed bands and can drift
          further: on this fixture&rsquo;s p99 it reads 9.47% low, reporting a number that occurs
          nowhere in the data. Minimum, maximum, mean and every count on this row are exact.
        </p>
      </details>
    </section>
  );
}

/**
 * A percentile tile's value, clamped exactly the way `StatisticsTable`'s own
 * percentile columns are: a percentile of a sample cannot lie outside that
 * sample's own minimum and maximum, and `clampPercentile` projects the raw
 * estimate onto the run row's own range (`clampPercentile`'s doc explains
 * why). Reusing it — rather than re-deriving the clamp here — is what keeps
 * the p99 tile from reading 2515 while the "All Requests" row directly below
 * it reads 2503, the exact disagreement this whole component exists to rule
 * out.
 *
 * `—`, never `0`, for a project configured with no such percentile: a gap in
 * `row.percentiles` is not a measurement of zero.
 */
function percentileValue(row: StatRow, key: string): string {
  const raw = row.percentiles[key];
  if (raw === undefined || !Number.isFinite(raw)) return '—';
  return formatMs(clampPercentile(raw, row));
}

/**
 * `ms`, or NOTHING when the value is the em dash.
 *
 * A unit beside a dash claims a measurement that was never taken — the same
 * overclaim `RunDecisionBand` refuses when it draws no counts for a run
 * nobody has evaluated. The two functions read the same field so they cannot
 * disagree about whether a number exists.
 */
function percentileUnit(row: StatRow, key: string): string | undefined {
  const raw = row.percentiles[key];
  return raw === undefined || !Number.isFinite(raw) ? undefined : 'ms';
}

/**
 * A percentile the way the TILE SHOWS IT — clamped onto its own row's
 * exactly-tracked [min, max], exactly as `percentileValue` does two
 * functions above.
 *
 * The delta used to read the RAW map on both sides while the value above it
 * read the clamped one, so the two disagreed by however much the estimator
 * was out: `StatisticsTable`'s own docstring records the reference run
 * reporting p99 2515.4 against a max of 2503, which is a tile displaying
 * "2503 ms" over a percentage computed from 2515.4. A reader dividing the
 * two numbers on screen could not reproduce the figure between them, and on
 * a sparse tail the clamp can flip the sign of a small delta outright.
 *
 * `TrendRun` carries the same `minMs`/`maxMs` pair from the same rollup, so
 * the baseline is clamped against its OWN range rather than this run's.
 */
function percentileMs(
  row: (PercentileRange & { readonly percentiles: Record<string, number> }) | null | undefined,
  key: string,
): number | undefined {
  if (row === null || row === undefined) return undefined;
  const raw = row.percentiles[key];
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return clampPercentile(raw, row);
}

function deltaFor(
  current: number | undefined,
  previous: number | undefined,
  better: 'higher' | 'lower' | 'neutral',
): { label: string; tone: DeltaTone } | undefined {
  if (
    current === undefined ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return undefined;
  }

  const change = ((current - previous) / previous) * 100;
  if (!Number.isFinite(change)) return undefined;
  const rounded = Number(change.toFixed(1));
  const sign = rounded > 0 ? '+' : '';
  return {
    label: `${sign}${rounded.toFixed(1)}% vs previous`,
    tone: deltaTone(rounded, better),
  };
}

function deltaTone(change: number, better: 'higher' | 'lower' | 'neutral'): DeltaTone {
  if (Math.abs(change) < 0.05 || better === 'neutral') return 'neutral';
  if (better === 'higher') return change > 0 ? 'better' : 'worse';
  return change < 0 ? 'better' : 'worse';
}

/**
 * How a run-level response-time metric stands against the SLA rule that
 * targets it: `breach` when that rule failed, `near` when it passed but sits
 * within `NEAR_MARGIN` of its own threshold, and NOTHING otherwise.
 *
 * SCOPE `run` AND FAMILY `response_time` ONLY, and both filters are
 * load-bearing. A rule on one request (`scope: 'request'`) judges that
 * request, not the run's aggregate — tinting the run's p95 from it would
 * report a per-endpoint breach as a whole-run one. And the other three
 * families measure latency and group timings, which these tiles do not show.
 *
 * EVERY TILE HERE IS JUDGEABLE, AND AN EARLIER VERSION OF THIS COMMENT SAID
 * OTHERWISE. It claimed "`AssertionSchema` has no error-rate or throughput
 * family, so those tiles have no rule to be near" — which confused the two
 * axes a rule is written on. `family` picks the stat ROW (`evaluate.ts`
 * filters `s.family === rule.family`); `metric` picks the VALUE out of it
 * (`resolveMetric`). `packages/sla/src/metrics.ts`'s `SCALARS` has carried
 * `error_rate` and `throughput_rps` all along, and `evaluate.test.ts` already
 * exercises a `throughput_rps` gate. So "error rate under 1%" is expressible
 * today as scope `run`, family `response_time`, metric `error_rate` — no new
 * family, no migration, nothing to add.
 *
 * The family filter STAYS, and is not redundant: it is what stops a rule on
 * the `latency` distribution's p95 tinting a tile that shows the
 * `response_time` p95. Two different measurements that share a metric name.
 */
const NEAR_MARGIN = 0.1;

/**
 * ═══ NOT UNDER A WINDOW, BECAUSE THE GATE JUDGED THE WHOLE RUN ═══
 *
 * Every caller passes `windowed === true ? undefined : assertions`. An SLA
 * assertion is evaluated once, against the run, at finalize — nothing
 * re-evaluates it per window and nothing could, since the rule's threshold is
 * a statement about the run. So under a window the VALUE in a tile is this
 * stretch's and the TINT would be the whole run's: a p95 tile showing a
 * perfectly healthy ten seconds, coloured as a breach, because a different
 * ten seconds broke the gate.
 *
 * Withheld rather than recomputed. Recomputing would invent a verdict nobody
 * configured — the "a platform gate is the organisation's policy" line this
 * repo already draws between SLA gates and simulation checks — and a tint
 * that means something different from the tint beside it is worse than none.
 */
function slaTone(
  assertions: readonly Assertion[] | undefined,
  metric: string,
): 'breach' | 'near' | undefined {
  const rule = assertions?.find(
    (a) =>
      a.rule.scope === 'run' && a.rule.family === 'response_time' && a.rule.metric === metric,
  );
  if (rule === undefined) return undefined;
  if (rule.outcome === 'failed') return 'breach';
  // `not_applicable` carries a null actual — there was nothing to measure, so
  // there is no distance to a threshold and nothing to warn about.
  if (rule.outcome !== 'passed' || rule.actualValue === null) return undefined;

  const { comparator, threshold } = rule.rule;
  if (threshold === 0) return undefined;
  // `lte` passes BELOW its threshold, so it approaches from underneath; `gte`
  // passes above and approaches from over. Same margin, opposite directions.
  const near =
    comparator === 'lte'
      ? rule.actualValue >= threshold * (1 - NEAR_MARGIN)
      : rule.actualValue <= threshold * (1 + NEAR_MARGIN);
  return near ? 'near' : undefined;
}
