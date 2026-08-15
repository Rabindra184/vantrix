import type { StatsResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { OUTCOME_ROLES, toRequestCounts } from './transforms/indicators';

/**
 * §13.2 ④ — the OK-vs-KO request-count donut (Appendix A G-10).
 *
 * Shares `/stats`, and therefore its already-fetched payload, with
 * `IndicatorsChart`; see that file for why the data arrives as a prop rather
 * than being fetched here.
 *
 * The donut plots two slices and its table carries three rows — OK, KO, and the
 * total G-10 asks for, which has no slice of its own. `toRequestCounts`
 * documents that.
 */
export default function RequestCountChart({ stats }: { stats: StatsResponse }) {
  const data = useMemo(() => toRequestCounts(stats), [stats]);

  return (
    <Chart
      id="request-counts"
      title="Number of requests"
      data={data}
      kind="pie"
      // A donut has no axis to carry the unit, so the tooltip is the ONLY place
      // it can appear — "OK: 871" beside "KO: 24" is a count of nothing stated.
      unit="requests"
      // Per SLICE here, not per series — a single-series pie consumes ECharts'
      // top-level colour list one entry per data point. `Chart`'s `roles` doc
      // spells that difference out.
      roles={OUTCOME_ROLES}
    />
  );
}
