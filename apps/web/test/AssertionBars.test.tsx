// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, StatsResponse, ToolAssertion } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import {
  PlatformGatesBar,
  SimulationAssertionsBar,
  outcomeSummary,
} from '../src/routes/AssertionBars';

/**
 * THE TWO ASSERTION BARS (summary/report, task 4).
 *
 * The fixtures below are `ToolAssertions.test.tsx`'s, copied rather than
 * imported: that file goes with the table it tested, and these are the claims
 * it carried that survive — the tool's own sentence kept verbatim, a target
 * linked only when this run recorded it, `null` and `[]` told apart, and the
 * platform's gates counted apart from the simulation's.
 */

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const STATS = reference.stats as StatsResponse;

/**
 * A `details` path, the one shape that names something drillable.
 *
 * `Search` is a REQUEST row in the reference payload and `Catalog` is a GROUP
 * row there and NOT a request (checked: no `request Catalog` exists), which is
 * what lets one case prove both link targets. `Ghost` is in neither.
 */
function details(parts: readonly string[], outcome: ToolAssertion['outcome']): ToolAssertion {
  return {
    expression: `${parts.join(' / ')}: 95th percentile of response time is less than 100.0`,
    assertion: {
      path: { kind: 'details', parts: [...parts] },
      target: { kind: 'responseTime', stat: 'percentile', rank: 95 },
      condition: { kind: 'lt', value: 100 },
    },
    actualValue: outcome === 'not_applicable' ? null : 572,
    outcome,
  };
}

/** One PLATFORM gate -- the organisation's own SLA rule, judged at finalize.
 *  Distinct from the simulation's checks above: two systems, two sections. */
const PLATFORM_GATE: Assertion = {
  ruleId: '22222222-2222-4222-8222-222222222222',
  outcome: 'failed',
  actualValue: 1830,
  message: 'p99 breached its threshold.',
  rule: {
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'p99',
    comparator: 'lte',
    threshold: 750,
  },
};

const PASSED_GATE: Assertion = {
  ...PLATFORM_GATE,
  ruleId: '33333333-3333-4333-8333-333333333333',
  outcome: 'passed',
  actualValue: 400,
};

/**
 * Three gates, one of each outcome — `RunDetail.live.test.tsx`'s fixture, which
 * is where these cards' two lines were pinned until the table they sat in went.
 * Already in failed-first order, so the cases below reach a card by its
 * position and prove nothing about the ordering — "failures first" is pinned
 * by the case that passes `[PASSED_GATE, PLATFORM_GATE]`. The passed one is a
 * `gte` rule, so the comparator's noun is not the only one in play.
 */
const THREE_GATES: readonly Assertion[] = [
  {
    ruleId: '22222222-2222-4222-8222-222222222222',
    outcome: 'failed',
    actualValue: 1830,
    message: 'p99 breached its threshold.',
    rule: {
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p99',
      comparator: 'lte',
      threshold: 750,
    },
  },
  {
    ruleId: '33333333-3333-4333-8333-333333333333',
    outcome: 'passed',
    actualValue: 92,
    message: 'Throughput stayed above target.',
    rule: {
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'throughput_rps',
      comparator: 'gte',
      threshold: 80,
    },
  },
  {
    ruleId: '44444444-4444-4444-8444-444444444444',
    outcome: 'not_applicable',
    actualValue: null,
    message: 'No matching request was measured.',
    rule: {
      scope: 'request',
      targetName: 'POST /checkout',
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 500,
    },
  },
];

const GLOBAL_ASSERTION: ToolAssertion = {
  expression: 'Global: max of response time is less than 30000.0',
  assertion: {
    path: { kind: 'global' },
    target: { kind: 'responseTime', stat: 'max' },
    condition: { kind: 'lt', value: 30000 },
  },
  actualValue: 2643,
  outcome: 'passed',
};

const FOR_ALL_ASSERTION: ToolAssertion = {
  expression: 'Session: max of response time is less than 2.0',
  assertion: {
    path: { kind: 'forAll' },
    target: { kind: 'responseTime', stat: 'max' },
    condition: { kind: 'lt', value: 2 },
  },
  actualValue: 1,
  outcome: 'passed',
};

/** A run ingested before the decoder existed: prose and nothing else. */
const UNDECODED_ASSERTION: ToolAssertion = {
  expression: 'Place Order: percentage of failed events is less than 5.0',
  actualValue: 2.68,
  outcome: 'passed',
};

function at(url: string, ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

describe('outcomeSummary', () => {
  it('names what failed first, in the product’s words, and skips a zero', () => {
    expect(
      outcomeSummary([{ outcome: 'passed' }, { outcome: 'failed' }, { outcome: 'passed' }]),
    ).toBe('1 failed, 2 passed');
    expect(outcomeSummary([{ outcome: 'not_applicable' }])).toBe('1 not applicable');
  });
});

describe('PlatformGatesBar', () => {
  it('opens on arrival when a gate failed, failures first', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PASSED_GATE, PLATFORM_GATE]} ran />);
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const cards = screen.getAllByTestId('gate-card');
    expect(within(cards[0]!).getByTestId('gate-outcome')).toHaveTextContent(/failed/i);
  });

  it('stays shut when every gate passed, and opens to one card per gate', async () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PASSED_GATE]} ran />);
    const button = screen.getByRole('button', { name: 'Platform gates' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(screen.getAllByTestId('gate-card')).toHaveLength(1);
  });

  it.each([
    [undefined, true, 'not reported yet'],
    [[], false, 'not evaluated — the run left nothing to judge'],
    [[], true, 'not configured — no SLA rule judged this run'],
  ] as const)('says why it has nothing to show (%#)', (assertions, ran, words) => {
    at('/r', <PlatformGatesBar runId={RUN_ID} projectSlug="checkout" assertions={assertions} ran={ran} />);
    expect(within(screen.getByTestId('section-platform-gates')).getByText(words)).toBeVisible();
  });

  /**
   * THE CARD'S OUTCOME LINE, WHOLE. The title line above it already says
   * `Whole-run p99 response time ≤ 750 ms`, so a fragment such as "p99" or
   * "750 ms" is satisfied by the title and pins nothing here. The full
   * sentence is the evaluator's structured fields in the reader's vocabulary
   * (review.md 3); the STORED message is `p99 breached its threshold.`, which
   * is how a card quietly printing the schema's own words is told from one
   * that does not — so its absence is asserted beside the sentence's presence.
   */
  it('words a failed gate’s outcome from its structured fields, not its stored message', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={THREE_GATES} ran />);
    const failed = screen.getAllByTestId('gate-card')[0]!;
    expect(
      within(failed).getByText('Whole-run p99 response time 1830 ms exceeds the 750 ms limit.'),
    ).toBeVisible();
    expect(failed).not.toHaveTextContent('p99 breached its threshold.');
  });

  /**
   * NOT APPLICABLE HAS NOTHING TO SAY IN STRUCTURE, so the stored message is
   * the one place the evaluator's own words survive ("No matching request was
   * measured" explains WHY, which no field can). And nothing was measured, so
   * the actual is a dash — a `0` there is a measurement nobody took, and reads
   * as a request that responded instantly.
   */
  it('shows a not-applicable gate’s stored message and a dash, never a zero, for its actual', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={THREE_GATES} ran />);
    // Failed first, then the rest in recorded order: [failed, passed, n/a].
    const notApplicable = screen.getAllByTestId('gate-card')[2]!;
    expect(within(notApplicable).getByTestId('gate-outcome')).toHaveTextContent(/not applicable/i);
    expect(notApplicable).toHaveTextContent('Actual: —');
    expect(within(notApplicable).getByText('No matching request was measured.')).toBeVisible();
  });

  it.each([
    [undefined, true, 'Platform gates are judged once the run finishes.'],
    [[], false, 'The run stopped before anything could be processed, so no SLA rule ran.'],
  ] as const)('says what is behind “nothing to show” once opened (%#)', async (assertions, ran, body) => {
    // The summary line names WHICH fact it is; the body says what it means.
    // Swapping the two bodies turns "judged once the run finishes" onto a run
    // that is finished and stopped early, which is false in both directions.
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={assertions} ran={ran} />);
    await userEvent.click(screen.getByRole('button', { name: 'Platform gates' }));
    expect(within(screen.getByTestId('section-platform-gates')).getByText(body)).toBeVisible();
  });

  it('opens itself when a run finishes with a failed gate it was shut over while live', () => {
    // The Summary is mounted while the run streams ("not reported yet", shut),
    // and the same instance re-renders when the verdict arrives. `defaultOpen`
    // is read once at mount, so only a remount keeps "a failed gate is never a
    // click away" true on exactly the run somebody was watching.
    const { rerender } = at('/r', <PlatformGatesBar runId={RUN_ID} assertions={undefined} ran />);
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rerender(
      <MemoryRouter initialEntries={['/r']}>
        <PlatformGatesBar runId={RUN_ID} assertions={[PLATFORM_GATE]} ran />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getAllByTestId('gate-card')).toHaveLength(1);
  });

  it('keeps the way to configure a rule when none is configured', async () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} projectSlug="checkout" assertions={[]} ran />);
    await userEvent.click(screen.getByRole('button', { name: 'Platform gates' }));
    expect(screen.getByRole('link', { name: 'Configure SLA rules' })).toHaveAttribute(
      'href',
      '/projects/checkout/rules',
    );
  });

  it('offers no link to configure rules when it does not know the project', async () => {
    // `projectRulesPath(undefined)` is `/projects/undefined/rules`, which
    // resolves and renders — a dead end that looks like a feature.
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[]} ran />);
    await userEvent.click(screen.getByRole('button', { name: 'Platform gates' }));
    expect(screen.getByText(/adding one affects future runs/i)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Configure SLA rules' })).toBeNull();
  });

  /**
   * The first review's finding 1, which the table this card replaces was
   * pinned against: an error rate is stored as a FRACTION and read as a
   * percentage, so the raw number beside a limit reading `1%` is
   * floating-point noise in the one place two numbers are compared. The raw
   * string is asserted ABSENT as well as the formatted one present — a second
   * copy printed elsewhere on the card would satisfy a positive-only check.
   */
  it('shows a failed error-rate actual in the same unit as its limit', () => {
    at(
      '/r',
      <PlatformGatesBar
        runId={RUN_ID}
        ran
        assertions={[
          {
            ...PLATFORM_GATE,
            actualValue: 0.0223463687150838,
            rule: {
              scope: 'run',
              targetName: null,
              // `response_time` WITH an `error_rate` metric is what the
              // evaluator really stores: `family` is the statistics family the
              // row comes from, not the quantity.
              family: 'response_time',
              metric: 'error_rate',
              comparator: 'lte',
              threshold: 0.01,
            },
          },
        ]}
      />,
    );
    const card = screen.getByTestId('gate-card');
    expect(card).toHaveTextContent('2.2346%');
    expect(card).not.toHaveTextContent('0.0223463687150838');
    expect(card).toHaveTextContent('1%');
  });

  it('keeps the CSV export beside a populated bar', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PLATFORM_GATE]} ran />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeVisible();
  });
});

describe('SimulationAssertionsBar', () => {
  it('counts its own system, never the platform’s', () => {
    // A second PASSED gate, spread from the first with its own `ruleId`: the
    // gate cards are keyed by `ruleId`, so the same fixture twice would put two
    // list items under one key and test React's warning rather than the count.
    const SECOND_PASSED_GATE: Assertion = {
      ...PASSED_GATE,
      ruleId: '44444444-4444-4444-8444-444444444444',
    };
    at(
      '/r',
      <>
        <PlatformGatesBar
          runId={RUN_ID}
          assertions={[PLATFORM_GATE, PASSED_GATE, SECOND_PASSED_GATE]}
          ran
        />
        <SimulationAssertionsBar
          runId={RUN_ID}
          assertions={[details(['Search'], 'failed'), GLOBAL_ASSERTION]}
          stats={STATS.stats}
        />
      </>,
    );
    expect(
      within(screen.getByTestId('section-platform-gates')).getByText('1 failed, 2 passed'),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('section-simulation-assertions')).getByText('1 failed, 1 passed'),
    ).toBeVisible();
  });

  it('shows the tool’s own sentence verbatim on each card, with the actual and its unit', () => {
    at(
      '/r',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[details(['Search'], 'failed')]}
        stats={STATS.stats}
      />,
    );
    const card = screen.getByTestId('simulation-card');
    expect(card).toHaveTextContent('Search: 95th percentile of response time is less than 100.0');
    expect(card).toHaveTextContent('572 ms');
  });

  it('links a check to the request or group it names, and to nothing it cannot find', () => {
    at(
      '/r',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[
          details(['Search'], 'failed'),
          details(['Catalog'], 'failed'),
          details(['Ghost'], 'failed'),
        ]}
        stats={STATS.stats}
      />,
    );
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/requests/Search`,
    );
    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/groups/Catalog`,
    );
    expect(screen.queryByRole('link', { name: 'Ghost' })).toBeNull();
    // The null check above is also true of a card that never rendered, so the
    // name is asserted PRESENT as plain text beside it — the honest answer for
    // a check on something this run has no row for, not a card that vanished.
    const ghost = screen
      .getAllByTestId('simulation-card')
      .find((card) => card.textContent?.includes('Ghost'));
    expect(ghost).toBeDefined();
    expect(ghost).toHaveTextContent('Target: Ghost');
    expect(within(ghost!).queryByRole('link')).toBeNull();
  });

  it('puts a failed check first, whatever order the run recorded them in', () => {
    // Every other multi-card case is already failed-first in its input, which
    // is how replacing `failedFirst(assertions)` with `assertions` passed them.
    at(
      '/r',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[GLOBAL_ASSERTION, details(['Search'], 'failed')]}
        stats={STATS.stats}
      />,
    );
    const [first, second] = screen.getAllByTestId('simulation-card');
    expect(within(first!).getByTestId('simulation-outcome')).toHaveTextContent(/failed/i);
    expect(first).toHaveTextContent('Search: 95th percentile of response time is less than 100.0');
    expect(second).toHaveTextContent('Global: max of response time is less than 30000.0');
  });

  it('addresses a nested request by its unspaced path, not its spaced label', () => {
    at(
      '/r',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[details(['Cart', 'Add To Cart'], 'failed')]}
        stats={STATS.stats}
      />,
    );
    expect(screen.getByRole('link', { name: 'Cart / Add To Cart' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/requests/${encodeURIComponent('Cart/Add To Cart')}`,
    );
  });

  it('leaves the run and every-request targets as plain text', () => {
    // Passing, so the bar is shut on arrival and the hash opens it — a failed
    // row would open it, and these two are the ones that must never link.
    at(
      '/r#simulation-assertions',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[GLOBAL_ASSERTION, FOR_ALL_ASSERTION]}
        stats={STATS.stats}
      />,
    );
    const cards = screen.getAllByTestId('simulation-card');
    expect(cards).toHaveLength(2);
    ['the run', 'every request'].forEach((label, i) => {
      expect(cards[i]).toHaveTextContent(`Target: ${label}`);
      expect(within(cards[i]!).queryByRole('link')).toBeNull();
    });
  });

  it('names the target before the statistics can say whether it is linkable', () => {
    // `stats` is null until the run's rows load. A card that withheld its
    // target entirely would be worse than the dead end linking guards against:
    // the name renders at once and only the link waits.
    at(
      '/r',
      <SimulationAssertionsBar runId={RUN_ID} assertions={[details(['Search'], 'failed')]} stats={null} />,
    );
    const card = screen.getByTestId('simulation-card');
    expect(card).toHaveTextContent('Target: Search');
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('keeps an undecoded check’s sentence, and offers it no target it does not have', () => {
    // Both PASSED, so the bar is shut on arrival: the hash is what opens it.
    at(
      '/r#simulation-assertions',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[details(['Search'], 'passed'), UNDECODED_ASSERTION]}
        stats={STATS.stats}
      />,
    );
    const [decoded, undecoded] = screen.getAllByTestId('simulation-card');
    // The paired positive: without it, "no Target" is satisfied by a card that
    // never draws one for anybody.
    expect(decoded).toHaveTextContent('Target:');
    expect(undecoded).toHaveTextContent(UNDECODED_ASSERTION.expression);
    expect(undecoded).not.toHaveTextContent('Target:');
  });

  it('says nothing at all for a run whose assertions were never decoded (null)', () => {
    const { container } = at(
      '/r',
      <SimulationAssertionsBar runId={RUN_ID} assertions={null} stats={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says the simulation declared none ([])', async () => {
    at('/r', <SimulationAssertionsBar runId={RUN_ID} assertions={[]} stats={null} />);
    expect(
      within(screen.getByTestId('section-simulation-assertions')).getByText('none declared'),
    ).toBeVisible();
  });

  it('opens when the decision band’s link names it', () => {
    at(
      '/r#simulation-assertions',
      <SimulationAssertionsBar runId={RUN_ID} assertions={[GLOBAL_ASSERTION]} stats={STATS.stats} />,
    );
    expect(screen.getByRole('button', { name: 'Simulation assertions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
