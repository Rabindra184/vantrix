import { useQuery } from '@tanstack/react-query';
import { fetchRecomputeProgress, recomputeProgressQueryKey } from '../api/admin';
import { formatCount } from '../tables/StatisticsTable';

/** How often the line re-reads the progress while runs remain. */
const POLL_MS = 10_000;

/**
 * One line under Administration's tabs while the exact-statistics backfill is
 * still working through this org's runs: "Recomputing exact statistics: 412 of
 * 1030 runs", and how many it gave up on, if any.
 *
 * ═══ NOTHING AT ALL WHEN THERE IS NOTHING TO SAY ═══
 *
 * The `role="status"` region exists only while runs remain. Mounted always, it
 * would be an empty live region on every Administration page for good once the
 * backfill finishes — the lesson `ChartActions` and `ProjectRail` record. And a
 * read that fails renders nothing either: this is a progress note, and turning
 * it into an alert would put an error on every admin page whenever the
 * progress endpoint hiccups, over pages that work.
 *
 * It polls only while there is progress to report, and stops on its own once
 * `remaining` reaches zero — the count-driven poll `Home`'s activity uses.
 *
 * Counts are written the way every count in this app is (`formatCount`: plain,
 * no locale grouping), so what a reader sees does not depend on where it ran.
 */
export function RecomputeProgress() {
  const progress = useQuery({
    queryKey: recomputeProgressQueryKey,
    queryFn: fetchRecomputeProgress,
    refetchInterval: (query) => ((query.state.data?.remaining ?? 0) > 0 ? POLL_MS : false),
  });
  const data = progress.data;
  if (progress.isError || data === undefined || data.remaining <= 0) return null;
  const done = data.total - data.remaining;
  return (
    <p role="status" data-testid="recompute-progress" className="text-[0.8125rem] text-muted">
      Recomputing exact statistics: {formatCount(done)} of {formatCount(data.total)} runs
      {data.failed > 0 && ` · ${formatCount(data.failed)} could not be recomputed`}
    </p>
  );
}
