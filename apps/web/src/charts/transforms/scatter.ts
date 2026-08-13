import type { ScatterResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartTableRow } from '../types';

/**
 * §13.3 ⑨ — response time against global requests/s (Appendix A RQ-09).
 *
 * ONE POINT PER SECOND, NOT ONE PER REQUEST. x is the GLOBAL requests/s across
 * the whole run with both statuses combined; y is this request's truncated p95
 * within that bucket. §A.9 F-7 records the earlier misreading — a per-request
 * scatter — which the fixture alone could not falsify, because p75 through max
 * coincide on all seven request pages at ~3 requests/second.
 *
 * OK AND KO ARE INDEPENDENT STATUS FILTERS, not a decomposition of one series,
 * so they are never stacked and their points do not pair up by index.
 *
 * TWO POINTS DISAGREE WITH GATLING ON THE REFERENCE RUN AND THAT IS DELIBERATE
 * (deviation D-03): our bucketing floors an observation into its bucket where
 * Gatling rounds to nearest. Floor is scale-consistent, and nearest breaks the
 * lossless-coalescing invariant AC-STAT-2 depends on. Measured cost: `Add To
 * Cart` 48 points against Gatling's 47, `Place Order` 53 against 54; KO counts
 * exact on both.
 */
export const SCATTER_ROLES: readonly StatusRole[] = ['passed', 'failed'];

const SCATTER_COLUMNS = ['Series', 'Requests per second', 'p95 (ms)'] as const;

export function toScatter(s: ScatterResponse): ChartData {
  const rows: ChartTableRow[] = [
    ...s.ok.map(([x, y]): ChartTableRow => ({ label: 'OK', values: [x, y] })),
    ...s.ko.map(([x, y]): ChartTableRow => ({ label: 'KO', values: [x, y] })),
  ];

  if (rows.length === 0) {
    return {
      series: [],
      // No axis labels: x is a measured quantity, so the axis is numeric and
      // has no categories to name.
      axisLabels: [],
      columns: [...SCATTER_COLUMNS],
      rows: [],
      empty:
        'No response times were recorded for this request, so there is nothing to plot against ' +
        'the run’s throughput.',
    };
  }

  return {
    series: [
      { name: 'OK', data: s.ok },
      { name: 'KO', data: s.ko },
    ],
    axisLabels: [],
    columns: [...SCATTER_COLUMNS],
    rows,
  };
}
