import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  distributionQuery,
  errorsQuery,
  scatterQuery,
  seriesQuery,
  statsQuery,
} from '../api/metrics';
import DistributionChart from '../charts/DistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import { RequestRateChart, ResponseRateChart } from '../charts/RatesChart';
import ScatterChart from '../charts/ScatterChart';
import ErrorsTable from '../tables/ErrorsTable';
import RequestStatistics from '../tables/RequestStatistics';
import { Payload, TableSection, type Slot } from './payload';

/** §13.3's chart elements — ② ③ ⑤ ⑦ ⑧ ⑨ — in that order. Ids match each
 *  chart's own `Chart` id. Not the whole of §13.3: ① and ⑪, the two tables,
 *  render above this stack rather than at their numbered positions — see the
 *  comment there. */
const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
const PERCENTILES: Slot = { id: 'percentiles', title: 'Response time percentiles over time' };
// Gatling's own request-page titles — see RatesChart's `title` prop.
const REQUESTS: Slot = { id: 'requests-per-second', title: 'Number of requests' };
const RESPONSES: Slot = { id: 'responses-per-second', title: 'Number of responses' };
const SCATTER: Slot = {
  id: 'scatter',
  title: 'Response time against global requests per second',
};

/**
 * §13.3 — one request's own page.
 *
 * THE NAME IS A FULL PATH, arriving as ONE encoded segment. `detailPathFor`
 * encodes it (`tables/StatisticsTable.tsx:843`), the route spells it as a
 * single `:name` (`App.tsx:43`), and `useParams` decodes it — so
 * `Catalog%2FList%20Products` reaches here as `Catalog/List Products`, which
 * is exactly the identity the engine rolls the request up under (D-10).
 */

/**
 * The row this page is about.
 *
 * SCOPE IS PART OF THE MATCH, not an afterthought. `Catalog` is a group AND a
 * name a request could plausibly have; matching on name alone would render a
 * group's cumulated numbers under a request heading and look entirely normal.
 */
export function requestRow(stats: StatsResponse, path: string): StatRow | undefined {
  return stats.stats.find((r) => r.scope === 'request' && r.name === path);
}

export default function RequestDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  // Called under the SAME key `Tables`/`Overview` use, so this page's first
  // render finds a warm cache entry rather than issuing a second request for
  // a payload the run page already fetched.
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });
  const series = useQuery({
    ...seriesQuery(runId ?? '', 'request', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });
  const distribution = useQuery({
    ...distributionQuery(runId ?? '', 'request', name ?? '', 'response_time'),
    enabled: runId !== undefined && name !== undefined,
  });
  const errors = useQuery({
    ...errorsQuery(runId ?? '', 'request', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });
  const scatter = useQuery({
    ...scatterQuery(runId ?? '', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });

  // Not reachable through the router — the route cannot match without both.
  if (runId === undefined || name === undefined) {
    return (
      <Link to="/runs" className="underline">
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* The name the reader clicked, so the page is recognisably the one they
          asked for. Rendered as text through React, which escapes it: this is a
          request name out of an uploaded simulation log, i.e. a string an
          ingesting client controls. */}
      <h1 className="text-2xl font-semibold">{name}</h1>
      <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
        Back to this run
      </Link>
      {/* §13.3 ① and ⑪, ABOVE THE CHART STACK — same placement as the run
          page's own tables (RunDetail.tsx, above its `Tables` call), and a
          stronger case for it: there, the argument was that scrolling past
          eight figures to reach one request's p99 is the reading order
          nobody wants. Here, the entire numeric payload IS a single row —
          there is nothing left for the charts to precede. */}
      <TableSection title="Statistics" query={stats}>
        {(data) => {
          const row = requestRow(data, name);
          // A name that is not in the run is a link from a stale tab or a
          // hand-edited URL. Saying so is the whole deliverable — an empty
          // page would read as a request that ran and recorded nothing.
          return row === undefined ? (
            <p role="status">This run recorded no request named {name}.</p>
          ) : (
            <RequestStatistics row={row} rows={data.stats} />
          );
        }}
      </TableSection>

      <TableSection title="Errors" query={errors}>
        {(data) => <ErrorsTable errors={data} />}
      </TableSection>

      <Payload query={stats} slots={[INDICATORS]}>
        {(data) => (
          <IndicatorsChart stats={data} row={requestRow(data, name)} label={name} />
        )}
      </Payload>

      <Payload query={distribution} slots={[DISTRIBUTION]}>
        {(data) => <DistributionChart distribution={data} />}
      </Payload>

      <Payload query={series} slots={[PERCENTILES, REQUESTS, RESPONSES]}>
        {(data) => (
          <>
            <PercentilesChart series={data} />
            <RequestRateChart series={data} title={REQUESTS.title} />
            <ResponseRateChart series={data} title={RESPONSES.title} />
          </>
        )}
      </Payload>

      <Payload query={scatter} slots={[SCATTER]}>
        {(data) => <ScatterChart scatter={data} />}
      </Payload>
    </div>
  );
}
