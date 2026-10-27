import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentConnectionsResponse, AgentUnavailableReason } from '@perfportal/contracts';
import { agentConnectionsQuery, agentSummaryQuery } from '../../api/agent';
import AgentDurationCharts from '../../charts/AgentDurationCharts';
import Chart from '../../charts/Chart';
import { RUN_TIME_GROUP } from '../../charts/crosshair';
import type { TelemetryChartId } from '../../charts/TelemetryCharts';
import { toBandwidth, toConnectionRate, toTcpStates } from '../../charts/transforms/agentRates';
import type { TimeDomainMs } from '../../charts/types';
import useIsCompact from '../../useIsCompact';
import DesktopOnly from '../DesktopOnly';
import LiveNotice from '../LiveNotice';
import { Payload, type Slot } from '../payload';
import RunTelemetry from '../RunTelemetry';
import { useRunTerminal, useTimeDomainFromShell, useWindowFromShell } from '../useRunWindow';
import AgentUnavailable from './AgentUnavailable';
import useReportFilter from './useReportFilter';

/* The load-generator telemetry this section falls back to for a run with no
   agent file: GE's Connections holds Bandwidth and TCP Connection By State
   among its nine, and those two are what the telemetry agent collects. One
   definition — the Report imports it. */
export const CONNECTION_CHARTS: readonly TelemetryChartId[] = ['telemetry-bandwidth', 'telemetry-tcp-states'];

const ACTION = 'Open the connection charts';
const SUBJECT = 'connection figures';

const TCP_CONNECT = {
  overTime: 'TCP Connect Duration Percentiles',
  distribution: 'TCP Connect Duration Distribution',
  percentiles: 'TCP Connection Percentiles Distribution',
} as const;
const TLS = {
  overTime: 'TLS Handshake Duration Percentiles',
  distribution: 'TLS Handshake Duration Distribution',
  percentiles: 'TLS Handshake Duration Percentiles Distribution',
} as const;

/** GE's nine Connections charts, in GE's order, titled verbatim (spec §2). */
const SLOTS: readonly Slot[] = [
  { id: 'agent-connection-rate', title: 'Connection Open and Close Rate' },
  { id: 'agent-tcp-states', title: 'TCP Connection By State' },
  { id: 'agent-tcp-connect-percentiles', title: TCP_CONNECT.overTime },
  { id: 'agent-tcp-connect-distribution', title: TCP_CONNECT.distribution },
  { id: 'agent-tcp-connect-percentiles-distribution', title: TCP_CONNECT.percentiles },
  { id: 'agent-tls-percentiles', title: TLS.overTime },
  { id: 'agent-tls-distribution', title: TLS.distribution },
  { id: 'agent-tls-percentiles-distribution', title: TLS.percentiles },
  { id: 'agent-bandwidth', title: 'Bandwidth Usage per second' },
];

// The run page's chart grid — see `RunReport`'s `GRID`.
const GRID = 'grid grid-cols-1 gap-6 2xl:grid-cols-2';

/**
 * The Report's Connections section, from the run's agent file — GE's nine
 * charts, filtered by remote (`?remote=`, `useReportFilter`).
 *
 * ═══ WHAT EACH STATE SAYS, IN ORDER ═══
 *
 * 1. NOT TERMINAL: a withheld notice per chart, and NO request. Every agent
 *    read answers 200 or an error, never a run body at 202, and a live run's
 *    figures do not exist yet — `RunTelemetry`'s `enabled: … && terminal` rule.
 *    Ahead of the phone gate, as there: nine sentences are not nine charts.
 * 2. THE SUMMARY decides the rest, so it is read first and the figure read is
 *    held until it answers — which is what lets `useReportFilter` check
 *    `?remote=` against `summary.remotes` before any request carries it.
 *    It is read on a phone too: one small body, and without it a phone could
 *    not tell "no agent file" (telemetry's own phone gate takes over) from a
 *    collected run (this section's gate), and would gate twice.
 * 3. NO AGENT FILE (`not_collected`) keeps `RunTelemetry`'s two connection
 *    charts, as this section drew before (spec §7.5) — they may still exist.
 * 4. ANY OTHER UNAVAILABLE ANSWER is said, never replaced: an `unreadable`
 *    file was there, and showing telemetry instead would misstate the run.
 *    An HTTP collector that was off is read from the summary's header — the
 *    same fact the API answers `http_not_collected` from — so no figure read
 *    is made for it; the figure read's own answer is honoured too.
 * 5. A PHONE is offered the charts (§22.6) and fetches nothing until asked.
 */
export default function ConnectionsSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const remoteSelectId = useId();

  // EVERY HOOK RUNS ON EVERY RENDER: the early returns below come after all of
  // them, so a run finishing, or a phone reader pressing the button, changes
  // no hook order. What would have been implicit in "not constructed" is said
  // through `enabled` instead.
  const summaryQuery = useQuery({ ...agentSummaryQuery(runId), enabled: terminal });
  const summary = summaryQuery.data;
  const [remote, setRemote] = useReportFilter('remote', summary?.remotes);
  const collected = summary?.available === true && summary.header?.collects.http !== false;
  const connections = useQuery({
    ...agentConnectionsQuery(runId, remote, window),
    enabled: terminal && collected && (!compact || shown),
  });

  if (!terminal) {
    return (
      <div className={GRID}>
        {SLOTS.map((slot) => (
          <LiveNotice key={slot.id} kind="withheld" subject={slot.title} />
        ))}
      </div>
    );
  }

  if (summary === undefined) {
    return (
      <div className={GRID}>
        <Payload query={summaryQuery} slots={SLOTS}>
          {() => null}
        </Payload>
      </div>
    );
  }

  if (!summary.available) return <Unavailable reason={summary.reason} detail={summary.detail} />;
  if (summary.header?.collects.http === false) {
    return <Unavailable reason="http_not_collected" detail={summary.header.reasons.http ?? null} />;
  }

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Nine connection charts of this run" action={ACTION} onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }

  if (connections.data !== undefined && !connections.data.available) {
    return <Unavailable reason={connections.data.reason} detail={connections.data.detail} />;
  }

  // The agent's own reason its machine collector was off, for the TCP states chart.
  const notMeasuredReason = summary.header?.collects.machine === false ? summary.header.reasons.machine : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Hidden with no remote at all: "All remotes" alone is a control that
          does nothing — the rule `RunTelemetry`'s host picker follows. */}
      {summary.remotes.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor={remoteSelectId} className="shrink-0 text-[0.75rem] text-muted">
            Remote
          </label>
          <select
            id={remoteSelectId}
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            className="min-w-0 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
          >
            <option value="*">All remotes</option>
            {summary.remotes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className={GRID}>
        <Payload query={connections} slots={SLOTS}>
          {(data) => (
            <ConnectionCharts
              data={data}
              domainMs={domainMs}
              windowSelected={window !== null}
              notMeasuredReason={notMeasuredReason}
            />
          )}
        </Payload>
      </div>
    </div>
  );
}

/**
 * Why there are no agent figures. `not_collected` — and a null reason, which
 * the API never sends with `available: false` but the contract allows — keeps
 * the load-generator telemetry; anything else is said in its own words.
 */
function Unavailable({ reason, detail }: { readonly reason: AgentUnavailableReason | null; readonly detail: string | null }) {
  if (reason === null || reason === 'not_collected') return <RunTelemetry only={CONNECTION_CHARTS} action={ACTION} />;
  return <AgentUnavailable reason={reason} detail={detail} subject={SUBJECT} />;
}

function ConnectionCharts({
  data,
  domainMs,
  windowSelected,
  notMeasuredReason,
}: {
  readonly data: AgentConnectionsResponse;
  readonly domainMs: TimeDomainMs | undefined;
  readonly windowSelected: boolean;
  readonly notMeasuredReason: string | undefined;
}) {
  // Memoised: `Chart`'s option effect depends on `data` by identity.
  const rate = useMemo(() => toConnectionRate(data, { windowSelected }), [data, windowSelected]);
  const states = useMemo(
    () => toTcpStates(data, { windowSelected, notMeasuredReason }),
    [data, windowSelected, notMeasuredReason],
  );
  const bandwidth = useMemo(() => toBandwidth(data, { windowSelected }), [data, windowSelected]);
  // Every time chart: a value axis in ms, labelled as clock time, on the shell's domain.
  const xAxis = { type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1] } as const;

  return (
    <>
      <Chart
        id="agent-connection-rate"
        title={SLOTS[0]!.title}
        data={rate}
        kind="line"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={xAxis}
        yAxis={{ name: 'Connections/s' }}
        unit="conn/s"
        group={RUN_TIME_GROUP}
      />
      <Chart
        id="agent-tcp-states"
        title={SLOTS[1]!.title}
        data={states}
        kind="line"
        pairValue="y"
        xAxis={xAxis}
        // A gauge, drawn as stored: never divided by the bucket width.
        yAxis={{ name: 'Connections' }}
        group={RUN_TIME_GROUP}
      />
      <AgentDurationCharts
        idPrefix="agent-tcp-connect"
        titles={TCP_CONNECT}
        section={data.tcpConnect}
        noun="TCP connects"
        domainMs={domainMs}
        windowSelected={windowSelected}
      />
      <AgentDurationCharts
        idPrefix="agent-tls"
        titles={TLS}
        section={data.tlsHandshake}
        noun="TLS handshakes"
        domainMs={domainMs}
        windowSelected={windowSelected}
      />
      <Chart
        id="agent-bandwidth"
        title={SLOTS[8]!.title}
        data={bandwidth}
        kind="line"
        pairValue="y"
        xAxis={xAxis}
        yAxis={{ name: 'Mbps' }}
        unit="Mbps"
        group={RUN_TIME_GROUP}
      />
    </>
  );
}
