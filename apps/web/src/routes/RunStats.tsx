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
}: {
  readonly stats: StatsResponse;
  readonly baseline?: TrendRun | null;
  /**
   * The run's SLA results, used ONLY to tint a tile whose metric a rule
   * actually targets. `undefined` for a run nobody has evaluated, which
   * leaves every tile untinted — see `slaTone`.
   */
  readonly assertions?: readonly Assertion[];
}) {
  const run = stats.stats.find((row) => row.scope === 'run');
  if (run === undefined) return null;

  return (
    <section aria-label="Run totals">
      {/* SIX ACROSS ONLY AT `xl`, not at `lg`. The six-column grid was
          breaking at 1024px: `14.40 req/s` is the widest value any tile
          renders, and in a ~150px column it wrapped onto a second line, which
          pushed that one tile's hint down and left the row's baselines
          visibly out of step. Three across from `sm` to `xl` gives every value
          a line to itself at the widths a laptop actually uses, and the row
          only goes to six when there is room for it. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Total Requests"
          value={formatCount(run.count)}
          tone={slaTone(assertions, 'count')}
          hint={`${formatCount(run.okCount)} OK, ${formatCount(run.koCount)} KO`}
          delta={deltaFor(run.count, baseline?.count, 'neutral')}
          data-testid="stat-total-requests"
        />
        <StatTile
          label="Error Rate"
          // The field and expression `StatisticsTable`'s `% KO` column uses
          // (`r.errorRate * 100`), at the same two-decimal precision — never
          // `koCount / count`, which would be a second definition of one
          // number sitting a few hundred pixels from the first.
          value={`${(run.errorRate * 100).toFixed(2)}%`}
          tone={slaTone(assertions, 'error_rate')}
          hint={`${formatCount(run.koCount)} of ${formatCount(run.count)} requests`}
          delta={deltaFor(run.errorRate, baseline?.errorRate, 'lower')}
          data-testid="stat-error-rate"
        />
        <StatTile
          label="Mean Throughput"
          value={formatRate(run.throughputRps)}
          unit="req/s"
          tone={slaTone(assertions, 'throughput_rps')}
          hint={`${formatCount(run.count)} requests over the run`}
          delta={deltaFor(run.throughputRps, baseline?.throughputRps, 'higher')}
          data-testid="stat-throughput"
        />
        <StatTile
          label="Mean Response"
          value={formatMs(run.meanMs)}
          unit="ms"
          tone={slaTone(assertions, 'mean')}
          hint={`up to ${formatMs(run.maxMs)} ms`}
          delta={deltaFor(run.meanMs, baseline?.meanMs, 'lower')}
          data-testid="stat-mean-response"
        />
        <StatTile
          label="95th Percentile"
          value={percentileValue(run, 'p95')}
          unit={percentileUnit(run, 'p95')}
          tone={slaTone(assertions, 'p95')}
          hint="an estimate, accurate to within 1%"
          delta={deltaFor(percentileMs(run, 'p95'), percentileMs(baseline, 'p95'), 'lower')}
          data-testid="stat-p95"
        />
        <StatTile
          label="99th Percentile"
          value={percentileValue(run, 'p99')}
          unit={percentileUnit(run, 'p99')}
          tone={slaTone(assertions, 'p99')}
          hint="an estimate, accurate to within 1%"
          delta={deltaFor(percentileMs(run, 'p99'), percentileMs(baseline, 'p99'), 'lower')}
          data-testid="stat-p99"
        />
      </dl>
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
