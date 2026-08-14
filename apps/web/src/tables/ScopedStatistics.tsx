import type { StatRow } from '@perfportal/contracts';
import { useId, useMemo } from 'react';
import { columnsFor, type Column } from './StatisticsTable';

/**
 * §13.3 ① — renders §A.5's full column set for one row at any scope (RQ-01).
 *
 * ONE ROW, SAME COLUMNS. The columns come from `columnsFor` rather than from a
 * list here, so the percentile columns are the ones the payload carries and
 * this page cannot drift from the run's own table.
 *
 * `rows` is the WHOLE payload's rows, not just this one: the percentile column
 * set is a property of the run, and deriving it from a single row would hide a
 * column that row happens to have no value for.
 *
 * The group page calls this once per metric family.
 */
export default function ScopedStatistics({
  row,
  rows,
}: {
  readonly row: StatRow;
  readonly rows: readonly StatRow[];
}) {
  const headingId = useId();
  const { executions, responseTime } = useMemo(() => columnsFor(rows), [rows]);
  const columns: readonly Column[] = [...executions, ...responseTime];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-xl font-semibold">
        Statistics
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.column} scope="col" title={c.hint} className="text-left font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {columns.map((c) => {
                const value = c.value(row);
                return (
                  <td
                    key={c.column}
                    data-column={c.column}
                    data-testid={`request-stat-${c.column}`}
                    // The UNROUNDED value, beside the rounded display — so
                    // rounding stays a display decision and every cell is
                    // assertable against the payload.
                    data-value={value === undefined ? undefined : String(value)}
                  >
                    {/* undefined is not zero: this row HAS no value here. */}
                    {value === undefined ? '—' : c.format(value)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
