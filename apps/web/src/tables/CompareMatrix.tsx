import { useId, useMemo } from 'react';
import SectionHeading from '../components/SectionHeading';
import { EmptyState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { CAPTION, ROW, TABLE, TD, TD_NUM, TH, THEAD, TH_NUM, TH_ROW } from '../components/tableStyles';
import { formatCell } from '../charts/DataTable';
import type { CompareMetric } from '../charts/transforms/compare';
import { toCompareMatrix, type CompareChangeRow, type CompareStats } from './buildCompareMatrix';

/**
 * Requests down, runs across.
 *
 * The figure above answers "did this get slower". This answers "what got
 * slower", which is the question that leads somewhere.
 */
export default function CompareMatrix({
  runs,
  metric,
  metricLabel,
  currentRunId,
}: {
  readonly runs: readonly CompareStats[];
  readonly metric: CompareMetric;
  readonly metricLabel: string;
  /** The run being read — the subject of the Change column. See
   *  `toCompareMatrix`, which refuses to infer it from column order. */
  readonly currentRunId: string;
}) {
  const headingId = useId();
  const matrix = useMemo(
    () => toCompareMatrix(runs, metric, currentRunId),
    [runs, metric, currentRunId],
  );

  const caption = (
    <>
      {metricLabel} for every request, in each selected run. A dash means the
      request did not run in that one — not that it took no time.
      {matrix.change !== null && (
        <>
          {' '}
          Change is {matrix.change.subjectLabel} against {matrix.change.referenceLabel}, the same
          pair the summary above compares.
        </>
      )}
    </>
  );

  if (matrix.requests.length === 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <SectionHeading id={headingId}>By request</SectionHeading>
        {/* No headings over nothing: an empty grid reads as "these runs were
            compared and found to share no requests", which is a measurement
            nobody took. */}
        <EmptyState title="No request-level statistics for the selected runs" />
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>By request</SectionHeading>

      <TableFrame caption={caption} label="Per-request comparison">
        <table className={TABLE}>
          {/* The same node again, `sr-only`, as the table's own accessible
              name — `TableFrame`'s contract, and what keeps the visible copy
              from scrolling sideways with the columns. */}
          <caption className={`${CAPTION} sr-only`}>{caption}</caption>

          <thead className={THEAD}>
            <tr>
              {/* This comment used to say "NOT `uppercase`", on the grounds
                  that Playwright applies `text-transform` when it computes an
                  accessible name. That was re-measured on Playwright 1.62.1
                  and does not reproduce — `text-transform` is a RENDERING
                  property and `th.textContent` is unchanged, so the computed
                  name is too. `TH` has carried `uppercase` since the redesign
                  and the e2e suite passes 94/94 with it. See CLAUDE.md and
                  `tableStyles.ts` for the measurement, and for what genuinely
                  is still unsafe: uppercasing the DATA or an `aria-label`. */}
              <th scope="col" className={TH}>
                Request
              </th>
              {matrix.labels.map((label) => (
                // Was `${TH} text-right` written out here — the same thing
                // `TH_NUM` now names for every table, so a new one gets the
                // alignment by reaching for the right constant.
                <th key={label} scope="col" className={TH_NUM}>
                  {label}
                </th>
              ))}
              {/* LAST, after the values it is derived from: a reader scans the
                  numbers and then the conclusion, and a change column between
                  two run columns would read as belonging to one of them. */}
              {matrix.change !== null && (
                <th scope="col" className={TH_NUM}>
                  Change
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {matrix.requests.map((name, row) => (
              <tr key={name} className={ROW}>
                <th scope="row" className={`${TH_ROW} ${TD}`}>
                  {name}
                </th>
                {matrix.cells[row]!.map((value, column) => (
                  <td key={matrix.labels[column]} className={TD_NUM}>
                    {/* `formatCell`, the same function the data tables and the
                        tooltip use, so no surface in this app rounds a number
                        differently from another. A dash for absence — never a
                        zero, which would sort as the fastest cell here. */}
                    {value === null ? '—' : formatCell(value)}
                  </td>
                ))}
                {matrix.change !== null && (
                  <td className={TD_NUM}>
                    <ChangeCell row={matrix.change.rows[row] ?? null} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </section>
  );
}

/**
 * One request's change, in the metric's own unit and as a percentage.
 *
 * ═══ BOTH NUMBERS, BECAUSE EACH ONE ALONE MISLEADS ═══
 *
 * A percentage alone cannot tell a reader whether 40% is four milliseconds or
 * four seconds, and on a fast request it turns noise into a headline. An
 * absolute alone hides that +60 ms doubled a 60 ms request while barely moving
 * a 3 s one. The review's own example is the pair at its starkest: 146.95
 * against 2515.46 is both +2368.51 ms and +1612%.
 *
 * ═══ A ZERO BASELINE STILL HAS A CHANGE ═══
 *
 * `percent` is null when the reference is zero, and the absolute is shown on
 * its own rather than the row being dropped or dashed. Errors rising from 0 to
 * 2/s is the regression an engineer most needs to see, and it is exactly the
 * row a percentage cannot describe — the same reasoning `compareSummary`'s
 * `deltaUnavailable` carries for the tiles above.
 *
 * ═══ THE TONE IS A TOKEN, NOT A UTILITY ═══
 *
 * `text-status-*` emits no CSS: the status colours are declared on `:root`
 * rather than inside `@theme inline`, which CLAUDE.md records as silent. The
 * sign is also spelled out, so the judgement never rests on colour alone.
 */
function ChangeCell({ row }: { readonly row: CompareChangeRow | null }) {
  // A dash for "no change to state" — one of the two runs never made this
  // request — which is the same absence the value cells refuse to call zero.
  if (row === null) return <>—</>;

  const sign = row.absolute > 0 ? '+' : '';
  return (
    <span
      data-testid="compare-change"
      style={{ color: `var(--color-status-${row.good ? 'passed' : 'failed'})` }}
    >
      {sign}
      {formatCell(row.absolute)}
      {row.percent !== null && (
        <span className="ml-1 text-[0.6875rem] text-muted">
          ({sign}
          {row.percent.toFixed(1)}%)
        </span>
      )}
    </span>
  );
}
