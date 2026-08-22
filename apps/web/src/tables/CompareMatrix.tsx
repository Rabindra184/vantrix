import { useId, useMemo } from 'react';
import SectionHeading from '../components/SectionHeading';
import { EmptyState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { CAPTION, ROW, TABLE, TD, TD_NUM, TH, THEAD, TH_NUM, TH_ROW } from '../components/tableStyles';
import { formatCell } from '../charts/DataTable';
import type { CompareMetric } from '../charts/transforms/compare';
import { toCompareMatrix, type CompareStats } from './buildCompareMatrix';

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
}: {
  readonly runs: readonly CompareStats[];
  readonly metric: CompareMetric;
  readonly metricLabel: string;
}) {
  const headingId = useId();
  const matrix = useMemo(() => toCompareMatrix(runs, metric), [runs, metric]);

  const caption = (
    <>
      {metricLabel} for every request, in each selected run. A dash means the
      request did not run in that one — not that it took no time.
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
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </section>
  );
}
