import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, StatsResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import RunStats from '../src/routes/RunStats';

const stats = reference.stats as StatsResponse;
const runRow = stats.stats.find((r) => r.scope === 'run')!;

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx).
// Card.test.tsx/Badge.test.tsx get away without this by keeping each test's
// visible TEXT distinct, but that convention only helps `getByText` — every
// test here renders the same six tiles under the same fixed `data-testid`s
// (`stat-total-requests` etc.), so a leftover mount from an earlier test
// collides on `screen.getByTestId` regardless of what the hint text says.
afterEach(cleanup);

describe('RunStats', () => {
  it('shows the run row’s own totals', () => {
    render(<RunStats stats={stats} />);
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
    render(<RunStats stats={bigRun} />);

    const tile = screen.getByTestId('stat-total-requests');
    expect(tile).toHaveTextContent(String(bigCount));
    // The line above alone already distinguishes the two — "12345" is not a
    // substring of "12,345", so `.toLocaleString()`'s comma would fail it —
    // but stating the exclusion directly makes the regression's actual shape
    // ("a comma appeared") visible in the failure message rather than left to
    // be inferred from a plain string mismatch.
    expect(tile.textContent).not.toMatch(/,/);

    // Same rule applies to the hint text (`okCount`/`koCount`), the "lower
    // stakes" half of the same defect the review flagged.
    expect(screen.getByText(`${bigOk} OK, ${bigKo} KO`)).toBeInTheDocument();
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
    render(<RunStats stats={stats} />);
    const expected = (runRow.errorRate * 100).toFixed(2);
    expect(screen.getByTestId('stat-error-rate')).toHaveTextContent(expected);
  });

  it('shows comparison deltas when a previous cohort run is provided', () => {
    render(
      <RunStats
        stats={stats}
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
   * The p95/p99 tiles display `clampPercentile(raw, row)` — an estimate
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
  it('computes percentile deltas from the clamped values the tiles show', () => {
    const clamped = Math.min(Math.max(runRow.percentiles.p95!, runRow.minMs), runRow.maxMs);
    // Raw double the target, but a max that clamps it back down to it — so a
    // delta read off the raw map and one read off the clamp differ, loudly.
    const baselineClamped = clamped * 2;
    render(
      <RunStats
        stats={stats}
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
    // scoped to the tile to be about this metric rather than any of the six.
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

  it('tints a metric whose SLA rule failed, and leaves an ungated one alone', () => {
    render(
      <RunStats
        stats={stats}
        assertions={[
          assertion({ outcome: 'failed', actualValue: 659, rule: rule({ metric: 'p95' }) }),
        ]}
      />,
    );
    expect(colourOf('stat-p95')).toContain('--color-status-failed');
    // p99 carries no rule at all, so it must stay untinted — the negative
    // half, without which "everything is red" would also pass.
    expect(colourOf('stat-p99')).toBe('');
  });

  it('warns amber while a gate is passing but close, and stays clear when it is not', () => {
    // 950 against an `lte 1000` gate is inside the 10% margin; 500 is not.
    render(
      <RunStats
        stats={stats}
        assertions={[
          assertion({ actualValue: 950, rule: rule({ metric: 'p95', threshold: 1000 }) }),
          assertion({
            ruleId: '22222222-2222-4222-8222-222222222222',
            actualValue: 500,
            rule: rule({ metric: 'p99', threshold: 1000 }),
          }),
        ]}
      />,
    );
    expect(colourOf('stat-p95')).toContain('--color-status-pending');
    expect(colourOf('stat-p99')).toBe('');
  });

  it('judges error rate and throughput, which need no new rule family', () => {
    render(
      <RunStats
        stats={stats}
        assertions={[
          assertion({ outcome: 'failed', actualValue: 0.05, rule: rule({ metric: 'error_rate' }) }),
          assertion({
            ruleId: '33333333-3333-4333-8333-333333333333',
            outcome: 'failed',
            actualValue: 14,
            rule: rule({ metric: 'throughput_rps', comparator: 'gte', threshold: 40 }),
          }),
        ]}
      />,
    );
    expect(colourOf('stat-error-rate')).toContain('--color-status-failed');
    expect(colourOf('stat-throughput')).toContain('--color-status-failed');
  });

  /**
   * `latency` and `response_time` both have a p95 and they are different
   * measurements — first byte against the whole exchange. A gate on one must
   * not tint the tile showing the other, which is why `slaTone` filters on
   * family as well as metric even though metric alone would "work" today
   * (nothing emits `latency` yet).
   */
  it('ignores a rule on a different family that shares the metric name', () => {
    render(
      <RunStats
        stats={stats}
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

  it('renders nothing when the payload has no run-scope row', () => {
    const { container } = render(<RunStats stats={{ ...stats, stats: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
