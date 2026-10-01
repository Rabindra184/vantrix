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
