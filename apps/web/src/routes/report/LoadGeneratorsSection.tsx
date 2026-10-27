import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentInjectorsResponse } from '@perfportal/contracts';
import { agentInjectorsQuery } from '../../api/agent';
import Chart from '../../charts/Chart';
import { RUN_TIME_GROUP } from '../../charts/crosshair';
import type { TelemetryChartId } from '../../charts/TelemetryCharts';
import {
  toCpu,
  toGcCounts,
  toGcTime,
  toMemory,
  toTcpEvents,
  toTcpSegments,
} from '../../charts/transforms/agentInjectors';
import type { TimeDomainMs } from '../../charts/types';
import { Payload, type Slot } from '../payload';
import RunTelemetry from '../RunTelemetry';
import AgentSectionGate, { useAgentSection } from './AgentSectionGate';
import { REPORT_GRID } from './grid';
import { ReadOnlyField } from './ReportFilterControl';

/* The load-generator telemetry this section falls back to for a run with no
   agent file: every telemetry chart but Connections' two (`CONNECTION_CHARTS`,
   defined beside that section). One definition — the Report imports it. */
export const LOAD_GENERATOR_CHARTS: readonly TelemetryChartId[] = [
  'telemetry-cpu',
  'telemetry-memory',
  'telemetry-connection-events',
  'telemetry-segment-events',
];

const ACTION = 'Open the load-generator charts';

/** GE's six Load Generators charts, in GE's order, titled verbatim (spec §2). */
const SLOTS = [
  { id: 'agent-gc-count', title: 'GC Counts per Second' },
  { id: 'agent-gc-time', title: 'GC Time per Second' },
  { id: 'agent-cpu', title: 'CPU usage in percent' },
  { id: 'agent-memory', title: 'Memory Usage in MB' },
  { id: 'agent-tcp-events', title: 'TCP Connections Events per Second' },
  { id: 'agent-tcp-segments', title: 'TCP Segment Events per Second' },
] as const satisfies readonly Slot[];

/**
 * The Report's Load generators section — GE's GC, CPU, memory and kernel TCP
 * charts for the load generator, from the run's agent file.
 *
 * Its states before drawing are `AgentSectionGate`'s. A run with no agent file
 * keeps the load-generator telemetry, which may still exist (spec §7.5). It
 * does NOT need the HTTP collector — the JVM and machine figures are their own
 * collectors, and the API answers this read whatever the HTTP collector did
 * (`unavailable(summary, false)`) — so a run whose HTTP collector was off still
 * draws here, while Connections and DNS say why they cannot.
 *
 * THE LOAD GENERATOR IS NAMED, NEVER CHOSEN. GE offers a picker over a run's
 * generators; an agent file is one JVM's, so a run has exactly one, and a
 * one-option select is a control that does nothing. It is a read-only field
 * (`ReadOnlyField`, the same shape a single remote or hostname takes). When the
 * run came from PerfPortal's own on-prem runner, that machine IS the PerfPortal
 * VM, so one sentence beside it says its CPU, RAM and kernel TCP figures
 * include the database's, the API's and the worker's — not its heap or GC,
 * which are the load generator's own JVM.
 *
 * A machine collector that was off costs CPU and both kernel TCP charts their
 * lines, each saying the agent's own reason; GC and memory still draw, memory
 * naming RAM as not read. That is the transforms' (`agentInjectors.ts`), read
 * from the injectors response's own `machine`, so nothing here decides it.
 */
export default function LoadGeneratorsSection({ runId }: { readonly runId: string }) {
  // EVERY HOOK RUNS ON EVERY RENDER, above the gate's early returns.
  const section = useAgentSection(runId, { needsHttp: false });
  const { window, domainMs } = section;
  const injectors = useQuery(section.figureQuery(agentInjectorsQuery(runId, window)));

  return (
    <AgentSectionGate
      section={section}
      slots={SLOTS}
      what="Six load-generator charts of this run"
      action={ACTION}
      subject="load-generator figures"
      noAgentFile={<RunTelemetry only={LOAD_GENERATOR_CHARTS} action={ACTION} />}
      figures={injectors.data}
    >
      {(collected) => (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <ReadOnlyField label="Load generator">{collected.injector.host ?? 'Unknown host'}</ReadOnlyField>
            {collected.injector.sharedWithPerfPortal && (
              <p className="text-[0.75rem] text-muted">
                This machine was shared with PerfPortal&apos;s database, API and worker, so its CPU, RAM and
                kernel TCP figures include theirs.
              </p>
            )}
          </div>
          <div className={REPORT_GRID}>
            <Payload query={injectors} slots={SLOTS}>
              {(data) => <LoadGeneratorCharts data={data} domainMs={domainMs} windowSelected={window !== null} />}
            </Payload>
          </div>
        </div>
      )}
    </AgentSectionGate>
  );
}

function LoadGeneratorCharts({
  data,
  domainMs,
  windowSelected,
}: {
  readonly data: AgentInjectorsResponse;
  readonly domainMs: TimeDomainMs | undefined;
  readonly windowSelected: boolean;
}) {
  // Memoised: `Chart`'s option effect depends on `data` by identity.
  const charts = useMemo(() => {
    const opts = { windowSelected };
    return {
      gcCount: toGcCounts(data, opts),
      gcTime: toGcTime(data, opts),
      cpu: toCpu(data, opts),
      memory: toMemory(data, opts),
      tcpEvents: toTcpEvents(data, opts),
      tcpSegments: toTcpSegments(data, opts),
    };
  }, [data, windowSelected]);
  // Every time chart: a value axis in ms, labelled as clock time, on the shell's domain.
  const xAxis = { type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1] } as const;
  // Each x is an INSTANT, not a measurement — the tooltip title names it.
  const time = { kind: 'line', pairValue: 'y', xAxis, group: RUN_TIME_GROUP } as const;

  return (
    <>
      <Chart {...time} id={SLOTS[0].id} title={SLOTS[0].title} data={charts.gcCount} yAxis={{ name: 'Collections/s' }} unit="/s" />
      <Chart {...time} id={SLOTS[1].id} title={SLOTS[1].title} data={charts.gcTime} yAxis={{ name: 'GC time (ms/s)' }} unit="ms/s" />
      {/* CPU and memory are gauges, drawn as stored. */}
      <Chart {...time} id={SLOTS[2].id} title={SLOTS[2].title} data={charts.cpu} yAxis={{ name: 'CPU (%)' }} unit="%" />
      <Chart {...time} id={SLOTS[3].id} title={SLOTS[3].title} data={charts.memory} yAxis={{ name: 'Memory (MB)' }} unit="MB" />
      {/* No `unit`: `established` is a gauge beside four per-second counters, and
          a "/s" on its tooltip would say what the chart's own note denies. */}
      <Chart {...time} id={SLOTS[4].id} title={SLOTS[4].title} data={charts.tcpEvents} yAxis={{ name: 'Events/s' }} />
      <Chart {...time} id={SLOTS[5].id} title={SLOTS[5].title} data={charts.tcpSegments} yAxis={{ name: 'Segments/s' }} unit="/s" />
    </>
  );
}
