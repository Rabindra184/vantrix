import type { StatRow, StatsResponse } from '@perfportal/contracts';
import StatTile from '../components/StatTile';
import { clampPercentile } from '../tables/StatisticsTable';

/**
 * §13.2's headline numbers, above the tables.
 *
 * EVERY VALUE COMES FROM THE RUN-SCOPE STATS ROW the page already fetched —
 * `statsQuery` is asked for twice on this page and served once from cache, so
 * this adds no request. Nothing here is derived from anywhere else: a tile that
 * disagreed with the statistics table directly beneath it would be worse than
 * no tile.
 *
 * The nine fields these six tiles read — `count`, `errorRate`, `okCount`,
 * `koCount`, `throughputRps`, `meanMs`, `maxMs`, `percentiles.p95`,
 * `percentiles.p99` — are exactly the run-scope row's own fields, read
 * straight off it as a headline value or a hint (some, like `count`, in more
 * than one tile's hint) and never recombined into a new quantity the row does
 * not already carry.
 *
 * `null`, not zeroed tiles, when the payload carries no run-scope row: a
 * statistics table with nothing to show already renders its own "no
 * statistics were recorded" message (`StatisticsTable`), and six tiles
 * reading 0/0.00%/— above that sentence would assert measurements nobody
 * took.
 */
export default function RunStats({ stats }: { readonly stats: StatsResponse }) {
  const run = stats.stats.find((row) => row.scope === 'run');
  if (run === undefined) return null;

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile
        label="Total Requests"
        value={run.count.toLocaleString()}
        hint={`${run.okCount.toLocaleString()} OK, ${run.koCount.toLocaleString()} KO`}
        testId="stat-total-requests"
      />
      <StatTile
        label="Error Rate"
        // The field and expression `StatisticsTable`'s `% KO` column uses
        // (`r.errorRate * 100`), at the same two-decimal precision — never
        // `koCount / count`, which would be a second definition of one
        // number sitting a few hundred pixels from the first.
        value={`${(run.errorRate * 100).toFixed(2)}%`}
        hint={`${run.koCount.toLocaleString()} of ${run.count.toLocaleString()} requests`}
        testId="stat-error-rate"
      />
      <StatTile
        label="Mean Throughput"
        value={`${formatRate(run.throughputRps)} req/s`}
        hint={`${run.count.toLocaleString()} requests over the run`}
        testId="stat-throughput"
      />
      <StatTile
        label="Mean Response"
        value={`${formatMs(run.meanMs)} ms`}
        hint={`up to ${formatMs(run.maxMs)} ms`}
        testId="stat-mean-response"
      />
      <StatTile
        label="95th Percentile"
        value={percentileValue(run, 'p95')}
        hint="an estimate, accurate to within 1%"
        testId="stat-p95"
      />
      <StatTile
        label="99th Percentile"
        value={percentileValue(run, 'p99')}
        hint="an estimate, accurate to within 1%"
        testId="stat-p99"
      />
    </dl>
  );
}

/** Whole milliseconds — the same rounding `StatisticsTable`'s own `formatMs`
 *  applies to every response-time cell, so a tile's number and the table's
 *  number for the same field never round differently. */
function formatMs(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : '—';
}

/** Two decimals — the same precision `StatisticsTable`'s `Cnt/s` column
 *  writes for `throughputRps`. */
function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

/**
 * A percentile tile's value, clamped exactly the way `StatisticsTable`'s own
 * percentile columns are: a percentile of a sample cannot lie outside that
 * sample's own minimum and maximum, and `clampPercentile` projects the raw
 * estimate onto the run row's own range (`clampPercentile`'s doc explains
 * why). Reusing it — rather than re-deriving the clamp here — is what keeps
 * the p99 tile from reading 2515 while the "All Requests" row directly below
 * it reads 2503, the exact disagreement this whole component exists to rule
 * out.
 *
 * `—`, never `0`, for a project configured with no such percentile: a gap in
 * `row.percentiles` is not a measurement of zero.
 */
function percentileValue(row: StatRow, key: string): string {
  const raw = row.percentiles[key];
  if (raw === undefined || !Number.isFinite(raw)) return '—';
  return `${formatMs(clampPercentile(raw, row))} ms`;
}
