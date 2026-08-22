import type { TelemetryResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import type { TimeDomainMs } from './types';
import {
  toBandwidthChart,
  toConnectionEventsChart,
  toCpuChart,
  toMemoryChart,
  toSegmentEventsChart,
  toTcpStateChart,
} from './transforms/telemetry';

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
 * ═══ NO `uppercase` ON THE SECTION HEADING ═══
 * Playwright applies `text-transform` when computing an accessible name;
 * jsdom does not. A heading queried by name must not carry it.
 *
 * ═══ THE `run-time` GROUP IS THE WHOLE POINT ═══
 * Hovering any one of these six moves the pointer on the other five at the
 * same instant — the reason this tab exists rather than a link out to
 * Grafana. It works only because every point below came off the SAME
 * `host.points` array (`RunTelemetry` passes one host, not one payload per
 * chart), so all six share one axis with no re-derivation that could drift.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT — design §6, same as every other chart
 * component. `RunTelemetry` runs the one `telemetryQuery` and hands this
 * component whichever host is currently selected.
 */
export default function TelemetryCharts({
  host,
  domainMs,
}: {
  readonly host: TelemetryResponse['hosts'][number];
  /** The run page's shared time domain — see `ChartXAxis.min`. */
  readonly domainMs?: TimeDomainMs;
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
    // TWO COLUMNS FROM `2xl`, ONE BELOW IT — the same break `RunChartsTab`
    // uses and for the same reason: each figure holds a 288px plot plus a
    // legend beneath a header row, and two of those in a 1280px window
    // leaves too little room for a 60-plus-point time axis to label itself.
    <section aria-labelledby="load-generators-heading" className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
      {/* `sr-only`, not `aria-label`: see `RunChartsTab`'s own heading for the
          reasoning this repeats — an `aria-label` here is not a heading at
          all, and six `<h3>`s (one per chart, `Chart.tsx`) with nothing above
          them skips a level for anyone navigating by heading. */}
      <h2 id="load-generators-heading" className="sr-only">
        Load generators
      </h2>

      <Chart
        id="telemetry-cpu"
        title="CPU usage"
        data={cpu}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'CPU' }}
        unit="%"
      />
      <Chart
        id="telemetry-memory"
        title="Memory usage"
        data={memory}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'Memory' }}
        unit="MB"
      />
      <Chart
        id="telemetry-bandwidth"
        title="Bandwidth"
        data={bandwidth}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'Bytes/s' }}
        unit="B/s"
      />
      <Chart
        id="telemetry-connection-events"
        title="TCP connection events"
        data={connectionEvents}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'Events/s' }}
        unit="/s"
      />
      <Chart
        id="telemetry-segment-events"
        title="TCP segment events"
        data={segmentEvents}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'Segments/s' }}
        unit="/s"
      />
      <Chart
        id="telemetry-tcp-states"
        title="Connections by state"
        data={tcpStates}
        kind="line"
        group="run-time"
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{
          type: 'value',
          name: 'Elapsed (s)',
          tickUnit: 'ms-as-s',
          min: domainMs?.[0],
          max: domainMs?.[1],
        }}
        yAxis={{ name: 'Connections' }}
        unit="connections"
      />
    </section>
  );
}
