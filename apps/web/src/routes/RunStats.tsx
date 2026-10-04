import { Link } from 'react-router-dom';
import type { Assertion, RunResponse, StatRow, StatsResponse, TrendRun } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';
import StatTile from '../components/StatTile';
import { comparability, summariseConditions } from './comparability';
import { clampPercentile, type PercentileRange } from '../percentile';
import { runPath } from './paths';
import { runName } from '../runNumber';
import { StatisticsEmpty, formatCount, formatMs } from '../tables/StatisticsTable';

/**
 * The Summary's headline numbers — GE's four, and no more.
 *
 * EVERY VALUE COMES FROM THE RUN-SCOPE STATS ROW the page already fetched —
 * `statsQuery` is asked for once and served from cache, so this adds no
 * request — EXCEPT PEAK USERS, which the row cannot carry: it records no user
 * count, so that one is handed in from the users series the Summary fetches
 * whole-run. A tile that disagreed with the statistics table it summarises
 * would be worse than no tile, so nothing else is derived from anywhere else.
 *
 * The fields the three row-fed tiles read — `errorRate`, `koCount`, `count`,
 * `okCount` and `percentiles.p95` — are the run-scope row's own fields, read
 * straight off it as a headline value or a hint and never recombined into a
 * new quantity the row does not already carry.
 *
 * EVERY NUMBER IS WRITTEN DOWN THE SAME WAY THE TABLE WRITES IT: `formatCount`
 * and `formatMs` are imported from `StatisticsTable`, never re-derived here.
 * `formatCount` in particular is `String(value)` — no grouping separator — and
 * that is not a style choice this file gets to make independently:
 * `StatisticsTable`'s own docstring (`formatCount`) explains that a
 * locale-dependent separator would make what a reader (or a test) sees depend
 * on where it ran, and a count tile that used `.toLocaleString()` would read
 * "1,234" beside a table row reading "1234" for any run at four digits or more
 * — a real disagreement, not a hypothetical one, and the exact class of bug
 * this whole component exists to rule out.
 *
 * WHEN THE PAYLOAD CARRIES NO RUN-SCOPE ROW this draws the table's own empty
 * sentence (`StatisticsEmpty`), not nothing. It used to return `null`, because
 * the statistics table beside it said so; the Summary has no statistics table
 * any more (it is in the Report), so this is the only place an empty run is
 * said. Zeroed tiles would still be wrong — `0 requests` reads as a measurement
 * nobody took — which is why it is a sentence.
 */
type DeltaTone = 'better' | 'worse' | 'neutral';

export default function RunStats({
  stats,
  peakUsers,
  runStatus,
  baseline,
  current,
  assertions,
}: {
  readonly stats: StatsResponse;
  /**
   * The most users the run had running at once, from the users series — or
   * `null` until that arrives, and for a run that recorded no buckets. A dash,
   * never `0`: zero is a measurement.
   */
  readonly peakUsers: number | null;
  /**
   * Why an empty payload is empty, which it cannot work out for itself: a run
   * whose stream stopped kept nothing, and "recorded no statistics" would tell
   * a reader who watched 440 requests go by that none existed.
   */
  readonly runStatus: RunResponse['status'] | undefined;
  readonly baseline?: TrendRun | null;
  /**
   * This run as its own cohort row, so the note under the tiles can say what
   * the deltas are measured against and whether that run was comparable.
   * Absent leaves the baseline NAMED and its conditions unstated — the
   * identification is the half that must not depend on a second lookup.
   */
  readonly current?: TrendRun | null;
  /**
   * The run's SLA results, used ONLY to tint a tile whose metric a rule
   * actually targets. `undefined` for a run nobody has evaluated, which
   * leaves every tile untinted — see `slaTone`.
   */
  readonly assertions?: readonly Assertion[];
}) {
  const run = stats.stats.find((row) => row.scope === 'run');
  if (run === undefined) {
    return (
      <section aria-label="Run totals" data-testid="stats-empty">
        {/* `false`: the Summary is whole-run by construction — it sends no window
            and ignores one in its URL — so "a window selected nothing" is not a
            state it can be in, and the retained/recorded wording is the true one. */}
        <StatisticsEmpty runStatus={runStatus} windowSelected={false} />
      </section>
    );
  }

  // A delta names the run it compares against, and links to it (clean UI,
  // PR 2): "+7.7% vs Run 10". That replaces the sentence that used to sit
  // under the row explaining what "vs previous" meant.
  const against = baseline == null ? null : { name: baselineName(baseline), to: runPath(baseline.id) };
  const vs = (delta: Delta | undefined) =>
    delta === undefined || against === null
      ? undefined
      : {
          label: (
            <>
              {delta.change} vs{' '}
              <Link to={against.to} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
                {against.name}
              </Link>
            </>
          ),
          tone: delta.tone,
        };

  return (
    <section aria-label="Run totals" className="@container">
      {/* FOUR ACROSS ONLY WHEN THIS LIST HAS ROOM, and the question asked is
          the width the LIST has, not the viewport's. `xl:` knows neither the
          sidebar nor the size of the text in it; Tailwind's container
          thresholds are in rem, so at a 32px root `@xl` is 1024px and the row
          drops back to two across instead of spilling. (The grid held six
          tiles when this comment was written, where the widest value,
          `14.40 req/s`, wrapped in a ~150px column and left one tile's hint out
          of step with its neighbours' — four tiles clear that with room.)

          `@container` GOES ON THE `<section>`, NOT ON THIS `<dl>`. A container
          query cannot query the element that declares the context — put both
          on one element and the variant simply never matches, silently. Done
          that way first here, and it cost `run-tables.spec.ts`'s M01 geometry
          bound: the tiles fell to two columns at every width, which made the
          block tall enough to push the run totals past 900px. */}
      {/* ═══ THE ORDER IS GE's, AND SO IS THE COUNT ═══
       *
       * GE's Summary shows exactly four numbers — error ratio, total requests,
       * max concurrent users, p95 — and this row shows the same four in the
       * same order, so a reader moving between the two products finds each
       * number in the same place. Throughput, p99 and mean are in the Report's
       * statistics table, one section away; they were tiles here (six, with p95
       * promoted to first by the 09-13 review's target layout) and the Summary
       * is a summary — more numbers do not make a faster read.
       *
       * WHAT THE CUT COSTS, STATED RATHER THAN GLOSSED: the tint and the delta
       * the removed tiles carried go with them. A gate on throughput, p99 or
       * mean still judges the run and still shows in Platform gates; it just no
       * longer colours a number up here. `slaTone` keeps its other callers.
       *
       * ═══ AND "LOWER EMPHASIS" STAYS DECLINED ═══
       *
       * Colour is reserved for SLA `tone`, which `StatTile`'s own docstring
       * argues at length ("colouring a number red is a JUDGEMENT, and the
       * platform has only made one where a rule exists"), and size would break
       * the common baseline `mt-auto` on the hint exists to keep. Position IS
       * the emphasis this grid has. First is first. */}
      <dl className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        <StatTile
          label="Error rate"
          // The field and expression `StatisticsTable`'s `% KO` column uses
          // (`r.errorRate * 100`), at the same two-decimal precision — never
          // `koCount / count`, which would be a second definition of one
          // number sitting a few hundred pixels from the first.
          value={`${(run.errorRate * 100).toFixed(2)}%`}
          tone={slaTone(assertions, 'error_rate')}
          delta={vs(deltaFor(run.errorRate, baseline?.errorRate, 'lower'))}
          data-testid="stat-error-rate"
        />
        <StatTile
          label="Requests"
          value={formatCount(run.count)}
          tone={slaTone(assertions, 'count')}
          /* "successful / failed", not "OK / KO" — review N01. Those two are
             Gatling's words, and nothing in this repo requires them: the PRD
             binds QUANTITIES (count, ok/ko count, % KO, count/second…) and
             both parity suites compare only numbers, never a label. The
             statistics table keeps them where a reader may be diffing this
             against Gatling's own report side by side; a totals tile is not
             that surface. */
          delta={vs(deltaFor(run.count, baseline?.count, 'neutral'))}
          data-testid="stat-total-requests"
        />
        <StatTile
          /* GE's "Max. concurrent V.U", in this product's words. From the users
             series (the Summary fetches it whole-run), not the statistics row,
             which carries no user count. No "vs previous": a cohort row records
             no peak, so there is nothing honest to compare against. */
          label="Peak users"
          value={peakUsers === null ? '—' : formatCount(peakUsers)}
          data-testid="stat-peak-users"
        />
        <StatTile
          /* "p95", the table's own word (review N01 asks for `p95 response
             time` and this deliberately falls short of it). MEASURED: at
             1280x800 a six-across grid gave each tile 147px and the label box
             113px, where "Mean response time" wrapped to two lines and pushed
             that tile's value 18px below its neighbours — the baseline defect
             this grid once recorded fixing. What the finding is actually about
             is DRIFT: one quantity spelled differently on each surface. This
             matches `StatisticsTable`'s column and `SLA_METRIC_SCALARS`' own
             names exactly, so the tile, the table and the metric a gate is
             authored against are one word. The long form belongs in PROSE,
             where `ProjectRules` already writes it out in full, and the `ms`
             unit beside the value is what says this is a time. */
          label="p95"
          value={percentileValue(run, 'p95')}
          unit={percentileUnit(run, 'p95')}
          tone={slaTone(assertions, 'p95')}
          info={<InfoTip label="About p95">{P95_INFO}</InfoTip>}
          delta={vs(deltaFor(percentileMs(run, 'p95'), percentileMs(baseline, 'p95'), 'lower'))}
          data-testid="stat-p95"
        />
      </dl>

      {baseline != null && (
        <ComparisonNote previous={baseline} here={current ?? null} previousName={baselineName(baseline)} />
      )}
    </section>
  );
}

/**
 * A percentile tile's value, clamped exactly the way `StatisticsTable`'s own
 * percentile columns are: a percentile of a sample cannot lie outside that
 * sample's own minimum and maximum, and `clampPercentile` projects the raw
 * estimate onto the run row's own range (`clampPercentile`'s doc explains
 * why). Reusing it — rather than re-deriving the clamp here — is what keeps
 * the p95 tile from disagreeing with the "All Requests" row of the Report's
 * statistics table, which clamps through the same function: the reference run's
 * raw p99 reads 2515 against a maximum of 2503, and it is the exact
 * disagreement this whole component exists to rule out.
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

/** The baseline's name: its number, or "previous run" for one that predates numbering. */
function baselineName(previous: TrendRun): string {
  return previous.runNumber !== null && previous.runNumber !== undefined ? runName(previous.runNumber) : 'previous run';
}

/** A tile's change against the baseline, before it is joined to the run it names. */
type Delta = { readonly change: string; readonly tone: DeltaTone };

/** p95's caveat, behind its tile's ⓘ — the one estimate on the row. */
const P95_INFO =
  'p95 is estimated from a sketch of the whole run, accurate to within 1%, and shown clamped to the ' +
  'run’s own minimum and maximum. Error rate, requests and peak users are counted, not estimated.';

/**
 * WHAT A READER NEEDS BEFORE TRUSTING A DELTA — and nothing when there is
 * nothing to say (clean UI, PR 2).
 *
 * The baseline note used to be a sentence under the tiles on every run ("“vs
 * previous” is Run 10 (started …) — the one that started immediately before
 * this in this test"). The deltas name their run now, so what is left is
 * comparability: a short visible chip when the two runs actually DIFFER, which
 * changes whether a delta can be trusted (the text rule's data-integrity
 * exception), and an ⓘ listing every finding — differences and what was not
 * recorded alike. No finding, no row.
 */
function ComparisonNote({
  previous,
  here,
  previousName,
}: {
  readonly previous: TrendRun;
  readonly here: TrendRun | null;
  readonly previousName: string;
}) {
  const notable = (here === null ? [] : comparability([here, previous])).filter(
    (finding) => finding.kind !== 'same',
  );
  if (notable.length === 0) return null;
  const differs = notable.filter((finding) => finding.kind === 'differs');
  const details = notable
    .map((finding) => `${finding.label}: this run ${finding.values[0] ?? 'unknown'}, ${previousName} ${finding.values[1] ?? 'unknown'}`)
    .join('. ');
  return (
    <div data-testid="comparison-note" className="mt-3 flex flex-wrap items-center gap-2 text-[0.75rem]">
      {differs.length > 0 && (
        <span
          data-testid="comparison-differs"
          /* On the CARD surface, not `bg-sunken`: the pending tone measures
             4.44:1 on the sunken fill in the light theme, under AA's 4.5 for
             text this size, and 5.02:1 on the card. */
          className="rounded-md border border-default bg-surface px-2 py-0.5 font-medium"
          style={{ color: 'var(--color-status-pending)' }}
        >
          {summariseConditions(differs)}
        </span>
      )}
      <InfoTip label={`About the comparison with ${previousName}`}>{`${details}.`}</InfoTip>
    </div>
  );
}

function deltaFor(
  current: number | undefined,
  previous: number | undefined,
  better: 'higher' | 'lower' | 'neutral',
): Delta | undefined {
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
  return { change: `${sign}${rounded.toFixed(1)}%`, tone: deltaTone(rounded, better) };
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
 * ═══ THE TINT AND THE VALUE JUDGE THE SAME POPULATION, BECAUSE THE SUMMARY IS
 * ALWAYS THE WHOLE RUN ═══
 *
 * An SLA assertion is evaluated once, against the run, at finalize — nothing
 * re-evaluates it per window, since the rule's threshold is a statement about
 * the run. While this row could be narrowed to a window the VALUE in a tile was
 * that stretch's and the TINT the whole run's — a p95 tile showing a perfectly
 * healthy ten seconds, coloured as a breach because a different ten seconds
 * broke the gate — so every caller withheld the tint under one. The Summary
 * never carries a window now (GE's does not), so there is nothing to withhold
 * and every caller passes `assertions` as it is. The Report's window does not
 * reach this component.
 *
 * Not recomputed per anything, either: recomputing would invent a verdict
 * nobody configured — the "a platform gate is the organisation's policy" line
 * this repo already draws between SLA gates and simulation checks.
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
