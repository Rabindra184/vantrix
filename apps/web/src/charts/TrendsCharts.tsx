import type { TrendsResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import type { MarkRole } from './theme';
import {
  toPercentileTrend,
  toStatusTrend,
  toThroughputTrend,
} from './transforms/trends';

/**
 * The three trend figures.
 *
 * ═══ NONE OF THEM JOINS A CROSSHAIR GROUP ═══
 *
 * Every other time-axis chart in this app shares `run-time`, so hovering
 * requests/s moves the pointer on concurrent users. These share an axis of
 * RUNS. Joining `run-time` would link them to charts whose x is elapsed
 * seconds within a single run — a pointer at "second 12" driven to "run 12",
 * and an invitation to read the two as aligned when they measure different
 * things entirely.
 *
 * They are not connected to EACH OTHER either. ECharts' `connect` aligns by
 * axis VALUE, and all three do share a run axis, so a group would technically
 * work — but a group is also a shared zoom and a shared tooltip trigger, and
 * three stacked charts of at most twenty categories are read by looking, not
 * by pointing. It would be linkage for its own sake.
 */

/** OK and KO mean succeeded and did not, so they take the status palette. */
const OUTCOME_ROLES: readonly MarkRole[] = ['passed', 'failed'];

export default function TrendsCharts({ trends }: { readonly trends: TrendsResponse }) {
  const status = useMemo(() => toStatusTrend(trends), [trends]);
  const percentiles = useMemo(() => toPercentileTrend(trends), [trends]);
  const throughput = useMemo(() => toThroughputTrend(trends), [trends]);

  return (
    <>
      <Chart
        id="trend-status"
        title="Response status across runs"
        data={status}
        kind="bar"
        stacked
        roles={OUTCOME_ROLES}
        unit="%"
        yAxis={{ name: '% of requests' }}
        xAxis={{ name: 'Run' }}
      />

      <Chart
        id="trend-percentiles"
        title="Response time percentiles across runs"
        data={percentiles}
        kind="line"
        unit="ms"
        yAxis={{ name: 'Response time (ms)' }}
        xAxis={{ name: 'Run' }}
      />

      <Chart
        id="trend-throughput"
        title="Throughput across runs"
        data={throughput}
        kind="bar"
        stacked
        roles={OUTCOME_ROLES}
        unit="/s"
        yAxis={{ name: 'Requests per second' }}
        xAxis={{ name: 'Run' }}
      />
    </>
  );
}
