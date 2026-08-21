import type { StatsResponse } from '@perfportal/contracts';
import type { CompareMetric } from '../charts/transforms/compare';
import type { CompareStats } from '../tables/buildCompareMatrix';

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

export function runMetricValue(stats: StatsResponse, metric: CompareMetric): number | null {
  const row = stats.stats.find((candidate) => candidate.scope === 'run');
  if (!row) return null;
  if (metric === 'throughput') return row.throughputRps;
  if (metric === 'errors') return row.throughputRps * row.errorRate;
  if (metric === 'max') return row.maxMs;

  const value = row.percentiles[metric];
  return value === undefined || !Number.isFinite(value) ? null : value;
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
