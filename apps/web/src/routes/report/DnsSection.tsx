import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDnsResponse } from '@perfportal/contracts';
import { agentDnsQuery } from '../../api/agent';
import AgentDurationCharts, {
  useDurationSettings,
  type DurationChart,
  type DurationSettings,
} from '../../charts/AgentDurationCharts';
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
  const [hostname, setHostname, namedHostname] = useReportFilter('hostname', summary?.hostnames, 'dns');
  const dns = useQuery(section.figureQuery(agentDnsQuery(runId, hostname, window)));
  // Above the gate, so a hostname or window change keeps the reader's rows and outcomes.
  const settings = useDurationSettings();

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
          {collected.hostnames.length === 0 && (
            // Not four silent charts: Gatling's warm-up lookup is left out
            // everywhere, and a run with nothing else is said so once.
            <p className="text-sm text-muted">No DNS lookup outside Gatling&apos;s warm-up was recorded.</p>
          )}
          <ReportFilterControl
            label="Hostname"
            allLabel="All hostnames"
            values={collected.hostnames}
            value={hostname}
            onChange={setHostname}
            named={namedHostname}
            verb="resolved"
          />
          <div className={REPORT_GRID}>
            <Payload query={dns} slots={SLOTS}>
              {(data) => (
                <DnsCharts
                  data={data}
                  domainMs={domainMs}
                  windowSelected={window !== null}
                  filter={hostname === '*' ? null : 'hostname'}
                  settings={settings}
                />
              )}
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
  filter,
  settings,
}: {
  readonly data: AgentDnsResponse;
  readonly domainMs: TimeDomainMs | undefined;
  readonly windowSelected: boolean;
  /** `'hostname'` when one hostname is chosen: an empty chart is then about it, not the run. */
  readonly filter: 'hostname' | null;
  readonly settings: DurationSettings;
}) {
  // Memoised: `Chart`'s option effect depends on `data` by identity.
  const rate = useMemo(() => toDnsRate(data, { windowSelected, filter }), [data, windowSelected, filter]);
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
        widthMs={data.bucketWidthMs}
        domainMs={domainMs}
        windowSelected={windowSelected}
        filter={filter}
        settings={settings}
        order={DNS_ORDER}
      />
    </>
  );
}
