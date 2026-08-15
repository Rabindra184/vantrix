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
import { linkButtonClasses } from '../components/Button';
import { EmptyState } from '../components/States';
import { ChevronLeftIcon } from '../components/icons';
import ErrorsTable from '../tables/ErrorsTable';
import ScopedStatistics from '../tables/ScopedStatistics';
import { Payload, TableSection, type Slot } from './payload';
import useDocumentTitle from '../useDocumentTitle';

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

  // The request's own path — the same string the `<h1>` renders, and the
  // reason a reader keeps two of these open at once.
  useDocumentTitle(name ?? null);

  // Called under the SAME key `RunOverviewTab` and `RunChartsTab` use
  // (`RunDetail.tsx`), so this page's first render finds a warm cache entry
  // rather than issuing a second request for a payload the run page already
  // fetched — `statsQuery`'s `staleTime: Infinity` (`api/metrics.ts`) is what
  // keeps that entry warm across all three routes; the key alone would not.
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
      <Link to="/runs" className={linkButtonClasses}>
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {/* The back link ABOVE the heading, not below it. It was below, which
            put a navigation control between the page's title and the page's
            first section — so a keyboard user tabbing from the top reached
            the content only after passing an "up" link, and a sighted reader
            met the escape hatch after committing to the page. Above, it reads
            as the breadcrumb it actually is, matching `RunHeader`'s. */}
        <Link
          to={`/runs/${encodeURIComponent(runId)}`}
          className="transition-ui inline-flex w-fit items-center gap-1 text-[13px] font-medium text-accent hover:underline hover:underline-offset-2"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Back to this run
        </Link>
        {/* The name the reader clicked, so the page is recognisably the one they
            asked for. Rendered as text through React, which escapes it: this is a
            request name out of an uploaded simulation log, i.e. a string an
            ingesting client controls.

            `break-all`: a request name is a slash-separated path with no
            spaces to wrap at, and on a phone `Catalog/Recommendations` would
            otherwise widen the whole page. */}
        <h1 className="text-xl font-semibold tracking-tight break-all sm:text-2xl">{name}</h1>
      </header>
      {/* §13.3 ① and ⑪, ABOVE THE CHART STACK — same placement as the run
          page's own statistics table (RunDetail.tsx's `RunOverviewTab`,
          above the Charts tab it no longer shares a page with), and a
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
            // `role="status"`, kept: this is the answer to the reader's
            // question, not a system failure, so it is announced politely and
            // wears `EmptyState` rather than the alert treatment. The sentence
            // is unchanged and stays one text node — `{name}` interpolated
            // into `title` keeps it that way.
            <div role="status">
              <EmptyState
                title={`This run recorded no request named ${name}.`}
                body="The link may be from a different run, or the name may have been edited in the address bar."
              />
            </div>
          ) : (
            <ScopedStatistics row={row} rows={data.stats} />
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
