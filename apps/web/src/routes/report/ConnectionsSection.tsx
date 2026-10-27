import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentConnectionsResponse } from '@perfportal/contracts';
import { agentConnectionsQuery } from '../../api/agent';
import AgentDurationCharts from '../../charts/AgentDurationCharts';
import Chart from '../../charts/Chart';
import { RUN_TIME_GROUP } from '../../charts/crosshair';
import type { TelemetryChartId } from '../../charts/TelemetryCharts';
import { toBandwidth, toConnectionRate, toTcpStates } from '../../charts/transforms/agentRates';
import type { TimeDomainMs } from '../../charts/types';
import { Payload, type Slot } from '../payload';
import RunTelemetry from '../RunTelemetry';
import AgentSectionGate, { REPORT_GRID, useAgentSection } from './AgentSectionGate';
import ReportFilterControl from './ReportFilterControl';
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

/**
 * The Report's Connections section, from the run's agent file — GE's nine
 * charts, filtered by remote (`?remote=`, `useReportFilter`).
 *
 * What it says before it can draw — withheld while the run streams, one
 * loading state until the summary answers, the load-generator telemetry for a
 * run with no agent file (spec §7.5), any other unavailable answer in its own
 * words, a phone's notice — is `AgentSectionGate`'s, shared with DNS and Load
 * generators. Connections come from the agent's HTTP collector, so it
 * `needsHttp`. The summary is read before the figures so that `?remote=` is
 * checked against `summary.remotes` before any request carries it.
 */
export default function ConnectionsSection({ runId }: { readonly runId: string }) {
  // EVERY HOOK RUNS ON EVERY RENDER, above the gate's early returns.
  const section = useAgentSection(runId, { needsHttp: true });
  const { summary, window, domainMs } = section;
  const [remote, setRemote] = useReportFilter('remote', summary?.remotes);
  const connections = useQuery({ ...agentConnectionsQuery(runId, remote, window), enabled: section.fetchFigures });

  return (
    <AgentSectionGate
      section={section}
      slots={SLOTS}
      what="Nine connection charts of this run"
      action={ACTION}
      subject={SUBJECT}
      noAgentFile={<RunTelemetry only={CONNECTION_CHARTS} action={ACTION} />}
      figures={connections.data}
    >
      {(collected) => {
        // The agent's own reason its machine collector was off, for the TCP states chart.
        const notMeasuredReason =
          collected.header?.collects.machine === false ? collected.header.reasons.machine : undefined;
        return (
          <div className="flex flex-col gap-4">
            <ReportFilterControl
              label="Remote"
              allLabel="All remotes"
              values={collected.remotes}
              value={remote}
              onChange={setRemote}
            />
            <div className={REPORT_GRID}>
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
      }}
    </AgentSectionGate>
  );
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
