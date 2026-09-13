import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, StatsResponse } from '@perfportal/contracts';
import { SLA_METRIC_SCALARS, isResolvableSlaMetric, slaMetricUnit } from '@perfportal/contracts';
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

/** A repo-root-relative path, wherever the runner was invoked from. */
function fromRepo(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, rel))) return resolve(dir, rel);
    dir = resolve(dir, '..');
  }
  throw new Error(`could not find ${rel} from ${process.cwd()}`);
}

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

  /**
   * ═══ REVIEW 09-13 N02 — THE METHODOLOGY ONCE, NOT ONCE PER TILE ═══
   *
   * Both percentile tiles carried "an estimate, accurate to within 1%": the
   * same sentence twice, in a row where every other hint is a fact about its
   * own tile.
   *
   * BOTH HALVES MATTER AND THE TEST SAYS SO. Deleting the caveat would also
   * satisfy "stop repeating it" and would be wrong — a reader would then take
   * p95 as exact — so the tiles must still mark the value as an estimate, and
   * the 1% claim must still be reachable. It is a claim about this platform
   * rather than a disclaimer: the tool's own percentiles are histogram
   * estimates and drift further.
   */
  it('marks each percentile as an estimate without repeating the methodology', () => {
    render(<RunStats stats={stats} />);

    for (const id of ['stat-p95', 'stat-p99']) {
      const tile = screen.getByTestId(id);
      expect(tile.parentElement?.textContent ?? '').toMatch(/estimate/i);
    }
    // The sentence appears nowhere on the row any more...
    expect(document.body.textContent ?? '').not.toMatch(/an estimate, accurate to within/i);
    // ...and the 1% claim is still reachable, exactly once.
    const method = screen.getByTestId('percentile-method');
    expect(method.textContent ?? '').toMatch(/within 1%/);
    expect(document.body.textContent?.match(/within 1%/g) ?? []).toHaveLength(1);
  });

  /** NO HEADING. `run-tables.spec.ts` asserts the Overview tab's heading
   *  outline verbatim, and a disclosure that contributed one would break it on
   *  every tab — the shell-must-not-add-an-h2 rule, one component over. */
  it('adds the disclosure without contributing a heading', () => {
    render(<RunStats stats={stats} />);
    expect(screen.getByTestId('percentile-method').tagName).toBe('DETAILS');
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

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
   * itself; asserted against `SLA_METRIC_SCALARS` and the percentile
   * suggestions, it cannot. That set is the vocabulary a reader authors a gate
   * in (`ProjectRules`' `METRIC_SUGGESTIONS`), so matching it means the word
   * on the tile is the word they type into the rule that judges it.
   */
  it('names each response-time tile after the metric a gate is authored against', () => {
    render(<RunStats stats={stats} />);
    const labels = [...document.querySelectorAll('section[aria-label="Run totals"] dt')].map(
      (dt) => (dt.textContent ?? '').trim(),
    );

    // `mean` is a scalar in the contract; p95/p99 are resolvable percentiles.
    expect(SLA_METRIC_SCALARS).toContain('mean');
    for (const metric of ['mean', 'p95', 'p99']) {
      expect(isResolvableSlaMetric(metric)).toBe(true);
      // Case-insensitive: the tile capitalises "Mean" as a label; the metric
      // is lower-case. The claim is that they are the same WORD.
      expect(labels.map((l) => l.toLowerCase())).toContain(metric);
    }
  });

  /**
   * `throughput_rps`'s unit in the contract is `req/s`, and the tile used to
   * say "Mean Throughput" with `req/s` as a separate unit — naming one
   * quantity twice and agreeing with neither the table nor the axis. It reads
   * `Requests/s` now, and the unit is gone because the label carries it.
   */
  it('gives throughput one name, not a label and a unit that disagree', () => {
    render(<RunStats stats={stats} />);
    const section = document.querySelector('section[aria-label="Run totals"]')!;
    const labels = [...section.querySelectorAll('dt')].map((dt) => (dt.textContent ?? '').trim());

    expect(labels).toContain('Requests/s');
    expect(slaMetricUnit('throughput_rps')).toBe('req/s');
    // Not repeated beside the value: "Requests/s 14.40 req/s" says it twice.
    expect(screen.getByTestId('stat-throughput').textContent ?? '').not.toMatch(/req\/s/);
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
    render(<RunStats stats={stats} />);
    const section = document.querySelector('section[aria-label="Run totals"]')!;
    const text = section.textContent ?? '';

    expect(text).toMatch(/successful/i);
    expect(text).toMatch(/failed/i);
    // As a WORD — `\b` so a future "OKAY" or a hex id cannot satisfy it.
    expect(text).not.toMatch(/\bOK\b/);
    expect(text).not.toMatch(/\bKO\b/);
  });

  /**
   * ═══ A BRIDGE NAMES THE OTHER END, SO IT BREAKS WHEN THAT END MOVES ═══
   *
   * `StatisticsTable`'s `Cnt/s` column keeps Gatling's spelling and carries a
   * hint pointing at this row — "the same measurement the run totals call X" —
   * so a reader does not have to guess that two labels are one number. This
   * branch renamed X and the hint went on naming the old word, which is a
   * cross-reference to a surface by a spelling that surface no longer uses:
   * the same defect as "Mint one under Access", one file over, reintroduced
   * within the hour of fixing it.
   *
   * READS BOTH SOURCES, which is the only way to see it — the two files share
   * no symbol, so nothing in the type system or in either file's own suite
   * connects them. `paths.test.ts` reads `App.tsx` and `tokens.test.ts` reads
   * the emitted CSS for the same reason: some agreements exist only between
   * files, and the alternative is prose that is wrong for a release.
   */
  it('keeps the statistics table’s bridge pointing at a label this row renders', () => {
    /* NOT `new URL(..., import.meta.url)`, which is what `paths.test.ts` uses
       one project over: that file runs under the NODE environment, where
       `import.meta.url` is a `file:` URL. This suite is jsdom, where it is an
       `http:` one, and `readFileSync` rejects it with "The URL must be of
       scheme file". Resolved from the repo root instead, found by walking up
       from the working directory so the suite does not care where it is
       invoked from. */
    const here = readFileSync(fromRepo('apps/web/src/routes/RunStats.tsx'), 'utf8');
    const table = readFileSync(fromRepo('apps/web/src/tables/StatisticsTable.tsx'), 'utf8');

    /* ANCHORED TO THE `hint:` PROPERTY, not to the phrase. The first version
       matched the phrase anywhere and found it inside the COMMENT that
       explains this very defect — which quotes the old spelling on purpose —
       so the guard read the documentation instead of the product and failed
       against a string nobody ships. */
    const bridge = /hint:\s*'[^']*the run totals call ([^']+)'/.exec(table);
    expect(bridge, 'StatisticsTable no longer bridges to the run totals').not.toBeNull();

    /* `?.[1] ?? ''`, not `bridge![1]`. The non-null assertion silences the
       compiler about `bridge` and leaves the INDEX unchecked — under
       `noUncheckedIndexedAccess` a capture group is `string | undefined`, so
       `.trim()` on it is TS2532. Widening the guard to cover both is also
       better at runtime: a bridge sentence that matched but captured nothing
       fails on the next line with its own message instead of throwing. */
    const named = (bridge?.[1] ?? '').trim();
    expect(named, 'the bridge names no label at all').not.toBe('');
    // The word the hint promises must be a label this file actually renders.
    expect(here).toContain(`label="${named}"`);

    // And it must be on screen, not merely in the source.
    render(<RunStats stats={stats} />);
    const labels = [
      ...document.querySelectorAll('section[aria-label="Run totals"] dt'),
    ].map((dt) => (dt.textContent ?? '').trim());
    expect(labels).toContain(named);
  });
});
