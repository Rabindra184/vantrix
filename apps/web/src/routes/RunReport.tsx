import { useId, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { displayPath } from '@perfportal/contracts';
import type { DistributionResponse, RunResponse, SeriesResponse, StatsResponse, UsersResponse, Window } from '@perfportal/contracts';
import CollapsibleSection from '../components/CollapsibleSection';
import SectionHeading from '../components/SectionHeading';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { ProblemError } from '../api/fetch';
import {
  GroupReadUnsupportedError,
  distributionQuery,
  errorSeriesQuery,
  groupDistributionQuery,
  groupSeriesQuery,
  seriesQuery,
  statsQuery,
  usersQuery,
} from '../api/metrics';
import { RUN_TIME_GROUP } from '../charts/crosshair';
import DistributionChart from '../charts/DistributionChart';
import ErrorsChart from '../charts/ErrorsChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentileDistributionChart from '../charts/PercentileDistributionChart';
import PercentilesChart from '../charts/PercentilesChart';
import { RequestsAndResponsesChart } from '../charts/RatesChart';
import RequestCountChart from '../charts/RequestCountChart';
import ResponsesByStatusChart, { RESPONSES_BY_STATUS } from '../charts/ResponsesByStatusChart';
import { ConcurrentUsersChart, UserEndRateChart, UserStartRateChart } from '../charts/UsersChart';
import { scopePhrase, type Narrowed } from '../charts/transforms/narrowed';
import StatisticsTable, { STATISTICS_SKELETON_COLUMNS } from '../tables/StatisticsTable';
import useIsCompact from '../useIsCompact';
import DesktopOnly from './DesktopOnly';
import GroupsList from './GroupsList';
import LiveNotice from './LiveNotice';
import { Payload, TableSection, Undrawn, explain, type Slot } from './payload';
import RunGlossary from './RunGlossary';
import { isExact } from './statsMethod';
import ConnectionsSection from './report/ConnectionsSection';
import DnsSection from './report/DnsSection';
import { REPORT_GRID } from './report/grid';
import LoadGeneratorsSection from './report/LoadGeneratorsSection';
import { narrowStats, narrowUsers } from './report/narrow';
import ReportFilterControl from './report/ReportFilterControl';
import useReportFilter from './report/useReportFilter';
import useRequestsPick, { requestLabel, type RequestsNames } from './report/useRequestsPick';
import WholeRunNote from './report/WholeRunNote';
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
   Time Percentiles Distribution, Errors per Second, Responses per Second by
   Status), then this product's two (Gatling's own open-source report has
   both). The status chart is the one with another source: a `simulation.log`
   carries no HTTP status code, so it reads the run's agent file, and a run
   without one keeps the figure saying so (`ResponsesByStatusChart`). The
   first two slots are imported from `runSlots.ts`: the Summary draws those same
   two charts and the two pages share one spelling of their titles. */
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
const PERCENTILE_DISTRIBUTION: Slot = { id: 'percentile-distribution', title: 'Response time percentiles distribution' };
const ERRORS_PER_SECOND: Slot = { id: 'errors-over-time', title: 'Errors per second' };
const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const REQUEST_COUNTS: Slot = { id: 'request-counts', title: 'Number of requests' };
/** Every Requests chart in its grid order, for the one moment none can be asked
 *  for yet: before the pick has been checked against the run's names. */
const REQUESTS_SLOTS: readonly Slot[] = [
  REQUESTS_AND_RESPONSES,
  PERCENTILES,
  DISTRIBUTION,
  PERCENTILE_DISTRIBUTION,
  ERRORS_PER_SECOND,
  RESPONSES_BY_STATUS,
  INDICATORS,
  REQUEST_COUNTS,
];
const USER_START_RATE: Slot = { id: 'user-start-rate', title: 'Users started per second' };
const USER_END_RATE: Slot = { id: 'user-end-rate', title: 'Users ended per second' };
const CONCURRENT_USERS: Slot = { id: 'concurrent-users', title: 'Concurrent users over time' };

/**
 * `/runs/:runId/report` — GE's Report (backlog #7): GE's sections in GE's
 * order, under the time window. This page draws no window control of its own;
 * `RunShell` draws the one brush above it — on this page and no other, since
 * this is the only run page that applies a window — and this page reads the
 * window it sets.
 *
 * CONNECTIONS, DNS AND LOAD GENERATORS DRAW THE RUN'S AGENT FILE — the
 * on-prem runner's Gatling agent records them and the API serves them under
 * `/v1/runs/:id/agent/*` (GE report parity PRs 1 and 2). A run with no agent
 * file keeps the load-generator telemetry in Connections and Load generators
 * (spec §7.5); DNS, which nothing else records, says the run has none. Each
 * section's states before drawing are one gate's (`AgentSectionGate`), so the
 * three cannot drift into saying them three ways.
 *
 * EACH SECTION BODY IS ITS OWN COMPONENT, because `CollapsibleSection` builds
 * its children only while open: the hooks a body runs — and so the queries it
 * fires — exist only while its section is. A shut Virtual users section asks
 * for no `/users`, and a shut Connections section for no `/agent`.
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
  // Decides whether the percentile caveat is an estimate's, and whether the
  // Requests and Groups tables mark their percentile headings with ≈.
  const exact = isExact(run.data.run.statsMethod);

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSection id="requests" title="Requests" defaultOpen>
        {() => <RequestsSection runId={runId} runStatus={runStatus} exact={exact} />}
      </CollapsibleSection>
      <CollapsibleSection id="groups" title="Groups">
        {() => <GroupsSection runId={runId} exact={exact} />}
      </CollapsibleSection>
      <CollapsibleSection id="virtual-users" title="Virtual users">
        {() => <VirtualUsersSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="connections" title="Connections">
        {() => <ConnectionsSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="dns" title="DNS">
        {() => <DnsSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="load-generators" title="Load generators">
        {() => <LoadGeneratorsSection runId={runId} />}
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
 *
 * ═══ AND GE'S GROUP AND REQUEST PICKERS, BESIDE IT ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, sections 5-7)
 *
 * The pick narrows BOTH views, so it lives here, above them, and so does the
 * phone's "draw it anyway" choice: the pickers sit behind the same
 * `DesktopOnly` gate as what they drive, and a reader who opens the charts on
 * a phone has opened the table too. They are not drawn while the run streams:
 * the live wire carries run-scope series only, so there is nothing to narrow.
 */
function RequestsSection({
  runId,
  runStatus,
  exact,
}: {
  readonly runId: string;
  readonly runStatus: RunResponse['status'];
  readonly exact: boolean;
}) {
  const [params] = useSearchParams();
  const [view, setView] = useState<'charts' | 'table'>(() =>
    params.has('sort') || params.has('q') ? 'table' : 'charts',
  );
  const { terminal } = useRunTerminal(runId);
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const drawn = !compact || shown;
  const narrowing = useRequestsNarrowing(runId, terminal, terminal && drawn);
  return (
    <div className="flex flex-col gap-4">
      <div data-testid="requests-bar" className="flex flex-wrap items-start gap-x-6 gap-y-2">
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
        {terminal && drawn &&
          (narrowing.failed ? (
            <NamesUnavailable linked={params.has('requests-group') || params.has('requests-request')} />
          ) : (
            <RequestsPickers narrowing={narrowing} />
          ))}
      </div>
      {view === 'charts' ? (
        <RequestsCharts runId={runId} drawn={drawn} onShow={() => setShown(true)} narrowing={narrowing} />
      ) : (
        <RequestsTable
          runId={runId}
          runStatus={runStatus}
          exact={exact}
          drawn={drawn}
          onShow={() => setShown(true)}
          narrowing={narrowing}
        />
      )}
    </div>
  );
}

/** What the Requests section's pick narrows its figures to. */
interface Narrowing {
  /** The run's WHOLE-RUN `/stats`, which the pick is checked against. */
  readonly names: UseQueryResult<StatsResponse>;
  /**
   * That read has answered — or failed — so a figure may be asked for. Until
   * then none is (Review Focus 3): before the names are known every pick reads
   * as All, and asking then would fetch the run's figures under a link that
   * named a group, to be thrown away when the pick resolves (and drawn
   * meanwhile with nothing saying they are not it).
   */
  readonly settled: boolean;
  /**
   * The names read FAILED, so no pick can be checked (ruling R14). Every pick
   * reads as All and the figures draw unnarrowed — which is honest only
   * because the pickers' place then says so (`NamesUnavailable`).
   */
  readonly failed: boolean;
  readonly pick: ReturnType<typeof useRequestsPick>;
  /** The run's group paths, for a request's label. */
  readonly groupNames: readonly string[];
  /** What each narrowable chart is told, memoised; `null` for no pick. */
  readonly narrowed: Narrowed;
  /** The requests `/stats` is narrowed to (`narrowStats`), or `null` for no pick. */
  readonly kept: readonly string[] | null;
}

const NO_GROUPS: readonly string[] = [];

/**
 * The pick, checked against the run's own names.
 *
 * ═══ THE NAMES ARE WHOLE-RUN, NEVER THE WINDOW'S (ruling R13) ═══
 *
 * `statsQuery(runId, null)`, whatever the window: a windowed `/stats` builds
 * its rows only from the buckets inside the window, so under a brush a request
 * with no traffic there would drop out of the picker — a pick of it would read
 * as All and be named as never recorded, which is false — and every re-keyed
 * window would blank the pickers while its `/stats` loads. The charts and the
 * Table still read the window's `/stats`; only the names do not. With no window
 * the two are one key, and one request.
 *
 * `names` is memoised on the payload because `useRequestsPick` keys its own
 * memo on it, and `narrowed` because every chart keys its option on it.
 *
 * While the run streams (`terminal` false) nothing is narrowed, whatever the
 * URL or the cache holds: the live branch draws the run-scope series the
 * delta writes, and a pick would point it at a key no delta fills.
 */
function useRequestsNarrowing(runId: string, terminal: boolean, enabled: boolean): Narrowing {
  const names = useQuery({ ...statsQuery(runId, null), enabled });
  const known = useMemo<RequestsNames | undefined>(() => {
    if (names.data === undefined) return undefined;
    const rows = names.data.stats;
    return {
      requests: rows.filter((r) => r.scope === 'request' && r.family === 'response_time').map((r) => r.name),
      groups: rows.filter((r) => r.scope === 'group' && r.family === 'group_cumulated').map((r) => r.name),
    };
  }, [names.data]);
  const pick = useRequestsPick(known);
  const groupNames = known?.groups ?? NO_GROUPS;
  const { group, request, members } = pick;
  const narrowed = useMemo<Narrowed>(() => {
    if (!terminal) return null;
    if (request !== '*') return { kind: 'request', name: request, label: requestLabel(request, groupNames) };
    if (group !== '*') return { kind: 'group', name: group };
    return null;
  }, [terminal, request, group, groupNames]);
  const kept = useMemo<readonly string[] | null>(() => {
    if (narrowed === null) return null;
    return narrowed.kind === 'request' ? [narrowed.name] : members;
  }, [narrowed, members]);
  return {
    names,
    settled: !names.isPending,
    failed: names.isError && names.data === undefined,
    pick,
    groupNames,
    narrowed,
    kept,
  };
}

/**
 * The pickers' place when the run's names could not be loaded (ruling R14).
 *
 * Holding the figures until the names arrive would leave a section of
 * "Loading…" over a read that is not coming; drawing them unnarrowed with
 * nothing said would drop a link's pick silently. So they draw, and this one
 * line says what that means: a link that named a group or a request was not
 * checked, and every request is shown; with no pick asked for, only that the
 * picks are unavailable. Plain text, not a live region: it describes the
 * section the reader arrived at, nothing that changed under them.
 */
function NamesUnavailable({ linked }: { readonly linked: boolean }) {
  return (
    <p data-testid="requests-names-unavailable" className="text-[0.75rem] text-muted">
      {linked
        ? 'This link’s group or request could not be checked, because this run’s request names could not be loaded, so every request is shown.'
        : 'Group and request picks are unavailable, because this run’s request names could not be loaded.'}
    </p>
  );
}

/**
 * Group, then Request (spec section 5), each `ReportFilterControl`'s 0 / 1 /
 * many rule. Each control is handed the hook's own answer as its `value`: the
 * note beside it says what is shown in place of a link's value, and it works
 * that out from `value`, so anything else would make the note false.
 *
 * "Pick a group first." only where the Group control offers a choice (review
 * M1): a run with no groups, or with every request in one group, shows that
 * group read-only and the Request control usable straight away.
 */
function RequestsPickers({ narrowing }: { readonly narrowing: Narrowing }) {
  const { pick, groupNames } = narrowing;
  const waiting = pick.groups.length > 1 && pick.group === '*' && pick.members.length === 0;
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      {/* Each control's own box, so the two "this link named…" notes that can
          show at once are told apart. */}
      <div data-testid="requests-group-picker">
        <ReportFilterControl
          label="Group"
          allLabel="All groups"
          values={pick.groups}
          value={pick.group}
          onChange={pick.setGroup}
          named={pick.namedGroup}
          verb="recorded"
          labelOf={displayPath}
        />
      </div>
      <div data-testid="requests-request-picker">
        <ReportFilterControl
          label="Request"
          allLabel="All requests"
          values={pick.members}
          value={pick.request}
          onChange={pick.setRequest}
          named={pick.namedRequest}
          verb="recorded"
          labelOf={(name) => requestLabel(name, groupNames)}
          disabledReason={waiting ? 'Pick a group first.' : undefined}
        />
      </div>
    </div>
  );
}

/** A query's options, whichever read the pick chose: the keys differ in shape. */
interface Read<T> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => Promise<T>;
  readonly staleTime: number;
}

/** The series the pick reads: one request's, a group's merged, or the run's. */
function seriesRead(runId: string, narrowed: Narrowed, window: Window | null): Read<SeriesResponse> {
  if (narrowed?.kind === 'request') return seriesQuery(runId, 'request', narrowed.name, 'response_time', window);
  if (narrowed?.kind === 'group') return groupSeriesQuery(runId, narrowed.name, window);
  return seriesQuery(runId, 'run', '', 'response_time', window);
}

/** The distribution the pick reads, as `seriesRead` chooses. */
function distributionRead(runId: string, narrowed: Narrowed, window: Window | null): Read<DistributionResponse> {
  if (narrowed?.kind === 'request') return distributionQuery(runId, 'request', narrowed.name, 'response_time', window);
  if (narrowed?.kind === 'group') return groupDistributionQuery(runId, narrowed.name, window);
  return distributionQuery(runId, 'run', '', 'response_time', window);
}

/** The spec's 409 state (section 7), in the section's words rather than the server's. */
const NOT_MERGEABLE = "This run's group figures cannot be merged: it predates exact statistics.";

/**
 * A group read's two failures are the section's own sentences, never the
 * server's or `explain`'s: `explain` prefixes any error that is not a problem
 * document ("This chart's data could not be loaded: …"), and the 409's own
 * detail is written for an API consumer. Anything else is `null`, for
 * `Payload` to explain as it explains every other failure.
 */
function groupFailure(error: unknown): string | null {
  if (error instanceof GroupReadUnsupportedError) return error.message;
  if (error instanceof ProblemError && error.code === 'GROUP_NOT_MERGEABLE') return NOT_MERGEABLE;
  return null;
}

/** `Payload`, with a failed group read worded by `groupFailure` in each chart it feeds. */
function PickPayload<T>({
  query,
  slots,
  children,
}: {
  readonly query: UseQueryResult<T>;
  readonly slots: readonly Slot[];
  readonly children: (data: T) => ReactNode;
}) {
  const failure = query.data === undefined ? groupFailure(query.error) : null;
  if (failure !== null) return <>{slots.map((slot) => <Undrawn key={slot.id} slot={slot} reason={failure} />)}</>;
  return (
    <Payload query={query} slots={slots}>
      {children}
    </Payload>
  );
}

/**
 * The two charts that cannot narrow (spec section 6). A DELIBERATE DEVIATION
 * from the spec's "Shows the whole run: …" (ruling R15): under a window these
 * charts show that window, across every request, so "the whole run" would be
 * false of exactly the reader who brushed one. "Every request" is true with a
 * window or without.
 */
const ERRORS_WHOLE_RUN = 'Shows every request: errors are not recorded per request.';
const STATUS_WHOLE_RUN = 'Shows every request: status codes are not recorded per request.';

function RequestsCharts({
  runId,
  drawn,
  onShow,
  narrowing,
}: {
  readonly runId: string;
  /** Not a phone, or a phone whose reader asked for the charts. */
  readonly drawn: boolean;
  readonly onShow: () => void;
  readonly narrowing: Narrowing;
}) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  /* WHAT EVERY CHART BELOW IS TOLD, because a window that selects nothing and a
     run that recorded nothing draw the same empty payload. Each chart's "nothing
     was recorded" sentence names the WINDOW when this is true and the RUN when it
     is not — it must not claim a fact about the run when the reader asked about a
     slice of it. Required on every chart (no default), so a chart added here
     without it does not compile. */
  const windowSelected = window !== null;
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const { settled, narrowed, kept } = narrowing;
  // `enabled` carries the phone gate as well as the render below: the point is
  // not to draw less on a phone but to fetch five payloads and build eight
  // ECharts instances for a screen that cannot usefully show them (§22.6). The
  // status chart fetches its own, and is mounted only behind both gates.
  const on = drawn && terminal;
  // Every figure waits for the pick to be checked (`Narrowing.settled`). The
  // charts' own `/stats` does not: it is not a figure, and with no window it
  // IS the names read.
  const reads = on && settled;
  const series = useQuery({ ...seriesRead(runId, narrowed, window), enabled: reads });
  const stats = useQuery({ ...statsQuery(runId, window), enabled: on });
  const distribution = useQuery({ ...distributionRead(runId, narrowed, window), enabled: reads });
  const errorSeries = useQuery({ ...errorSeriesQuery(runId, window), enabled: reads });
  // `narrowStats` is additive (narrow.ts): a group's ranges and counts are its
  // members' rows summed, so the browser narrows them from the payload it holds.
  const narrowedStats = useMemo(
    () => (stats.data === undefined || kept === null ? stats.data : narrowStats(stats.data, kept)),
    [stats.data, kept],
  );

  if (!drawn) {
    return (
      <DesktopOnly compact what="Eight charts of this run" action="Open the request charts" onShow={onShow}>
        {() => null}
      </DesktopOnly>
    );
  }

  if (!terminal) {
    // While a run streams only the series has a live source (the delta writes
    // its cache key); the other six are stated, never left as a silent gap.
    // The status chart among them reads an agent file the run does not have
    // yet, so it is withheld here and never mounted: no request while live.
    return (
      <div className={REPORT_GRID}>
        {series.data !== undefined && (
          <>
            <RequestsAndResponsesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} />
            <PercentilesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} />
          </>
        )}
        <LiveNotice kind="withheld" subject="Response time distribution" />
        <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
        <LiveNotice kind="withheld" subject="Errors per second" />
        <LiveNotice kind="withheld" subject={RESPONSES_BY_STATUS.title} />
        <LiveNotice kind="withheld" subject="Response time ranges" />
        <LiveNotice kind="withheld" subject="Number of requests" />
      </div>
    );
  }

  if (!settled) {
    // `Payload`'s own pending wording, in every figure's place: the figures
    // are not asked for yet, so none of them can be drawn, and none may be
    // drawn from a cache entry the pick is about to replace.
    return (
      <div className={REPORT_GRID}>
        {REQUESTS_SLOTS.map((slot) => (
          <Undrawn key={slot.id} slot={slot} reason="Loading…" />
        ))}
      </div>
    );
  }

  const errorsCell = (
    <Payload query={errorSeries} slots={[ERRORS_PER_SECOND]}>
      {(data) => <ErrorsChart data={data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} />}
    </Payload>
  );
  const statusCell = <ResponsesByStatusChart runId={runId} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} />;

  return (
    <div className={REPORT_GRID}>
      {series.error instanceof GroupReadUnsupportedError ? (
        // ONE sentence for the four charts a group read feeds (ruling R8), and
        // none of those charts: an older API answered the run's own figures, and
        // drawing anything under the pick — an empty distribution included —
        // would read as the group's.
        <p data-testid="group-unsupported" role="status" className="text-sm text-muted 2xl:col-span-2">
          {series.error.message}
        </p>
      ) : (
        <>
          <PickPayload query={series} slots={[REQUESTS_AND_RESPONSES, PERCENTILES]}>
            {(data) => (
              <>
                <RequestsAndResponsesChart series={data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} narrowed={narrowed} />
                <PercentilesChart series={data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} narrowed={narrowed} />
              </>
            )}
          </PickPayload>
          <PickPayload query={distribution} slots={[DISTRIBUTION, PERCENTILE_DISTRIBUTION]}>
            {(data) => (
              <>
                <DistributionChart distribution={data} windowSelected={windowSelected} narrowed={narrowed} />
                <PercentileDistributionChart distribution={data} windowSelected={windowSelected} narrowed={narrowed} />
              </>
            )}
          </PickPayload>
        </>
      )}
      {narrowed === null ? errorsCell : <WholeRunNote note={ERRORS_WHOLE_RUN}>{errorsCell}</WholeRunNote>}
      {narrowed === null ? statusCell : <WholeRunNote note={STATUS_WHOLE_RUN}>{statusCell}</WholeRunNote>}
      <Payload query={stats} slots={[INDICATORS, REQUEST_COUNTS]}>
        {(data) => (
          <>
            <IndicatorsChart stats={narrowedStats ?? data} windowSelected={windowSelected} narrowed={narrowed} />
            <RequestCountChart stats={narrowedStats ?? data} windowSelected={windowSelected} narrowed={narrowed} />
          </>
        )}
      </Payload>
    </div>
  );
}

/**
 * The table under a pick: `narrowStats`' rows, less the group rows that are
 * not the pick's own subtree (ruling R10b). `narrowStats` keeps every group
 * on a member's path so the tree can nest, which for a nested group or a
 * request brings in its ANCESTORS — `Catalog`'s row, whose figures are all of
 * `Catalog`'s, under a pick of `Catalog/Recommendations`. A request pick keeps
 * no group row at all, and so does "(no group)", which has none to keep.
 */
function pickTable(stats: StatsResponse, kept: readonly string[], narrowed: NonNullable<Narrowed>): StatsResponse {
  const narrowedStats = narrowStats(stats, kept);
  const ownGroup = (name: string) =>
    narrowed.kind === 'group' && narrowed.name !== '' && (name === narrowed.name || name.startsWith(`${narrowed.name}/`));
  return { ...narrowedStats, stats: narrowedStats.stats.filter((row) => row.scope !== 'group' || ownGroup(row.name)) };
}

/** The statistics table as the Overview drew it, one heading level down, with
 *  the glossary under it — narrowed to the pick, with no All Requests row,
 *  since the run's total is not the pick's. */
function RequestsTable({
  runId,
  runStatus,
  exact,
  drawn,
  onShow,
  narrowing,
}: {
  readonly runId: string;
  readonly runStatus: RunResponse['status'];
  readonly exact: boolean;
  readonly drawn: boolean;
  readonly onShow: () => void;
  readonly narrowing: Narrowing;
}) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  const { names, settled, narrowed, kept } = narrowing;
  const view = useMemo(
    () => (stats.data === undefined || kept === null || narrowed === null ? stats.data : pickTable(stats.data, kept, narrowed)),
    [stats.data, kept, narrowed],
  );
  // The table needs per-endpoint rows the live wire excludes on every path.
  if (!terminal) return <LiveNotice kind="withheld" subject="Statistics" />;
  return (
    <>
      {/* Until the pick is checked the table waits on the names read, as the
          charts do: it would otherwise draw every row under a link for one.
          Not on a phone that has not asked for it: the names are not read
          there yet, and the wait would stand in for the offer to open it. */}
      <TableSection
        title="Statistics"
        headingLevel={3}
        query={settled || !drawn ? stats : names}
        columns={STATISTICS_SKELETON_COLUMNS}
      >
        {(data) => (
          <DesktopOnly compact={!drawn} what="The per-request statistics table" action="Open detailed table" onShow={onShow}>
            {() =>
              narrowed !== null && !view!.stats.some((row) => row.scope === 'request') ? (
                <PickEmpty windowSelected={window !== null} narrowed={narrowed} />
              ) : (
                <StatisticsTable
                  stats={view ?? data}
                  runId={runId}
                  runStatus={runStatus}
                  windowSelected={window !== null}
                  exact={exact}
                  headingLevel={3}
                />
              )
            }
          </DesktopOnly>
        )}
      </TableSection>
      {/* Every word the glossary defines is in the table above, which is why
          it moved here with it. */}
      <RunGlossary />
    </>
  );
}

/**
 * A narrowed table with nothing in it — the pick held no request in the
 * window. `StatisticsTable`'s own empty sentence would say no requests ran in
 * the window, which is false whenever another did: the scoped-empty rule, as
 * the charts beside it word it (`scopePhrase`).
 */
function PickEmpty({ windowSelected, narrowed }: { readonly windowSelected: boolean; readonly narrowed: Narrowed }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} level={3} overline="Run telemetry">
        Statistics
      </SectionHeading>
      <EmptyState title={`Nothing was recorded ${scopePhrase({ windowSelected, narrowed })}`} />
    </section>
  );
}

function GroupsSection({ runId, exact }: { readonly runId: string; readonly exact: boolean }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  if (!terminal) return <LiveNotice kind="withheld" subject="Groups" />;
  if (stats.data !== undefined) return <GroupsList runId={runId} stats={stats.data} windowSelected={window !== null} exact={exact} />;
  if (stats.isPending) return <LoadingState label="Loading this run’s groups…" />;
  return <ErrorState title="This run’s groups could not be loaded" detail={explain(stats.error, 'table')} />;
}

const USERS_SLOTS: readonly Slot[] = [USER_START_RATE, USER_END_RATE, CONCURRENT_USERS];

/**
 * GE's three Virtual users charts, narrowed to one scenario
 * (`?users-scenario=`, spec sections 1 and 5).
 *
 * NO NEW REQUEST: `/users` already carries one series per scenario, so the
 * browser narrows the payload it holds (`narrowUsers`), and every chart is
 * told the pick (`narrowed`) — which is what drops their "All users" line,
 * since that keys on the pick and not on the payload. The two travel together:
 * the payload alone under a pick would draw the scenario and a second,
 * identical line named "All users"; the pick alone would draw every scenario
 * under a chart saying it was narrowed to one.
 *
 * The picker sits behind the same phone gate as the charts it drives, and is
 * not drawn while the run streams: the live wire writes the run's users whole,
 * and nothing is narrowed until the run is terminal (the Requests section's
 * rule).
 */
function VirtualUsersSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  // The same flag `RequestsCharts` hands its charts, for the same reason: an
  // empty window must not say the run had no user activity.
  const windowSelected = window !== null;
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const [params] = useSearchParams();
  const on = (!compact || shown) && terminal;
  // Read even while live: the live delta writes this same cache key.
  const users = useQuery({ ...usersQuery(runId, window), enabled: on });
  const pick = useScenarioPick(runId, terminal, on);
  const { narrowed } = pick;
  const narrowedUsers = useMemo(
    () => (users.data === undefined || narrowed === null ? users.data : narrowUsers(users.data, narrowed.name)),
    [users.data, narrowed],
  );

  if (compact && !shown) {
    return (
      <DesktopOnly
        compact
        what="Three charts of this run"
        action="Open the virtual-user charts"
        onShow={() => setShown(true)}
      >
        {() => null}
      </DesktopOnly>
    );
  }
  const draw = (data: UsersResponse) => (
    <>
      {/* GE's measured order: Arrival Rate, Termination Rate, Concurrent Users. */}
      <UserStartRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} narrowed={narrowed} />
      <UserEndRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} narrowed={narrowed} />
      <ConcurrentUsersChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} narrowed={narrowed} />
    </>
  );
  // ONE rule keeps a streaming run whole: `narrowed` is null until the run is
  // terminal (`useScenarioPick`), so this draws the delta's users as written.
  // Not a second `null` here as well — two guards that agree on every state
  // mask each other, and neither could then be shown to matter.
  if (!terminal) return <div className={REPORT_GRID}>{narrowedUsers !== undefined && draw(narrowedUsers)}</div>;
  return (
    <div className="flex flex-col gap-4">
      {pick.failed ? (
        <ScenariosUnavailable linked={params.has('users-scenario')} />
      ) : (
        <div data-testid="users-scenario-picker">
          <ReportFilterControl
            label="Scenario"
            allLabel="All scenarios"
            values={pick.scenarios}
            value={pick.scenario}
            onChange={pick.setScenario}
            named={pick.named}
            verb="recorded"
          />
        </div>
      )}
      <div className={REPORT_GRID}>
        {pick.settled ? (
          <Payload query={users} slots={USERS_SLOTS}>
            {(data) => draw(narrowedUsers ?? data)}
          </Payload>
        ) : (
          // `Payload`'s own pending wording: no chart may draw until the pick
          // has been checked, or a link for one scenario would show them all
          // first (see `useScenarioPick`).
          USERS_SLOTS.map((slot) => <Undrawn key={slot.id} slot={slot} reason="Loading…" />)
        )}
      </div>
    </div>
  );
}

/** What Virtual users' scenario pick narrows its charts to. */
interface ScenarioPick {
  /** The run's scenarios, whole-run, in the payload's order; empty until known. */
  readonly scenarios: readonly string[];
  /** `useReportFilter`'s answer: one of `scenarios`, or `*`. */
  readonly scenario: string;
  readonly setScenario: (next: string) => void;
  /** A scenario the link named that the run never recorded, or null. */
  readonly named: string | null;
  /** The scenario list has answered, or failed, so a chart may be drawn. */
  readonly settled: boolean;
  /** The scenario list FAILED, so no pick can be checked (`ScenariosUnavailable`). */
  readonly failed: boolean;
  /** What each chart is told, memoised; `null` for no pick and while live. */
  readonly narrowed: Narrowed;
}

const NO_SCENARIOS: readonly string[] = [];

/**
 * The scenario pick, checked against the run's own scenarios.
 *
 * ═══ THE SCENARIOS ARE WHOLE-RUN, NEVER THE WINDOW'S ═══
 *
 * `usersQuery(runId, null)`, whatever the window: the API builds a windowed
 * `/users` from the buckets inside the range ALONE, so a scenario with no
 * bucket there — one that had not started yet, or had already finished — is
 * absent from it. Read from the window, it would leave the picker under a
 * brush, and a link for it would read as All and be named as never recorded,
 * which is false (ruling R13's lesson, for the Requests names). The charts
 * still read the window's `/users`; with no window the two are one key and
 * one request.
 *
 * The CHARTS wait for this read (`settled`), although it fetches nothing new
 * for them: under a window the figures' read can answer first, and drawing it
 * then would put every scenario on screen under a link for one.
 *
 * While the run streams nothing is narrowed, whatever the URL holds: this key
 * is the one the live delta writes.
 */
function useScenarioPick(runId: string, terminal: boolean, enabled: boolean): ScenarioPick {
  const names = useQuery({ ...usersQuery(runId, null), enabled });
  const known = useMemo(() => names.data?.scenarios.map((s) => s.scenario), [names.data]);
  const [scenario, setScenario, named] = useReportFilter('users-scenario', known, 'virtual-users');
  const narrowed = useMemo<Narrowed>(
    () => (terminal && scenario !== '*' ? { kind: 'scenario', name: scenario } : null),
    [terminal, scenario],
  );
  return {
    scenarios: known ?? NO_SCENARIOS,
    scenario,
    setScenario,
    named,
    settled: !names.isPending,
    failed: names.isError && names.data === undefined,
    narrowed,
  };
}

/**
 * The picker's place when the run's scenarios could not be loaded (ruling
 * R14, for this section). The charts then draw unnarrowed — or say they could
 * not be loaded, with no window, where the scenario list IS their read — so
 * the sentence claims only what is true either way: nothing here is narrowed
 * to the link's scenario. Plain text, not a live region.
 */
function ScenariosUnavailable({ linked }: { readonly linked: boolean }) {
  return (
    <p data-testid="users-names-unavailable" className="text-[0.75rem] text-muted">
      {linked
        ? 'This link’s scenario could not be checked, because this run’s scenarios could not be loaded, so these charts are not narrowed to it.'
        : 'The scenario pick is unavailable, because this run’s scenarios could not be loaded.'}
    </p>
  );
}
