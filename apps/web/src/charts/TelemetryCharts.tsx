import type { TelemetryResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { RUN_TIME_GROUP } from './crosshair';
import type { TimeDomainMs } from './types';
import {
  toBandwidthChart,
  toConnectionEventsChart,
  toCpuChart,
  toMemoryChart,
  toSegmentEventsChart,
  toTcpStateChart,
} from './transforms/telemetry';

/** The six charts this component can draw, by chart id — what `only` names. */
export type TelemetryChartId =
  | 'telemetry-cpu'
  | 'telemetry-memory'
  | 'telemetry-bandwidth'
  | 'telemetry-connection-events'
  | 'telemetry-segment-events'
  | 'telemetry-tcp-states';

/**
 * §7's six charts, for one load generator at a time — CPU, memory, bandwidth,
 * two TCP event rates and the connection-state histogram.
 *
 * ═══ NO ICON, NO DECORATIVE SVG IN ANY FIGURE ═══
 * `Chart` renders its data table INSIDE the `<figure>`, and the e2e suite
 * proves a chart really drew by counting SVG elements within it —
 * `toHaveCount(1)` per chart. An icon makes the count wrong AND destroys the
 * invariant it rests on.
 *
 * ═══ THE `run-time` GROUP IS THE WHOLE POINT ═══
 * Hovering any one of these moves the pointer on every other one drawn at the
 * same instant — the reason this is a page of charts rather than a link out to
 * Grafana — and the Report's two sections (`only`) share the one group, so
 * opening both keeps the crosshair across them. It works only because every
 * point below came off the SAME `host.points` array (`RunTelemetry` passes one
 * host, not one payload per chart), so they all share one axis with no
 * re-derivation that could drift.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT — design §6, same as every other chart
 * component. `RunTelemetry` runs the one `telemetryQuery` and hands this
 * component whichever host is currently selected.
 */
export default function TelemetryCharts({
  host,
  domainMs,
  only,
}: {
  readonly host: TelemetryResponse['hosts'][number];
  /** The run page's shared time domain — see `ChartXAxis.min`. */
  readonly domainMs?: TimeDomainMs;
  /**
   * Which of the six to draw. The Report splits them across two sections —
   * Connections holds bandwidth and connection states, Load generators the
   * rest — each mounting its own copy, so a chart is drawn in exactly one.
   * REQUIRED, with no default: a default of "all six" would let a third caller
   * draw every chart a second time under a heading that names only some.
   */
  readonly only: readonly TelemetryChartId[];
}) {
  // One `useMemo` per transform, not a loop over a table of them: `Chart`'s
  // option effect depends on `data` by identity, and this repo's other
  // multi-chart components (`UsersChart.tsx`, `RunDetail.tsx`'s chart tab)
  // all write the six-or-fewer calls out rather than reaching for a
  // dynamically-sized `.map`, which would call `useMemo` a variable number of
  // times if it were ever driven by anything other than a fixed literal.
  const cpu = useMemo(() => toCpuChart(host), [host]);
  const memory = useMemo(() => toMemoryChart(host), [host]);
  const bandwidth = useMemo(() => toBandwidthChart(host), [host]);
  const connectionEvents = useMemo(() => toConnectionEventsChart(host), [host]);
  const segmentEvents = useMemo(() => toSegmentEventsChart(host), [host]);
  const tcpStates = useMemo(() => toTcpStateChart(host), [host]);

  return (
    // TWO COLUMNS FROM `2xl`, ONE BELOW IT — the break every chart grid on the
    // run page uses, and for the same reason: each figure holds a 288px plot
    // plus a legend beneath a header row, and two of those in a 1280px window
    // leaves too little room for a 60-plus-point time axis to label itself.
    //
    // A `<div>`, not a `<section>` with a heading of its own: the Report's
    // section heading ("Connections", "Load generators") already names these
    // charts and is the `<h2>` their `<h3>` titles sit under, so a second one
    // here would say it twice.
    <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
      {only.includes('telemetry-cpu') && (
        <Chart
          id="telemetry-cpu"
          title="CPU usage"
          data={cpu}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'CPU' }}
          unit="%"
        />
      )}
      {only.includes('telemetry-memory') && (
        <Chart
          id="telemetry-memory"
          title="Memory usage"
          data={memory}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'Memory' }}
          unit="MB"
        />
      )}
      {only.includes('telemetry-bandwidth') && (
        <Chart
          id="telemetry-bandwidth"
          title="Bandwidth"
          data={bandwidth}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'Bytes/s' }}
          unit="B/s"
        />
      )}
      {only.includes('telemetry-connection-events') && (
        <Chart
          id="telemetry-connection-events"
          title="TCP connection events"
          data={connectionEvents}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'Events/s' }}
          unit="/s"
        />
      )}
      {only.includes('telemetry-segment-events') && (
        <Chart
          id="telemetry-segment-events"
          title="TCP segment events"
          data={segmentEvents}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'Segments/s' }}
          unit="/s"
        />
      )}
      {only.includes('telemetry-tcp-states') && (
        <Chart
          id="telemetry-tcp-states"
          title="Connections by state"
          data={tcpStates}
          kind="line"
          group={RUN_TIME_GROUP}
          // Its x is an INSTANT, not a measurement — the tooltip title names it.
          pairValue="y"
          xAxis={{
            type: 'value',
            tickUnit: 'ms-as-s',
            min: domainMs?.[0],
            max: domainMs?.[1],
          }}
          yAxis={{ name: 'Connections' }}
          unit="connections"
        />
      )}
    </div>
  );
}
