import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RunResponse } from '@perfportal/contracts';
import CollapsibleSection from '../components/CollapsibleSection';
import { ErrorState, LoadingState } from '../components/States';
import { distributionQuery, errorSeriesQuery, seriesQuery, statsQuery, usersQuery } from '../api/metrics';
import { RUN_TIME_GROUP } from '../charts/crosshair';
import DistributionChart from '../charts/DistributionChart';
import ErrorsChart from '../charts/ErrorsChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentileDistributionChart from '../charts/PercentileDistributionChart';
import PercentilesChart from '../charts/PercentilesChart';
import { RequestsAndResponsesChart } from '../charts/RatesChart';
import RequestCountChart from '../charts/RequestCountChart';
import type { TelemetryChartId } from '../charts/TelemetryCharts';
import { ConcurrentUsersChart, UserEndRateChart, UserStartRateChart } from '../charts/UsersChart';
import StatisticsTable, { STATISTICS_SKELETON_COLUMNS } from '../tables/StatisticsTable';
import useIsCompact from '../useIsCompact';
import DesktopOnly from './DesktopOnly';
import GroupsList from './GroupsList';
import LiveNotice from './LiveNotice';
import { Payload, TableSection, explain, type Slot } from './payload';
import RunGlossary from './RunGlossary';
import RunTelemetry from './RunTelemetry';
import { PERCENTILES, REQUESTS_AND_RESPONSES } from './runSlots';
import {
  useLiveFromShell,
  useRunTerminal,
  useTimeDomainFromShell,
  useWarmupFromShell,
  useWindowFromShell,
} from './useRunWindow';
import WaitingPanel from './WaitingPanel';

/* The Requests charts, in GE's measured order (Requests and Responses per
   Second, Response Time Percentiles, Response Time Distribution, Response
   Time Percentiles Distribution, Errors per Second), then this product's two
   (Gatling's own open-source report has both). GE's "Responses per Second by
   Status" is not drawn: a `simulation.log` carries no HTTP status code. The
   first two slots are imported from `runSlots.ts`: the Summary draws those same
   two charts and the two pages share one spelling of their titles. */
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
const PERCENTILE_DISTRIBUTION: Slot = { id: 'percentile-distribution', title: 'Response time percentiles distribution' };
const ERRORS_PER_SECOND: Slot = { id: 'errors-over-time', title: 'Errors per second' };
const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const REQUEST_COUNTS: Slot = { id: 'request-counts', title: 'Number of requests' };
const USER_START_RATE: Slot = { id: 'user-start-rate', title: 'Users started per second' };
const USER_END_RATE: Slot = { id: 'user-end-rate', title: 'Users ended per second' };
const CONCURRENT_USERS: Slot = { id: 'concurrent-users', title: 'Concurrent users over time' };

/* GE's Connections section holds Bandwidth and TCP Connection By State among
   its nine; those two are what the load-generator agent collects. The rest of
   the agent's charts are GE's Load Generators section. */
const CONNECTION_CHARTS: readonly TelemetryChartId[] = ['telemetry-bandwidth', 'telemetry-tcp-states'];
const LOAD_GENERATOR_CHARTS: readonly TelemetryChartId[] = [
  'telemetry-cpu',
  'telemetry-memory',
  'telemetry-connection-events',
  'telemetry-segment-events',
];

// Two columns from `2xl`, one below it — the break every chart grid on the run
// page uses: each figure holds a 288px plot plus a legend, and two of those in
// a 1280px window leave a 60-bucket time axis dropping every other tick label.
const GRID = 'grid grid-cols-1 gap-6 2xl:grid-cols-2';

/**
 * `/runs/:runId/report` — GE's Report (backlog #7): GE's sections in GE's
 * order, under the time window. This page draws no window control of its own;
 * `RunShell` draws the one brush above it, as it does above every run page
 * that honours a window (all but Trends, Compare and Logs), and this page
 * reads the window it sets. DNS is left out: nothing this product collects could fill it,
 * and a section that can only be empty is a false claim about the run.
 *
 * EACH SECTION BODY IS ITS OWN COMPONENT, because `CollapsibleSection` builds
 * its children only while open: the hooks a body runs — and so the queries it
 * fires — exist only while its section is. A shut Virtual users section asks
 * for no `/users`, and a shut Connections section for no `/telemetry`.
 *
 * Reads the window from the shell, as the tabs it replaces did, so the shell's
 * own fetches and these share their cache keys.
 */
export default function RunReport() {
  const { runId } = useParams<{ runId: string }>();
  const { detail: run } = useRunTerminal(runId);
  const live = useLiveFromShell();
  if (runId === undefined || run.data === undefined) return null;
  // An honest wait until there is something live to draw — the condition the
  // Charts tab this replaces used: no delta yet this session.
  if (run.data.state === 'processing' && live?.lastDelta == null) {
    return <WaitingPanel status={run.data.run.status} />;
  }
  const runStatus = run.data.run.status;

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSection id="requests" title="Requests" defaultOpen>
        {() => <RequestsSection runId={runId} runStatus={runStatus} />}
      </CollapsibleSection>
      <CollapsibleSection id="groups" title="Groups">
        {() => <GroupsSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="virtual-users" title="Virtual users">
        {() => <VirtualUsersSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="connections" title="Connections">
        {() => <RunTelemetry only={CONNECTION_CHARTS} />}
      </CollapsibleSection>
      <CollapsibleSection id="load-generators" title="Load generators">
        {() => <RunTelemetry only={LOAD_GENERATOR_CHARTS} />}
      </CollapsibleSection>
    </div>
  );
}

/**
 * GE's Charts / Table switch. Charts by default, as GE opens. ONE DEVIATION,
 * for this repository's shareable-view rule (AC-DASH-4): a URL carrying the
 * table's own sort (`sort`) or filter (`q`) opens straight on Table, so a
 * shared sorted view lands on what was shared. The choice itself stays out
 * of the URL, as GE keeps it.
 */
function RequestsSection({ runId, runStatus }: { readonly runId: string; readonly runStatus: RunResponse['status'] }) {
  const [params] = useSearchParams();
  const [view, setView] = useState<'charts' | 'table'>(() =>
    params.has('sort') || params.has('q') ? 'table' : 'charts',
  );
  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Requests view" className="flex gap-1">
        {(['charts', 'table'] as const).map((which) => (
          <button
            key={which}
            type="button"
            aria-pressed={view === which}
            onClick={() => setView(which)}
            className="rounded-md border border-default px-2.5 py-1 text-[0.8125rem] aria-pressed:bg-sunken aria-pressed:font-semibold"
          >
            {which === 'charts' ? 'Charts' : 'Table'}
          </button>
        ))}
      </div>
      {view === 'charts' ? <RequestsCharts runId={runId} /> : <RequestsTable runId={runId} runStatus={runStatus} />}
    </div>
  );
}

function RequestsCharts({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  // `enabled` carries the phone gate as well as the render below: the point is
  // not to draw less on a phone but to fetch four payloads and build seven
  // ECharts instances for a screen that cannot usefully show them (§22.6).
  const on = (!compact || shown) && terminal;
  const series = useQuery({ ...seriesQuery(runId, 'run', '', 'response_time', window), enabled: on });
  const stats = useQuery({ ...statsQuery(runId, window), enabled: on });
  const distribution = useQuery({ ...distributionQuery(runId, 'run', '', 'response_time', window), enabled: on });
  const errorSeries = useQuery({ ...errorSeriesQuery(runId, window), enabled: on });

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Seven charts of this run" action="Open the charts" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }

  if (!terminal) {
    // While a run streams only the series has a live source (the delta writes
    // its cache key); the other five are stated, never left as a silent gap.
    return (
      <div className={GRID}>
        {series.data !== undefined && (
          <>
            <RequestsAndResponsesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
            <PercentilesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
          </>
        )}
        <LiveNotice kind="withheld" subject="Response time distribution" />
        <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
        <LiveNotice kind="withheld" subject="Errors per second" />
        <LiveNotice kind="withheld" subject="Response time ranges" />
        <LiveNotice kind="withheld" subject="Number of requests" />
      </div>
    );
  }

  return (
    <div className={GRID}>
      <Payload query={series} slots={[REQUESTS_AND_RESPONSES, PERCENTILES]}>
        {(data) => (
          <>
            <RequestsAndResponsesChart series={data} domainMs={domainMs} warmupMs={warmupMs} />
            <PercentilesChart series={data} domainMs={domainMs} warmupMs={warmupMs} />
          </>
        )}
      </Payload>
      <Payload query={distribution} slots={[DISTRIBUTION, PERCENTILE_DISTRIBUTION]}>
        {(data) => (
          <>
            <DistributionChart distribution={data} />
            <PercentileDistributionChart distribution={data} />
          </>
        )}
      </Payload>
      <Payload query={errorSeries} slots={[ERRORS_PER_SECOND]}>
        {(data) => <ErrorsChart data={data} domainMs={domainMs} warmupMs={warmupMs} />}
      </Payload>
      <Payload query={stats} slots={[INDICATORS, REQUEST_COUNTS]}>
        {(data) => (
          <>
            <IndicatorsChart stats={data} />
            <RequestCountChart stats={data} />
          </>
        )}
      </Payload>
    </div>
  );
}

/** The statistics table as the Overview drew it, one heading level down, with
 *  the glossary under it. */
function RequestsTable({ runId, runStatus }: { readonly runId: string; readonly runStatus: RunResponse['status'] }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const compact = useIsCompact();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  // The table needs per-endpoint rows the live wire excludes on every path.
  if (!terminal) return <LiveNotice kind="withheld" subject="Statistics" />;
  return (
    <>
      <TableSection title="Statistics" headingLevel={3} query={stats} columns={STATISTICS_SKELETON_COLUMNS}>
        {(data) => (
          <DesktopOnly compact={compact} what="The per-request statistics table" action="Open detailed table">
            {() => (
              <StatisticsTable
                stats={data}
                runId={runId}
                runStatus={runStatus}
                windowSelected={window !== null}
                headingLevel={3}
              />
            )}
          </DesktopOnly>
        )}
      </TableSection>
      {/* Every word the glossary defines is in the table above, which is why
          it moved here with it. */}
      <RunGlossary />
    </>
  );
}

function GroupsSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  if (!terminal) return <LiveNotice kind="withheld" subject="Groups" />;
  if (stats.data !== undefined) return <GroupsList runId={runId} stats={stats.data} windowSelected={window !== null} />;
  if (stats.isPending) return <LoadingState label="Loading this run’s groups…" />;
  return <ErrorState title="This run’s groups could not be loaded" detail={explain(stats.error, 'table')} />;
}

function VirtualUsersSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const on = (!compact || shown) && terminal;
  // Read even while live: the live delta writes this same cache key.
  const users = useQuery({ ...usersQuery(runId, window), enabled: on });

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Three charts of this run" action="Open the charts" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }
  const draw = (data: NonNullable<typeof users.data>) => (
    <>
      {/* GE's measured order: Arrival Rate, Termination Rate, Concurrent Users. */}
      <UserStartRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
      <UserEndRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
      <ConcurrentUsersChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
    </>
  );
  if (!terminal) return <div className={GRID}>{users.data !== undefined && draw(users.data)}</div>;
  return (
    <div className={GRID}>
      <Payload query={users} slots={[USER_START_RATE, USER_END_RATE, CONCURRENT_USERS]}>{draw}</Payload>
    </div>
  );
}
