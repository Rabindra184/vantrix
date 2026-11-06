import '@testing-library/jest-dom/vitest';
import type {
  DistributionResponse,
  ErrorSeriesResponse,
  SeriesResponse,
  StatsResponse,
  UsersResponse,
} from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import DistributionChart from '../src/charts/DistributionChart';
import ErrorsChart from '../src/charts/ErrorsChart';
import IndicatorsChart from '../src/charts/IndicatorsChart';
import PercentileDistributionChart from '../src/charts/PercentileDistributionChart';
import PercentilesChart from '../src/charts/PercentilesChart';
import { RequestsAndResponsesChart } from '../src/charts/RatesChart';
import RequestCountChart from '../src/charts/RequestCountChart';
import { ConcurrentUsersChart, UserEndRateChart, UserStartRateChart } from '../src/charts/UsersChart';
import fixture from './fixtures/reference-run.json';
import type { Narrowed } from '../src/charts/transforms/narrowed';
import { expectAboutThePick, expectAboutTheRun, expectAboutTheWindow } from './support/emptySentence';

afterEach(cleanup);

/**
 * ═══ EVERY REPORT CHART HANDS ITS FLAG TO ITS TRANSFORM ═══
 *
 * `transforms.*.test.ts` prove each transform's two sentences when it is GIVEN
 * the flag, and say nothing about whether the component above it passes the one
 * it was handed on: a chart that destructured `windowSelected` and then called
 * `toDistribution(data, { windowSelected: false })` would pass every transform
 * case and still tell a reader who brushed an empty window that "no response
 * times were recorded for this run". This is the seam, one case per chart.
 *
 * It renders under jsdom with no renderer mocked, because an empty chart never
 * creates an ECharts instance — it draws its sentence (`role="status"`) in the
 * figure instead, which is exactly the thing under test. The browser case in
 * `run-summary-report.spec.ts` is the other half: it proves the PAGE derives
 * the flag from the URL's window.
 *
 * Each payload is the reference run's own shape with its data taken out, so a
 * component that needed a field the fixture lacks would fail loudly rather than
 * pass on an empty object.
 */

const stats = fixture.stats as StatsResponse;
const series = fixture.series as unknown as SeriesResponse;
const distribution = fixture.distribution as unknown as DistributionResponse;
const users = fixture.users as UsersResponse;

const noSeries: SeriesResponse = { ...series, buckets: [] };
const noUsers: UsersResponse = { runId: users.runId, window: null, scenarios: [], total: [] };
const noDistribution: DistributionResponse = {
  ...distribution,
  labels: [],
  okCount: [],
  koCount: [],
  okPercent: [],
  koPercent: [],
};
const noErrors: ErrorSeriesResponse = {
  runId: series.runId,
  window: null,
  bucketWidthMs: 1000,
  available: true,
  series: [],
};
/** Every request counted zero, so BOTH the bands and the donut are empty. */
const noRequests: StatsResponse = {
  ...stats,
  indicators: { under: 0, between: 0, over: 0, failed: 0 },
  stats: [],
};

const CHARTS: readonly (readonly [string, string, (windowSelected: boolean) => ReactElement])[] = [
  ['errors per second', 'errors-over-time', (w) => <ErrorsChart data={noErrors} windowSelected={w} />],
  ['response time ranges', 'indicators', (w) => <IndicatorsChart stats={noRequests} windowSelected={w} />],
  ['number of requests', 'request-counts', (w) => <RequestCountChart stats={noRequests} windowSelected={w} />],
  ['response time distribution', 'distribution', (w) => <DistributionChart distribution={noDistribution} windowSelected={w} />],
  [
    'response time percentiles distribution',
    'percentile-distribution',
    (w) => <PercentileDistributionChart distribution={noDistribution} windowSelected={w} />,
  ],
  ['response time percentiles over time', 'percentiles', (w) => <PercentilesChart series={noSeries} windowSelected={w} />],
  [
    'requests and responses per second',
    'requests-and-responses',
    (w) => <RequestsAndResponsesChart series={noSeries} windowSelected={w} />,
  ],
  ['users started per second', 'user-start-rate', (w) => <UserStartRateChart users={noUsers} windowSelected={w} />],
  ['users ended per second', 'user-end-rate', (w) => <UserEndRateChart users={noUsers} windowSelected={w} />],
  ['concurrent users', 'concurrent-users', (w) => <ConcurrentUsersChart users={noUsers} windowSelected={w} />],
];

/** The sentence the figure drew in place of a plot. */
function sentence(figureId: string): string {
  return within(screen.getByTestId(`chart-${figureId}`)).getByRole('status').textContent ?? '';
}

describe('a Report chart drawn under a window that selects nothing', () => {
  it.each(CHARTS)('%s names the window, not the run', (_name, id, chart) => {
    render(chart(true));
    expectAboutTheWindow(sentence(id));
  });

  /** The other half of each pair: without it the first case is satisfied by a
   *  chart that says "selected window" under EVERY flag. */
  it.each(CHARTS)('%s still names the run when no window is selected', (_name, id, chart) => {
    render(chart(false));
    expectAboutTheRun(sentence(id));
  });

  /** A vacuity guard: the cases above read a `role="status"` out of a figure, so
   *  they say nothing if the figure for an id never rendered at all. */
  it('draws one figure per chart, each with its own id', () => {
    for (const [, id, chart] of CHARTS) {
      render(chart(false));
      expect(screen.getByTestId(`chart-${id}`)).toBeInTheDocument();
      cleanup();
    }
    expect(new Set(CHARTS.map(([, id]) => id)).size).toBe(10);
  });
});

/**
 * ═══ EVERY NARROWABLE CHART HANDS ITS PICK TO ITS TRANSFORM ═══
 *
 * The same seam for the Report's pickers. `narrowed` is OPTIONAL on every chart
 * and transform (ruling R4, following `agentChart.ts`'s optional `filter`), so
 * `tsc` cannot find a component that drops it: a chart that took the prop and
 * never passed it on would draw "No response times were recorded for this run"
 * under a group pick and name nothing behind its ⓘ. THIS FILE IS THE GUARD, so
 * it renders ALL NINE charts the pickers narrow — every one but errors per
 * second, which stays whole-run under a pick and says so — with every kind.
 *
 * Each case asserts both halves of what the pick changes: the empty sentence
 * names the pick and not the run, and the figure's ⓘ trigger carries the
 * narrowed line as its accessible description, which is where a screen-reader
 * user meets it.
 */
type NarrowedChart = readonly [
  name: string,
  id: string,
  title: string,
  chart: (opts: { readonly windowSelected: boolean; readonly narrowed: Narrowed }) => ReactElement,
];

const NARROWABLE: readonly NarrowedChart[] = [
  ['response time ranges', 'indicators', 'Response time ranges', (o) => <IndicatorsChart stats={noRequests} {...o} />],
  ['number of requests', 'request-counts', 'Number of requests', (o) => <RequestCountChart stats={noRequests} {...o} />],
  [
    'response time distribution',
    'distribution',
    'Response time distribution',
    (o) => <DistributionChart distribution={noDistribution} {...o} />,
  ],
  [
    'response time percentiles distribution',
    'percentile-distribution',
    'Response time percentiles distribution',
    (o) => <PercentileDistributionChart distribution={noDistribution} {...o} />,
  ],
  [
    'response time percentiles over time',
    'percentiles',
    'Response time percentiles over time',
    (o) => <PercentilesChart series={noSeries} {...o} />,
  ],
  [
    'requests and responses per second',
    'requests-and-responses',
    'Requests and responses per second over time',
    (o) => <RequestsAndResponsesChart series={noSeries} {...o} />,
  ],
  ['users started per second', 'user-start-rate', 'Users started per second', (o) => <UserStartRateChart users={noUsers} {...o} />],
  ['users ended per second', 'user-end-rate', 'Users ended per second', (o) => <UserEndRateChart users={noUsers} {...o} />],
  ['concurrent users', 'concurrent-users', 'Concurrent users over time', (o) => <ConcurrentUsersChart users={noUsers} {...o} />],
];

/** One pick of each kind, with the line its ⓘ must carry. */
const PICKS: readonly (readonly [NonNullable<Narrowed>, string])[] = [
  [{ kind: 'request', name: 'Cart/Add To Cart' }, 'Narrowed to the request Cart/Add To Cart.'],
  [{ kind: 'group', name: 'Catalog/Recommendations' }, 'Narrowed to the group Catalog / Recommendations.'],
  [{ kind: 'scenario', name: 'Browse' }, 'Narrowed to the scenario Browse.'],
];

const NARROWED_CASES = NARROWABLE.flatMap(([name, id, title, chart]) =>
  PICKS.map(([narrowed, line]) => [name, narrowed.kind, id, title, chart, narrowed, line] as const),
);

/** The figure's ⓘ trigger, which `Chart` names "About <title>". */
function infoTrigger(figureId: string, title: string): HTMLElement {
  return within(screen.getByTestId(`chart-${figureId}`)).getByRole('button', { name: `About ${title}` });
}

describe('a Report chart narrowed to a pick that holds nothing', () => {
  it.each(NARROWED_CASES)('%s names the %s it was narrowed to', (_name, kind, id, title, chart, narrowed, line) => {
    render(chart({ windowSelected: false, narrowed }));
    expectAboutThePick(sentence(id), `for this ${kind}`);
    expect(sentence(id)).not.toMatch(/window/i);
    expect(infoTrigger(id, title)).toHaveAccessibleDescription(expect.stringContaining(line));
  });

  it.each(NARROWABLE)('%s names the pick and the window together', (_name, id, _title, chart) => {
    render(chart({ windowSelected: true, narrowed: { kind: 'group', name: 'Cart' } }));
    expectAboutThePick(sentence(id), 'for this group in the selected window');
  });

  it.each(NARROWABLE)('%s says the requests in no group, never "the group (no group)"', (_name, id, title, chart) => {
    render(chart({ windowSelected: false, narrowed: { kind: 'group', name: '' } }));
    expectAboutThePick(sentence(id), 'for the requests in no group');
    expect(infoTrigger(id, title)).toHaveAccessibleDescription(
      expect.stringContaining('Narrowed to the requests in no group.'),
    );
    expect(screen.getByTestId(`chart-${id}`).textContent).not.toMatch(/group \(no group\)/);
  });

  /** Vacuity: the nine are exactly the Report's charts but errors per second,
   *  each rendered once under its own id. A chart left out of this list is the
   *  defect R4 accepted the risk of, so the list is held to the window list. */
  it('covers every Report chart the pickers narrow', () => {
    expect(NARROWABLE.map(([, id]) => id).sort()).toEqual(
      CHARTS.map(([, id]) => id)
        .filter((id) => id !== 'errors-over-time')
        .sort(),
    );
    expect(NARROWED_CASES).toHaveLength(27);
  });
});
