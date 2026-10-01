import type { ReactElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, StatsResponse, TrendRun } from '@perfportal/contracts';
import { isResolvableSlaMetric } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import RunStats from '../src/routes/RunStats';

const stats = reference.stats as StatsResponse;
const runRow = stats.stats.find((r) => r.scope === 'run')!;

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx).
// Card.test.tsx/Badge.test.tsx get away without this by keeping each test's
// visible TEXT distinct, but that convention only helps `getByText` — every
// test here renders the same four tiles under the same fixed `data-testid`s
// (`stat-total-requests` etc.), so a leftover mount from an earlier test
// collides on `screen.getByTestId` regardless of what the hint text says.
afterEach(cleanup);

/** A repo-root-relative path, wherever the runner was invoked from. */
function fromRepo(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, rel))) return resolve(dir, rel);
    dir = resolve(dir, '..');
  }
  throw new Error(`could not find ${rel} from ${process.cwd()}`);
}

/**
 * EVERY MOUNT GOES THROUGH A ROUTER, including the cases that pass no baseline.
 *
 * The note under the tiles links to the run the deltas were measured against,
 * and a `<Link>` outside a router throws `Cannot destructure property
 * 'basename' of React.useContext(...)` — a message naming react-router's
 * internals rather than the missing provider, which is a poor thing to hand
 * whoever adds the next baseline case. One helper means they cannot meet it.
 */
function renderStats(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * A cohort row carrying THIS run's own numbers, so a delta is never what a
 * conditions case is really asserting. Only the provenance varies.
 */
function trendRun(over: Partial<TrendRun> = {}): TrendRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-08-07T05:30:02.171Z',
    toolStartedAt: '2026-08-07T05:30:02.171Z',
    durationMs: 60_000,
    verdict: 'passed',
    count: runRow.count,
    okCount: runRow.okCount,
    koCount: runRow.koCount,
    errorRate: runRow.errorRate,
    minMs: runRow.minMs,
    maxMs: runRow.maxMs,
    meanMs: runRow.meanMs,
    throughputRps: runRow.throughputRps,
    percentiles: runRow.percentiles,
    ...over,
  };
}

describe('RunStats', () => {
  it('shows the run row’s own totals', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    // Plain digits — `String(runRow.count)`, not `.toLocaleString()`. The
    // fixture's run has 895 requests, where the two happen to produce the
    // same string; the test below (four digits or more) is what actually
    // pins the rule, because at 895 a locale-grouped and a plain rendering
    // are indistinguishable.
    expect(screen.getByTestId('stat-total-requests')).toHaveTextContent(String(runRow.count));
  });

  /**
   * Review finding (Critical, first review round): `run.count.toLocaleString()`
   * rendered "1,234" for a four-digit run while `StatisticsTable`'s Total
   * column — `formatCount = String(value)`, deliberately no grouping
   * separator (StatisticsTable.tsx's own docstring on `formatCount` explains
   * why) — rendered "1234". The fixture's run has 895 requests and the e2e
   * seed uses the same Gatling log, so both stayed under 1000 by coincidence
   * and nothing above this test caught the disagreement.
   *
   * A SYNTHETIC row, not a written-down fixture value: the reference fixture
   * has no four-digit count to read, so covering this case means constructing
   * one — the expectation is still computed FROM that constructed value
   * (`String(bigCount)`), never hard-coded as a separate literal.
   */
  it('writes a four-digit-or-more count in plain digits, the same way the table does', () => {
    const bigCount = 12345;
    const bigOk = 12000;
    const bigKo = 345;
    const bigRun: StatsResponse = {
      ...stats,
      stats: stats.stats.map((row) =>
        row.scope === 'run' ? { ...row, count: bigCount, okCount: bigOk, koCount: bigKo } : row,
      ),
    };
    renderStats(<RunStats stats={bigRun} peakUsers={12} runStatus="complete" />);

    const tile = screen.getByTestId('stat-total-requests');
    expect(tile).toHaveTextContent(String(bigCount));
    // The line above alone already distinguishes the two — "12345" is not a
    // substring of "12,345", so `.toLocaleString()`'s comma would fail it —
    // but stating the exclusion directly makes the regression's actual shape
    // ("a comma appeared") visible in the failure message rather than left to
    // be inferred from a plain string mismatch.
    expect(tile.textContent).not.toMatch(/,/);

    /* Same rule applies to the hint text (`okCount`/`koCount`), the "lower
       stakes" half of the same defect the review flagged.

       THE WORDS MOVED AND THE CLAIM DID NOT. This read `${bigOk} OK, ${bigKo}
       KO` until review N01 replaced Gatling's vocabulary with the product's
       own on this tile — so the assertion is written against the NUMBERS and a
       loose separator, which is what it was always about. Pinning the two
       words here would have made the suite the reason they could not be
       corrected, the trap CLAUDE.md records for the run-health caveat. */
    expect(screen.getByText(new RegExp(`\\b${bigOk}\\b.*\\b${bigKo}\\b`))).toBeInTheDocument();
    expect(screen.getByTestId('stat-total-requests').textContent).not.toMatch(/\bKO\b|\bOK\b/);
  });

  /**
   * The tile and the `% KO` column of the statistics table below it are the
   * SAME quantity, and must be read from the same place: the payload's own
   * `errorRate` field, times 100, to two decimals — which is exactly what
   * `StatisticsTable`'s `% KO` column does (`value: (r) => r.errorRate * 100`).
   *
   * NOT `koCount / count`. That is arithmetically the same number today and
   * would still be a second definition of it, sitting a few hundred pixels
   * from the first, free to disagree the day the server's rounding changes.
   */
  it('reads error rate from the same field the table does', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    const expected = (runRow.errorRate * 100).toFixed(2);
    expect(screen.getByTestId('stat-error-rate')).toHaveTextContent(expected);
  });

  it('shows comparison deltas when a previous cohort run is provided', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        baseline={{
          id: '11111111-1111-4111-8111-111111111111',
          startedAt: '2026-08-07T05:30:02.171Z',
          toolStartedAt: '2026-08-07T05:30:02.171Z',
          durationMs: 60_000,
          verdict: 'passed',
          count: runRow.count,
          okCount: runRow.okCount,
          koCount: runRow.koCount,
          errorRate: runRow.errorRate / 2,
          minMs: runRow.minMs,
          maxMs: runRow.maxMs,
          meanMs: runRow.meanMs * 2,
          throughputRps: runRow.throughputRps / 2,
          percentiles: {
            p95: (runRow.percentiles.p95 ?? 0) * 2,
            p99: (runRow.percentiles.p99 ?? 0) * 2,
          },
        }}
      />,
    );

    expect(screen.getAllByText('+100.0% vs previous').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-50.0% vs previous').length).toBeGreaterThan(0);
  });

  /**
   * THE TILE AND THE PERCENTAGE UNDER IT READ THE SAME NUMBER.
   *
   * The percentile tile (p95, with a p99 beside it until the Summary was cut
   * to four) displays `clampPercentile(raw, row)` — an estimate
   * projected onto the sample's own exactly-tracked [min, max], for the
   * reasons `StatisticsTable`'s own docstring gives — while the delta was
   * computed from the RAW map on both sides. `StatisticsTable` records the
   * reference run reporting p99 2515.4 against a max of 2503, so this was a
   * tile reading "2503 ms" over a percentage derived from 2515.4.
   *
   * The fixture below is built so the clamp BITES on the baseline: its raw
   * p95 sits above its own `maxMs`, and its clamped value is exactly half
   * this run's clamped one. Both expectations are computed from the fixture,
   * not written down.
   */
  /**
   * ═══ THE CONDITIONS THE DELTA WAS MEASURED UNDER (review.md 4) ═══
   *
   * "vs previous" hid everything a reader needs to judge relevance: a -12%
   * against the same nightly and a -12% against a different branch in a
   * different environment at half the load render identically. `comparability`
   * has answered exactly this on Compare since the review-criticals branch;
   * this is that answer at the first place a reader meets a delta.
   *
   * ASSERTED ON THE SUMMARY, which is the line visible without opening
   * anything — a disclosure whose closed state says only "details" would put
   * the finding one click away from the reader who does not know to look.
   */
  it('names what differed between this run and the baseline it compares against', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        current={trendRun({ environment: 'staging', branch: 'feature/cart-rewrite', commitSha: 'abcdef1234' })}
        baseline={trendRun({ environment: 'production', branch: 'main', commitSha: 'beefcafe99' })}
      />,
    );

    const note = screen.getByTestId('baseline-differences');
    expect(note).toHaveTextContent('Different environment, branch and build');
    // The values are a click away, and they say which run is which — a list of
    // bare values would leave the reader to guess the order.
    expect(note).toHaveTextContent('this run staging, previous production');
  });

  /**
   * AND IT IS SILENT WHEN THE TWO RUNS AGREE, which is what makes the case
   * above mean anything: a note that always warned would be ignored inside a
   * week, and a permanent "these runs are comparable" is the undifferentiated
   * chrome review.md 20 objects to.
   *
   * The identification is asserted in the same breath BECAUSE it is
   * unconditional — without it this would pass just as happily against a
   * component that rendered nothing at all.
   */
  it('names the baseline by its number, with when it started', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        current={trendRun({ runNumber: 12 })}
        baseline={trendRun({ id: '22222222-2222-4222-8222-222222222222', runNumber: 11 })}
      />,
    );
    const note = screen.getByTestId('baseline-note');
    expect(note).toHaveTextContent(/“vs previous” is Run 11 \(started /);
    expect(screen.getByRole('link', { name: /^Run 11 \(started / })).toHaveAttribute(
      'href',
      '/runs/22222222-2222-4222-8222-222222222222',
    );
  });

  it('says nothing about conditions when the baseline matches on every one', () => {
    const shared = { environment: 'staging', branch: 'main', commitSha: 'abcdef1234' };
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        current={trendRun(shared)}
        baseline={trendRun({ ...shared, id: '22222222-2222-4222-8222-222222222222' })}
      />,
    );

    expect(screen.queryByTestId('baseline-differences')).toBeNull();
    expect(screen.getByTestId('baseline-note')).toHaveTextContent('vs previous');
  });

  it('computes percentile deltas from the clamped values the tiles show', () => {
    const clamped = Math.min(Math.max(runRow.percentiles.p95!, runRow.minMs), runRow.maxMs);
    // Raw double the target, but a max that clamps it back down to it — so a
    // delta read off the raw map and one read off the clamp differ, loudly.
    const baselineClamped = clamped * 2;
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        baseline={{
          id: '11111111-1111-4111-8111-111111111111',
          startedAt: '2026-08-07T05:30:02.171Z',
          toolStartedAt: '2026-08-07T05:30:02.171Z',
          durationMs: 60_000,
          verdict: 'passed',
          count: runRow.count,
          okCount: runRow.okCount,
          koCount: runRow.koCount,
          errorRate: runRow.errorRate,
          minMs: runRow.minMs,
          maxMs: baselineClamped,
          meanMs: runRow.meanMs,
          throughputRps: runRow.throughputRps,
          percentiles: { p95: baselineClamped * 4, p99: baselineClamped * 4 },
        }}
      />,
    );

    // Guard first: the fixture only proves anything if the raw and clamped
    // baselines really do disagree.
    expect(baselineClamped * 4).toBeGreaterThan(baselineClamped);
    // `.parentElement`: `stat-p95` names the <dd> that holds the VALUE, and
    // the delta is its sibling inside the tile — so the assertion has to be
    // scoped to the tile to be about this metric rather than any of the four.
    const tile = screen.getByTestId('stat-p95').parentElement!;
    // clamped vs 2 * clamped is -50.0%. Read off the raw map it would be
    // about -87.5%, a number matching neither value on screen.
    expect(tile).toHaveTextContent('-50.0% vs previous');
  });

  /**
   * SLA PROXIMITY TINTS THE VALUE, AND ONLY WHERE A RULE ACTUALLY EXISTS.
   *
   * The redesign's screens colour a metric red when its gate failed and amber
   * when it is close to breaching. Both are JUDGEMENTS, so a tile may only
   * carry one when the run carries a rule that made it — which is what the
   * "no rule leaves it untinted" case pins.
   *
   * THE ERROR-RATE CASE IS THE ONE THAT MATTERS MOST. This was first written
   * believing the platform could not judge an error rate, because
   * `AssertionSchema`'s FAMILY enum has no `error_rate` member. That confused
   * the two axes: family picks the stat ROW, `metric` picks the value, and
   * `packages/sla/src/metrics.ts`'s `SCALARS` has always carried `error_rate`
   * and `throughput_rps`. A gate on the error rate needs no new family and no
   * migration, and this case is here so nobody re-derives the wrong
   * conclusion from the enum.
   */
  const rule = (over: Partial<Assertion['rule']> & { metric: string }): Assertion['rule'] => ({
    scope: 'run',
    targetName: null,
    family: 'response_time',
    comparator: 'lte',
    threshold: 1000,
    ...over,
  });

  const assertion = (over: Partial<Assertion> & { rule: Assertion['rule'] }): Assertion => ({
    ruleId: '11111111-1111-4111-8111-111111111111',
    outcome: 'passed',
    actualValue: 100,
    message: 'checked',
    ...over,
  });

  const colourOf = (testId: string) =>
    screen.getByTestId(testId).style.color;

  /**
   * ═══ REVIEW 09-13 N02 — THE METHODOLOGY ONCE, NOT ONCE PER TILE ═══
   *
   * The percentile tiles carried "an estimate, accurate to within 1%": the
   * same sentence twice, in a row where every other hint is a fact about its
   * own tile. (One percentile tile is left, and the claim is unchanged.)
   *
   * BOTH HALVES MATTER AND THE TEST SAYS SO. Deleting the caveat would also
   * satisfy "stop repeating it" and would be wrong — a reader would then take
   * p95 as exact — so the tiles must still mark the value as an estimate, and
   * the 1% claim must still be reachable. It is a claim about this platform
   * rather than a disclaimer: the tool's own percentiles are histogram
   * estimates and drift further.
   */
  it('marks the percentile as an estimate without repeating the methodology', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);

    const tile = screen.getByTestId('stat-p95');
    expect(tile.parentElement?.textContent ?? '').toMatch(/estimate/i);
    // The sentence appears nowhere on the row any more...
    expect(document.body.textContent ?? '').not.toMatch(/an estimate, accurate to within/i);
    // ...and the 1% claim is still reachable, exactly once.
    const method = screen.getByTestId('percentile-method');
    expect(method.textContent ?? '').toMatch(/within 1%/);
    expect(document.body.textContent?.match(/within 1%/g) ?? []).toHaveLength(1);
  });

  /** NO HEADING. `RunSummary.test.tsx` asserts the Summary's heading outline
   *  verbatim, and a disclosure that contributed one would break it — the
   *  shell-must-not-add-an-h2 rule, one component over. */
  it('adds the disclosure without contributing a heading', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    expect(screen.getByTestId('percentile-method').tagName).toBe('DETAILS');
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('tints a metric whose SLA rule failed, and leaves an ungated one alone', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        assertions={[
          assertion({ outcome: 'failed', actualValue: 659, rule: rule({ metric: 'p95' }) }),
        ]}
      />,
    );
    expect(colourOf('stat-p95')).toContain('--color-status-failed');
    // The error rate carries no rule at all, so it must stay untinted — the
    // negative half, without which "everything is red" would also pass.
    expect(colourOf('stat-error-rate')).toBe('');
  });

  it('warns amber while a gate is passing but close, and stays clear when it is not', () => {
    // 950 against an `lte 1000` gate is inside the 10% margin; an error rate
    // of 0.1% against a 5% limit is nowhere near it.
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        assertions={[
          assertion({ actualValue: 950, rule: rule({ metric: 'p95', threshold: 1000 }) }),
          assertion({
            ruleId: '22222222-2222-4222-8222-222222222222',
            actualValue: 0.001,
            rule: rule({ metric: 'error_rate', threshold: 0.05 }),
          }),
        ]}
      />,
    );
    expect(colourOf('stat-p95')).toContain('--color-status-pending');
    expect(colourOf('stat-error-rate')).toBe('');
  });

  it('judges error rate, which needs no new rule family', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        assertions={[
          assertion({ outcome: 'failed', actualValue: 0.05, rule: rule({ metric: 'error_rate' }) }),
        ]}
      />,
    );
    expect(colourOf('stat-error-rate')).toContain('--color-status-failed');
  });

  /**
   * `latency` and `response_time` both have a p95 and they are different
   * measurements — first byte against the whole exchange. A gate on one must
   * not tint the tile showing the other, which is why `slaTone` filters on
   * family as well as metric even though metric alone would "work" today
   * (nothing emits `latency` yet).
   */
  it('ignores a rule on a different family that shares the metric name', () => {
    renderStats(
      <RunStats
        stats={stats}
        peakUsers={12}
        runStatus="complete"
        assertions={[
          assertion({
            outcome: 'failed',
            actualValue: 659,
            rule: rule({ metric: 'p95', family: 'latency' }),
          }),
        ]}
      />,
    );
    expect(colourOf('stat-p95')).toBe('');
  });

  /**
   * THE SUMMARY HAS NO STATISTICS TABLE BESIDE IT ANY MORE, so a missing
   * run-scope row cannot return nothing and leave "the table's own message" to
   * say so: the table is in the Report. This is the only place an empty run is
   * said, and it says it in the table's own words (`StatisticsEmpty`) so the two
   * can never describe one empty run two ways. A run whose stream stopped kept
   * nothing — "recorded" would tell a reader who watched 440 requests go by
   * that none existed.
   */
  it('renders the table’s own empty sentence when the run kept nothing', () => {
    renderStats(<RunStats stats={{ ...stats, stats: [] }} peakUsers={null} runStatus="incomplete" />);
    expect(screen.getByText('No statistics were retained for this run')).toBeVisible();
    expect(screen.queryByTestId('stat-p95')).toBeNull();
  });

  // The other half: a finished run that simply measured nothing says
  // "recorded", and a component that ignored `runStatus` would say "retained"
  // here (or "recorded" above) and pass whichever case it was written against.
  it('says a finished run recorded nothing, rather than that it kept nothing', () => {
    renderStats(<RunStats stats={{ ...stats, stats: [] }} peakUsers={null} runStatus="complete" />);
    expect(screen.getByText('No statistics were recorded for this run')).toBeVisible();
    expect(screen.queryByText('No statistics were retained for this run')).toBeNull();
  });

  /* ====================================================================== *
   * REVIEW N01 — ONE QUANTITY, ONE WORD, ACROSS EVERY SURFACE
   * ====================================================================== */

  /**
   * The finding is DRIFT: the same number spelled differently wherever it
   * appears. Requests per second was `Mean Throughput` here, `Cnt/s` in the
   * statistics table, `req/s` on the chart axis and `requests per second` in a
   * chart title — four names, one measurement.
   *
   * These cases pin the JOIN rather than the strings. A tile label asserted
   * verbatim would pass while the table below it drifted, which is the defect
   * itself; asserted against the contract's own metric check
   * (`isResolvableSlaMetric`), it cannot. That is the vocabulary a reader
   * authors a gate in (`ProjectRules`' `METRIC_SUGGESTIONS`), so matching it
   * means the word on the tile is the word they type into the rule that judges
   * it. (The throughput tile this once also pinned is gone — see the Summary's
   * four.)
   */
  it('names the response-time tile after the metric a gate is authored against', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    const labels = [...document.querySelectorAll('section[aria-label="Run totals"] dt')].map(
      (dt) => (dt.textContent ?? '').trim(),
    );

    // p95 is a resolvable percentile metric. (Mean and p99 had tiles that made
    // the same claim until the Summary was cut to GE's four numbers; the
    // Report's table still carries both, under the same words.)
    expect(isResolvableSlaMetric('p95')).toBe(true);
    // Case-insensitive: the claim is that they are the same WORD.
    expect(labels.map((l) => l.toLowerCase())).toContain('p95');
  });

  /**
   * ═══ GATLING'S WORDS ARE NOT THIS SURFACE'S WORDS ═══
   *
   * N01 allows OK/KO to stay "only when explicitly needed for Gatling parity".
   * Measured, parity needs them NOWHERE in the UI: the PRD binds QUANTITIES
   * (count, OK/KO count, % KO, count/second, min/max/mean/stddev, indicator
   * bands, error counts, and the numeric distribution bin midpoints), and both
   * parity suites — `apps/api/test/parity.e2e.test.ts` and
   * `packages/statistics/test/parity.test.ts` — compare only numbers. Neither
   * contains a single assertion against the string `OK`, `KO` or `Cnt/s`.
   *
   * The statistics table is a different argument and keeps them: a reader may
   * be diffing it against Gatling's own HTML report column by column. A totals
   * tile is not that surface, so it speaks the product's own language.
   */
  it('states successes and failures in the product’s words, not the tool’s', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    const section = document.querySelector('section[aria-label="Run totals"]')!;
    const text = section.textContent ?? '';

    expect(text).toMatch(/successful/i);
    expect(text).toMatch(/failed/i);
    // As a WORD — `\b` so a future "OKAY" or a hex id cannot satisfy it.
    expect(text).not.toMatch(/\bOK\b/);
    expect(text).not.toMatch(/\bKO\b/);
  });
});

/**
 * THE SUMMARY SHOWS GE'S FOUR NUMBERS, IN GE'S ORDER.
 *
 * This row held six tiles in the 09-13 review's target order (p95, error rate,
 * throughput, requests, p99, mean) until the Summary was cut to what GE's shows:
 * error ratio, total requests, max concurrent users, p95. A reader moving
 * between the two products finds each number in the same place, and throughput,
 * p99 and mean are in the Report's table.
 *
 * NOTHING PINNED THE ORDER BEFORE EITHER, which is how the six-tile row came to
 * put the triage number fourth against a section of the review nobody had
 * audited. Every other assertion in this file and in the e2e suite reaches
 * these tiles by `data-testid`, and `run-tables.spec.ts`'s M01 bound checks that
 * three of them sit inside the first 900px: a claim about POSITION, satisfied by
 * any sequence.
 */
describe('RunStats — the tile reading order', () => {
  const stats = reference.stats as StatsResponse;

  /* Asserted as the WHOLE list with `toEqual`, not as "error rate comes first".
     A containment or pairwise check passes against several other orderings, and
     the property worth keeping is the reading order itself — the argument
     `run-charts.spec.ts` already makes for asserting `CHART_IDS` as a list so
     a reorder cannot pass silently. */
  it('leads with GE’s four, in GE’s order', () => {
    renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    const ids = [
      ...document.querySelectorAll('section[aria-label="Run totals"] dd[data-testid^="stat-"]'),
    ].map((dd) => dd.getAttribute('data-testid'));
    expect(ids).toEqual(['stat-error-rate', 'stat-total-requests', 'stat-peak-users', 'stat-p95']);
    const labels = [
      ...document.querySelectorAll('section[aria-label="Run totals"] dt'),
    ].map((dt) => (dt.textContent ?? '').trim());
    expect(labels).toEqual(['Error rate', 'Requests', 'Peak users', 'p95']);
  });

  it('shows the peak users it is handed, and a dash while it has none', () => {
    const { unmount } = renderStats(<RunStats stats={stats} peakUsers={12} runStatus="complete" />);
    expect(screen.getByTestId('stat-peak-users')).toHaveTextContent('12');
    unmount();
    renderStats(<RunStats stats={stats} peakUsers={null} runStatus="complete" />);
    // A dash, never `0`: zero is a measurement, and the users series has either
    // not arrived or recorded no bucket.
    expect(screen.getByTestId('stat-peak-users')).toHaveTextContent('—');
    expect(screen.getByTestId('stat-peak-users')).not.toHaveTextContent('0');
  });

  /**
   * ═══ AND THE LIVE ROW IS THE SAME SECTION, SO IT HAS THE SAME FOUR ═══
   *
   * `RunSummary` draws its own four tiles for a run that is still streaming,
   * into `aria-label="Run totals so far"` — which BECOMES the `"Run totals"`
   * above the moment the run goes terminal. So a reader watching a run finish
   * watches one `<dl>` turn into the other. The two used to share four
   * quantities out of six and substitute two (peak users for throughput,
   * duration for mean); the branch that promoted p95 to first on the finished
   * row left it fifth on the live one, so the triage number jumped 5 -> 1 at the
   * transition. Both rows are GE's four now, so the transition substitutes
   * NOTHING, and the claim is exact agreement.
   *
   * ASSERTED AS AGREEMENT, NOT AS A SECOND LITERAL LIST. Pinning the live order
   * verbatim here would pass the day somebody reorders the finished row and
   * updates only the list beside it, which is the drift being fixed. The two
   * lists compared against each other fail whichever side moves.
   *
   * Read from the source rather than rendered: the live row needs a router, a
   * run, a delta and a live socket to mount, and the claim is about the markup
   * order of two files. Comments are stripped — MEASURED, and NOT load-bearing
   * today, because neither file spells a `data-testid` inside one. It is one
   * line, it forecloses the trap this file records twice, and saying it is
   * defensive beats adding prose to make the claim true.
   */
  it('keeps the live row exactly the finished row’s four, in the same places', () => {
    const idsIn = (rel: string, prefix: string): string[] => {
      const src = readFileSync(fromRepo(rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const pattern = new RegExp(`data-testid="(${prefix}[a-z0-9-]+)"`, 'g');
      return [...src.matchAll(pattern)].map((m) => m[1] ?? '');
    };

    const terminal = idsIn('apps/web/src/routes/RunStats.tsx', 'stat-');
    const live = idsIn('apps/web/src/routes/RunSummary.tsx', 'live-stat-');

    /* VACUITY, COUNTING THE CONSTRUCT. A regex that stopped matching leaves two
       EMPTY lists, and an equality between them then agrees perfectly. */
    expect(terminal, 'collected no terminal tiles -- the scan has rotted').toHaveLength(4);
    expect(live, 'collected no live tiles -- the scan has rotted').toHaveLength(4);

    expect(live.map((id) => id.replace('live-', ''))).toEqual(terminal);
  });

  /* The DOM order is the READING order only because these are grid items in
     source order — no `order-*` utility anywhere in the row. A tile moved
     visually by CSS while the markup stayed put would satisfy the case above
     and mislead every sighted reader, and jsdom computes no layout at all, so
     this reads the source rather than the screen.

     Comments are stripped first. This file already records that trap twice —
     a source-scanning assertion that matched the paragraph documenting the
     defect instead of the product. */
  it('orders them by markup, not by a css override', () => {
    const here = readFileSync(fromRepo('apps/web/src/routes/RunStats.tsx'), 'utf8');
    const code = here.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\border-\d/);
    expect(code).not.toMatch(/\bflex-col-reverse\b/);
  });
});
