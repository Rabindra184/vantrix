import { Link } from 'react-router-dom';
import type { StatsResponse } from '@perfportal/contracts';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TD_NUM, TH, TH_NUM, THEAD } from '../components/tableStyles';
import { clampPercentile } from '../percentile';
import { formatCount, formatMs } from '../tables/StatisticsTable';
import { useWindowSuffix } from './useRunWindow';

export interface GroupRow {
  readonly name: string;
  readonly count: number;
  readonly okCount: number;
  readonly koCount: number;
  /** The p95 of the group's summed request time (`group_cumulated`). */
  readonly cumulatedP95: number | null;
  /** The p95 of the group's wall-clock span (`group_duration`). */
  readonly durationP95: number | null;
}

/**
 * One row per group, in the payload's own order. The engine files each group
 * twice — under `group_cumulated` and `group_duration`, the pair the PRD's
 * GR-01/GR-02 name — and this joins them by name. Counts come from the
 * cumulated row; both rows count the same executions.
 *
 * Each p95 is projected onto its own row's measured range, the rule
 * `clampPercentile` states: a percentile outside its own min and max is an
 * estimate that escaped, and the statistics table already shows the clamped one.
 */
export function groupRows(stats: StatsResponse): readonly GroupRow[] {
  const p95 = (family: 'group_cumulated' | 'group_duration', name: string): number | null => {
    const row = stats.stats.find((s) => s.scope === 'group' && s.family === family && s.name === name);
    const value = row?.percentiles.p95;
    return row === undefined || value === undefined ? null : clampPercentile(value, row);
  };
  return stats.stats
    .filter((s) => s.scope === 'group' && s.family === 'group_cumulated')
    .map((s) => ({
      name: s.name,
      count: s.count,
      okCount: s.okCount,
      koCount: s.koCount,
      cumulatedP95: p95('group_cumulated', s.name),
      durationP95: p95('group_duration', s.name),
    }));
}

/* The table's accessible name — never "statistics", "errors" or "request":
   Playwright matches names as a case-insensitive substring, and the e2e suite
   reaches three other tables by those words. The two-p95 explanation is the
   caveat a reader needs to read the columns, so it rides behind the frame's
   info (the clean-UI text rule) rather than on the page. */
const TABLE_NAME = 'Groups';
const TABLE_INFO = 'Each group shows the p95 of its summed time and of its wall-clock span.';

/**
 * The Report's Groups section — this product's own design, because GE's
 * populated Groups section could not be measured (neither run in the account
 * has a group). Each name links to its existing group page, which holds the
 * group's charts.
 */
export default function GroupsList({
  runId,
  stats,
  windowSelected,
}: {
  readonly runId: string;
  readonly stats: StatsResponse;
  /** Whether the reader has narrowed the analysis window. REQUIRED, no default:
   *  `/stats` is windowed, so under a window this list is only the groups with
   *  buckets in it, and the wrong answer is a sentence about the whole run that
   *  reads as evidence. */
  readonly windowSelected: boolean;
}) {
  /* The reader's window travels with the drill-down, as it does from the
     statistics table's rows: opening a group from a windowed Report must not
     silently return them to the whole run on the group page and, through its
     "Back to this run", the Report tab. `useWindowSuffix` owns which
     parameters travel. Above the early return — a hook after it would not run
     for an empty list. */
  const windowSuffix = useWindowSuffix();
  const rows = groupRows(stats);
  if (rows.length === 0) {
    // A SCOPED EMPTY RESULT IS NOT A WHOLE-RUN CONCLUSION — the rule
    // `ErrorsTable` follows (and `RunStats` did, until the Summary stopped being
    // windowable). A window that selects no group buckets leaves `rows` empty
    // for a run whose groups all ran elsewhere, and "This run has no groups."
    // would be false of it.
    return (
      <p className="text-[0.8125rem] text-muted">
        {windowSelected ? 'No groups ran in the selected window.' : 'This run has no groups.'}
      </p>
    );
  }
  const ms = (value: number | null) => (value === null ? '—' : `${formatMs(value)} ms`);
  return (
    <TableFrame name={TABLE_NAME} label="Groups table" info={TABLE_INFO}>
      <table className={TABLE}>
        <caption className="sr-only">{TABLE_NAME}</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>Group</th>
            {/* `TH_NUM` over every `TD_NUM` column below: a heading left-aligned
                over right-aligned figures is the pairing `tableStyles.ts` names. */}
            <th scope="col" className={TH_NUM}>Count</th>
            <th scope="col" className={TH_NUM}>OK</th>
            <th scope="col" className={TH_NUM}>KO</th>
            <th scope="col" className={TH_NUM}>p95 cumulated</th>
            <th scope="col" className={TH_NUM}>p95 duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} data-testid="group-row" className={ROW}>
              <td className={TD}>
                <Link
                  to={`/runs/${encodeURIComponent(runId)}/groups/${encodeURIComponent(row.name)}${windowSuffix}`}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {row.name}
                </Link>
              </td>
              <td className={TD_NUM}>{formatCount(row.count)}</td>
              <td className={TD_NUM}>{formatCount(row.okCount)}</td>
              <td className={TD_NUM}>{formatCount(row.koCount)}</td>
              <td className={TD_NUM}>{ms(row.cumulatedP95)}</td>
              <td className={TD_NUM}>{ms(row.durationP95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
