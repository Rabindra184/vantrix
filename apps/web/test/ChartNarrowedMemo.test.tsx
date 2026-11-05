import type { DistributionResponse, SeriesResponse, StatsResponse, UsersResponse } from '@perfportal/contracts';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import DistributionChart from '../src/charts/DistributionChart';
import IndicatorsChart from '../src/charts/IndicatorsChart';
import PercentileDistributionChart from '../src/charts/PercentileDistributionChart';
import PercentilesChart from '../src/charts/PercentilesChart';
import { RequestsAndResponsesChart } from '../src/charts/RatesChart';
import RequestCountChart from '../src/charts/RequestCountChart';
import { ConcurrentUsersChart, UserEndRateChart, UserStartRateChart } from '../src/charts/UsersChart';
import { toDistribution } from '../src/charts/transforms/distribution';
import { toIndicators, toRequestCounts } from '../src/charts/transforms/indicators';
import type { Narrowed } from '../src/charts/transforms/narrowed';
import { toPercentileDistribution } from '../src/charts/transforms/percentileDistribution';
import { toPercentiles } from '../src/charts/transforms/percentiles';
import { toRequestsAndResponses } from '../src/charts/transforms/rates';
import { toConcurrentUsers, toUserEndRate, toUserStartRate } from '../src/charts/transforms/users';
import fixture from './fixtures/reference-run.json';

/**
 * ═══ AN EQUAL PICK IS THE SAME PICK ═══
 *
 * Each narrowable chart builds its `data` in a `useMemo`, and `Chart`'s option
 * effect depends on `data` by identity: a new `data` is a `setOption(…,
 * notMerge)`, which resets the reader's legend toggles. Keyed on the
 * `narrowed` OBJECT, a caller passing `narrowed={{ kind: 'group', name }}`
 * inline re-ran the transform on every render. So every chart keys it on the
 * pick's primitives (`useStableNarrowed`), and this file is what sees it: each
 * transform is wrapped in a spy that still calls the real one, and the chart is
 * re-rendered with a NEW object equal to the old.
 *
 * Asserted as a pair: an equal object does not re-run the transform, and a
 * different pick does — without the second half a chart whose memo ignored
 * `narrowed` altogether would pass.
 *
 * Empty payloads, as in `ChartWindowSelected.test.tsx`: the transform is
 * called all the same, and an empty chart creates no ECharts instance.
 */

vi.mock('../src/charts/transforms/rates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/rates')>();
  return { ...actual, toRequestsAndResponses: vi.fn(actual.toRequestsAndResponses) };
});
vi.mock('../src/charts/transforms/percentiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/percentiles')>();
  return { ...actual, toPercentiles: vi.fn(actual.toPercentiles) };
});
vi.mock('../src/charts/transforms/distribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/distribution')>();
  return { ...actual, toDistribution: vi.fn(actual.toDistribution) };
});
vi.mock('../src/charts/transforms/percentileDistribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/percentileDistribution')>();
  return { ...actual, toPercentileDistribution: vi.fn(actual.toPercentileDistribution) };
});
vi.mock('../src/charts/transforms/indicators', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/indicators')>();
  return {
    ...actual,
    toIndicators: vi.fn(actual.toIndicators),
    toRequestCounts: vi.fn(actual.toRequestCounts),
  };
});
vi.mock('../src/charts/transforms/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/charts/transforms/users')>();
  return {
    ...actual,
    toConcurrentUsers: vi.fn(actual.toConcurrentUsers),
    toUserStartRate: vi.fn(actual.toUserStartRate),
    toUserEndRate: vi.fn(actual.toUserEndRate),
  };
});

afterEach(cleanup);

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
const noRequests: StatsResponse = { ...stats, indicators: { under: 0, between: 0, over: 0, failed: 0 }, stats: [] };

type Case = readonly [name: string, transform: unknown, chart: (narrowed: Narrowed) => ReactElement];

const CASES: readonly Case[] = [
  ['response time ranges', toIndicators, (n) => <IndicatorsChart stats={noRequests} windowSelected={false} narrowed={n} />],
  ['number of requests', toRequestCounts, (n) => <RequestCountChart stats={noRequests} windowSelected={false} narrowed={n} />],
  [
    'response time distribution',
    toDistribution,
    (n) => <DistributionChart distribution={noDistribution} windowSelected={false} narrowed={n} />,
  ],
  [
    'response time percentiles distribution',
    toPercentileDistribution,
    (n) => <PercentileDistributionChart distribution={noDistribution} windowSelected={false} narrowed={n} />,
  ],
  [
    'response time percentiles over time',
    toPercentiles,
    (n) => <PercentilesChart series={noSeries} windowSelected={false} narrowed={n} />,
  ],
  [
    'requests and responses per second',
    toRequestsAndResponses,
    (n) => <RequestsAndResponsesChart series={noSeries} windowSelected={false} narrowed={n} />,
  ],
  ['users started per second', toUserStartRate, (n) => <UserStartRateChart users={noUsers} windowSelected={false} narrowed={n} />],
  ['users ended per second', toUserEndRate, (n) => <UserEndRateChart users={noUsers} windowSelected={false} narrowed={n} />],
  ['concurrent users', toConcurrentUsers, (n) => <ConcurrentUsersChart users={noUsers} windowSelected={false} narrowed={n} />],
];

describe('a narrowed chart re-rendered with an equal pick', () => {
  it.each(CASES)('%s does not re-run its transform for an equal new object', (_name, transform, chart) => {
    const spy = transform as Mock;
    const { rerender } = render(chart({ kind: 'group', name: 'Cart', label: 'Cart' }));
    const first = spy.mock.calls.length;
    expect(first, 'the transform ran for the first render').toBeGreaterThan(0);

    rerender(chart({ kind: 'group', name: 'Cart', label: 'Cart' }));
    expect(spy.mock.calls.length, 'an equal pick must not re-run it').toBe(first);

    rerender(chart({ kind: 'group', name: 'Catalog', label: 'Catalog' }));
    expect(spy.mock.calls.length, 'a different pick must re-run it').toBe(first + 1);
    expect(spy.mock.calls.at(-1)![spy.mock.calls.at(-1)!.length - 1]).toMatchObject({
      narrowed: { kind: 'group', name: 'Catalog', label: 'Catalog' },
    });
  });

  /*
   * ONE FIELD AT A TIME. The case above changes the name and the label
   * together, so a memo keyed on `name` alone passes it while a label-only
   * change — a request picked by its display label — or a kind-only change —
   * a group and a request of one name — would keep the stale pick on screen.
   * Each of the three keys has a case that changes it alone.
   */
  it.each(CASES)('%s re-runs its transform when only the label changes', (_name, transform, chart) => {
    const spy = transform as Mock;
    const { rerender } = render(chart({ kind: 'group', name: 'Cart', label: 'Cart' }));
    const first = spy.mock.calls.length;
    rerender(chart({ kind: 'group', name: 'Cart', label: 'Shopping cart' }));
    expect(spy.mock.calls.length, 'a new label must re-run it').toBe(first + 1);
    expect(spy.mock.calls.at(-1)![spy.mock.calls.at(-1)!.length - 1]).toMatchObject({
      narrowed: { kind: 'group', name: 'Cart', label: 'Shopping cart' },
    });
  });

  it.each(CASES)('%s re-runs its transform when only the kind changes', (_name, transform, chart) => {
    const spy = transform as Mock;
    const { rerender } = render(chart({ kind: 'group', name: 'Cart', label: 'Cart' }));
    const first = spy.mock.calls.length;
    rerender(chart({ kind: 'request', name: 'Cart', label: 'Cart' }));
    expect(spy.mock.calls.length, 'a new kind must re-run it').toBe(first + 1);
    expect(spy.mock.calls.at(-1)![spy.mock.calls.at(-1)!.length - 1]).toMatchObject({
      narrowed: { kind: 'request', name: 'Cart', label: 'Cart' },
    });
  });

  it('covers all nine narrowable charts', () => {
    expect(new Set(CASES.map(([name]) => name)).size).toBe(9);
    for (const [, transform] of CASES) expect(vi.isMockFunction(transform)).toBe(true);
  });
});
