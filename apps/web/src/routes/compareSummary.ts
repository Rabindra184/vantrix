import type { StatsResponse } from '@perfportal/contracts';
import type { CompareMetric } from '../charts/transforms/compare';
import { metricValue, type CompareStats } from '../tables/buildCompareMatrix';

export interface CompareSummaryModel {
  readonly selectedCount: number;
  readonly currentLabel: string;
  readonly baselineLabel: string | null;
  readonly currentValue: number | null;
  readonly baselineValue: number | null;
  readonly deltaPercent: number | null;
  readonly deltaGood: boolean | null;
  readonly bestLabel: string | null;
  readonly bestValue: number | null;
}

/**
 * The run-scope row's value for one metric.
 *
 * THE PER-METRIC MEANING IS `metricValue`'s, NOT A SECOND COPY OF IT. This
 * function used to restate all four branches — including
 * `throughputRps * errorRate` for "Errors" — beside the matrix that already
 * declares them, which is exactly the divergence `buildCompareMatrix`'s own
 * docstring argues against: the same word above the overlay, the matrix and
 * these tiles has to mean the same number in all three. All that is left
 * here is WHICH ROW to read.
 */
export function runMetricValue(stats: StatsResponse, metric: CompareMetric): number | null {
  const row = stats.stats.find((candidate) => candidate.scope === 'run');
  return row === undefined ? null : metricValue(row, metric);
}

export function buildCompareSummary(
  runs: readonly CompareStats[],
  currentRunId: string,
  metric: CompareMetric,
): CompareSummaryModel {
  const values = runs.map((run) => ({ ...run, value: runMetricValue(run.stats, metric) }));
  const current = values.find((run) => run.id === currentRunId) ?? values[0] ?? null;
  const baseline = values.find((run) => run.id !== current?.id) ?? null;
  const comparable = values.filter((run): run is typeof run & { value: number } => run.value !== null);
  const best = comparable.sort((a, b) => betterScore(a.value, b.value, metric))[0] ?? null;
  const currentValue = current?.value ?? null;
  const baselineValue = baseline?.value ?? null;
  const deltaPercent =
    currentValue === null || baselineValue === null || baselineValue === 0
      ? null
      : ((currentValue - baselineValue) / baselineValue) * 100;

  return {
    selectedCount: runs.length,
    currentLabel: current?.label ?? 'Current run',
    baselineLabel: baseline?.label ?? null,
    currentValue,
    baselineValue,
    deltaPercent,
    deltaGood: deltaPercent === null ? null : isDeltaGood(deltaPercent, metric),
    bestLabel: best?.label ?? null,
    bestValue: best?.value ?? null,
  };
}

function betterScore(a: number, b: number, metric: CompareMetric): number {
  if (metric === 'throughput') return b - a;
  return a - b;
}

function isDeltaGood(deltaPercent: number, metric: CompareMetric): boolean {
  if (metric === 'throughput') return deltaPercent >= 0;
  return deltaPercent <= 0;
}
