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
import { expectAboutTheRun, expectAboutTheWindow } from './support/emptySentence';

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
