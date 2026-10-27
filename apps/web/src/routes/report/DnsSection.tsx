import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDnsResponse } from '@perfportal/contracts';
import { agentDnsQuery } from '../../api/agent';
import AgentDurationCharts, { type DurationChart } from '../../charts/AgentDurationCharts';
import Chart from '../../charts/Chart';
import { RUN_TIME_GROUP } from '../../charts/crosshair';
import { DNS_RATE_ROLES, toDnsRate } from '../../charts/transforms/agentRates';
import type { TimeDomainMs } from '../../charts/types';
import { Payload, type Slot } from '../payload';
import AgentSectionGate, { useAgentSection } from './AgentSectionGate';
import { REPORT_GRID } from './grid';
import ReportFilterControl from './ReportFilterControl';
import useReportFilter from './useReportFilter';

const RESOLUTION = {
  overTime: 'DNS Resolution Duration Percentiles',
  distribution: 'DNS Resolution Duration Distribution',
  percentiles: 'DNS Resolution Duration Percentiles Distribution',
} as const;

/**
 * GE's DNS order (spec §2's DNS table): the distribution first, then the
 * percentile curve, then percentiles over time — where TCP connect and TLS
 * lead with percentiles over time, `AgentDurationCharts`' default.
 */
const DNS_ORDER: readonly DurationChart[] = ['distribution', 'percentiles', 'overTime'];

/** GE's four DNS charts, in GE's order, titled verbatim (spec §2). */
const SLOTS: readonly Slot[] = [
  { id: 'agent-dns-rate', title: 'DNS Resolution per Second' },
  { id: 'agent-dns-distribution', title: RESOLUTION.distribution },
  { id: 'agent-dns-percentiles-distribution', title: RESOLUTION.percentiles },
  { id: 'agent-dns-percentiles', title: RESOLUTION.overTime },
];

/**
 * The Report's DNS section — GE's DNS charts from the run's agent file,
 * filtered by hostname (`?hostname=`, `useReportFilter`). New with GE report
 * parity: nothing in this product drew DNS before.
 *
 * Its states before drawing are `AgentSectionGate`'s, with ONE difference from
 * Connections and Load generators: a run with no agent file has NO fallback.
 * The Go telemetry agent records no lookups, so there is nothing else to show,
 * and the gate's not-collected notice says the agent collects these figures
 * for the runs it starts. Lookups come from the agent's HTTP collector, so a
 * run whose collector was off says so (`needsHttp`, the API's own split).
 *
 * The hostname is checked against `summary.hostnames` before any request
 * carries it — the API refuses one the run never resolved with a 400
 * (`UNKNOWN_HOSTNAME`), so an unchecked stale link would draw an error.
 */
export default function DnsSection({ runId }: { readonly runId: string }) {
  // EVERY HOOK RUNS ON EVERY RENDER, above the gate's early returns.
  const section = useAgentSection(runId, { needsHttp: true });
  const { summary, window, domainMs } = section;
  const [hostname, setHostname] = useReportFilter('hostname', summary?.hostnames);
  const dns = useQuery(section.figureQuery(agentDnsQuery(runId, hostname, window)));

  return (
    <AgentSectionGate
      section={section}
      slots={SLOTS}
      what="Four DNS charts of this run"
      action="Open the DNS charts"
      subject="DNS resolution figures"
      figures={dns.data}
    >
      {(collected) => (
        <div className="flex flex-col gap-4">
          <ReportFilterControl
            label="Hostname"
            allLabel="All hostnames"
            values={collected.hostnames}
            value={hostname}
            onChange={setHostname}
          />
          <div className={REPORT_GRID}>
            <Payload query={dns} slots={SLOTS}>
              {(data) => <DnsCharts data={data} domainMs={domainMs} windowSelected={window !== null} />}
            </Payload>
          </div>
        </div>
      )}
    </AgentSectionGate>
  );
}

function DnsCharts({
  data,
  domainMs,
  windowSelected,
}: {
  readonly data: AgentDnsResponse;
  readonly domainMs: TimeDomainMs | undefined;
  readonly windowSelected: boolean;
}) {
  // Memoised: `Chart`'s option effect depends on `data` by identity.
  const rate = useMemo(() => toDnsRate(data, { windowSelected }), [data, windowSelected]);
  return (
    <>
      <Chart
        id="agent-dns-rate"
        title={SLOTS[0]!.title}
        data={rate}
        kind="line"
        // Requests, OK and KO: KO is a failed lookup, so the status colours mean what they say.
        roles={DNS_RATE_ROLES}
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{ type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1] }}
        yAxis={{ name: 'Lookups/s' }}
        unit="/s"
        group={RUN_TIME_GROUP}
      />
      <AgentDurationCharts
        idPrefix="agent-dns"
        titles={RESOLUTION}
        section={data.resolution}
        noun="DNS lookups"
        domainMs={domainMs}
        windowSelected={windowSelected}
        order={DNS_ORDER}
      />
    </>
  );
}
