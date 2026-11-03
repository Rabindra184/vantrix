import { useId } from 'react';
import { Approx } from '../components/Approx';
import InfoTip from '../components/InfoTip';
import SectionHeading from '../components/SectionHeading';
import { EmptyState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ChangeDownIcon, ChangeUpIcon, PinIcon } from '../components/icons';
import { ROW, TABLE, TD, TD_NUM, TH, THEAD, TH_NUM, TH_ROW } from '../components/tableStyles';
import { formatCell } from '../charts/DataTable';
import { COMPARE_METRICS, compareUnit, type CompareMetric } from '../charts/transforms/compare';
import { cn } from '../lib/cn';
import {
  SUMMARY_LABELS,
  type CompareCell,
  type CompareMatrix as CompareMatrixModel,
} from './buildCompareMatrix';

/**
 * The comparison table: the metric's summary rows, then requests down, and
 * runs across with the REFERENCE first.
 *
 * The figure above answers "did this get slower". This answers "what got
 * slower, and by how much against the run I chose to measure from", which is
 * the question that leads somewhere.
 *
 * Built by the caller (`toCompareMatrix`), not here, so the summary tiles
 * above can read the same matrix and the two cannot disagree.
 */
export default function CompareMatrix({
  matrix,
  metric,
  onReference,
}: {
  readonly matrix: CompareMatrixModel;
  readonly metric: CompareMetric;
  /** Make a run the reference. Wired to the URL by the page. */
  readonly onReference: (id: string) => void;
}) {
  const headingId = useId();
  const labelIds = useId();

  const metricLabel = COMPARE_METRICS.find((m) => m.value === metric)?.label ?? metric;

  /* ═══ THE UNIT RIDES WITH THE COLUMN (review.md copy row 7) ═══
   *
   * A cell's announced context is its column header, so a screen-reader user
   * hears "09-13 11:31 (ms), 146.95" per cell instead of holding a sentence
   * from above the table. `compareUnit` owns the decision, as it does for the
   * axis and the tooltip.
   *
   * EXCEPT FOR ERRORS, whose unit for the OVERLAY is "/s" (KO per second) and
   * whose TABLE rows are a count and a ratio. "(/s)" over `Count` would be a
   * false label on every cell beneath it, so the errors headers carry no unit:
   * the count is a plain count, and the ratio prints its own "%". */
  const unit = metric === 'errors' ? null : compareUnit(metric);

  /* THE ACCESSIBLE NAME, AND IT IS SHORT ON PURPOSE (review 09-13 C06): the
   * dash definition lives behind the heading's info, never in the name. Its
   * words share nothing distinctive with any other table's name in the app
   * (Statistics, Errors, Tests, Members…), because Playwright matches a
   * table's name as a substring. */
  const name = `${metricLabel} compared across the selected runs`;

  const reference = matrix.columns.find((column) => column.reference) ?? null;
  const hasRequests = matrix.rows.some((row) => row.kind === 'request');

  const info = (
    <>
      A dash means that run has no value for the row — a request it did not make, or a figure it did
      not record — not that it took no time.
      {reference !== null && (
        <>
          {' '}
          Each change is against the reference, {reference.label}. Pin another run to measure from it
          instead.
        </>
      )}
    </>
  );

  const heading = hasRequests ? 'By request' : 'By run';

  if (matrix.columns.length === 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <SectionHeading id={headingId}>{heading}</SectionHeading>
        {/* No headings over nothing: an empty grid reads as "these runs were
            compared and found to share nothing", which is a measurement
            nobody took. */}
        <EmptyState title="No statistics for the selected runs" />
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} info={<InfoTip label={`About ${heading}`}>{info}</InfoTip>}>
        {heading}
      </SectionHeading>

      <TableFrame name={name} label="Comparison by run">
        <table className={TABLE}>
          <caption className="sr-only">{name}</caption>

          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>
                {hasRequests ? 'Request' : 'Figure'}
              </th>
              {matrix.columns.map((column, index) => {
                const labelId = `${labelIds}-label-${index}`;
                const tagId = `${labelIds}-tag-${index}`;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    data-testid="compare-column"
                    data-reference={column.reference ? 'true' : undefined}
                    /* THE HEADER'S NAME IS ITS LABEL (and, on the reference,
                       the word Reference) — never the pin button's name. A
                       `<th>` left to compute its name from its contents
                       concatenates a descendant's `aria-label` in Chromium,
                       so every cell below would be announced as
                       "b (ms) Set b as reference, 146.95". The same fix
                       `StatisticsTable`'s `SortableHeader` documents. */
                    aria-labelledby={column.reference ? `${labelId} ${tagId}` : labelId}
                    className={cn(TH_NUM, column.reference && 'bg-accent/10 text-accent')}
                  >
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <span id={labelId}>
                        {/* ≈ when THIS run's figures were estimated, so every
                            value in its column is announced with the mark. */}
                        <Approx exact={column.exact}>
                          {column.label}
                          {unit === null ? '' : ` (${unit})`}
                        </Approx>
                      </span>
                      {column.reference ? (
                        <span
                          id={tagId}
                          data-testid="compare-reference"
                          className="rounded bg-accent/10 px-1.5 py-0.5 normal-case tracking-normal"
                        >
                          Reference
                        </span>
                      ) : (
                        <button
                          type="button"
                          /* Named after its run: one pin per column means
                             several in one header row, and identical names
                             are the duplicate-name defect this repo has paid
                             for before. */
                          aria-label={`Set ${column.label} as reference`}
                          title={`Set ${column.label} as reference`}
                          onClick={() => onReference(column.id)}
                          className="transition-ui inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-primary"
                        >
                          <PinIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {matrix.rows.map((row) => {
              const ratio = metric === 'errors' && row.kind === 'summary' && row.label === SUMMARY_LABELS.ratio;
              return (
                <tr key={`${row.kind}:${row.label}`} className={ROW}>
                  <th
                    scope="row"
                    className={cn(TH_ROW, TD, row.kind === 'summary' && 'font-semibold')}
                  >
                    {row.label}
                  </th>
                  {row.cells.map((cell, column) => {
                    const col = matrix.columns[column]!;
                    return (
                      <td
                        key={col.id}
                        className={cn(TD_NUM, col.reference && 'bg-accent/5')}
                      >
                        <Cell
                          cell={cell}
                          ratio={ratio}
                          changeExact={col.exact && (reference?.exact ?? true)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableFrame>
    </section>
  );
}

/** A fraction as a percentage, at the precision the run totals use. */
const asPercent = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

/**
 * One value and, beside it, its change against the reference.
 *
 * `formatCell` for the value — the function the data tables and the tooltip
 * use, so no surface rounds a number differently — and a dash for absence,
 * never a zero, which would sort as the fastest cell here.
 */
function Cell({
  cell,
  ratio,
  changeExact,
}: {
  readonly cell: CompareCell | null;
  readonly ratio: boolean;
  /** Whether both this column's and the reference's figures are exact: a
   *  difference is no more exact than its least exact term. */
  readonly changeExact: boolean;
}) {
  if (cell === null) return <>—</>;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span>{ratio ? asPercent(cell.value) : formatCell(cell.value)}</span>
      {cell.change !== null && (
        <ChangeChip change={cell.change} ratio={ratio} exact={changeExact} />
      )}
    </span>
  );
}

/**
 * `+7.7%` / `−7.7%` / `=`, with Gatling Enterprise's arrow (north-east up,
 * south-east down), coloured by whether the change is an improvement.
 *
 * ═══ THE PERCENTAGE, OR THE ABSOLUTE WHERE THERE IS NONE ═══
 *
 * A reference of ZERO has no percentage — errors rising from 0 to 2 is the
 * regression an engineer most needs to see — so the chip states the absolute
 * change instead, in the row's own unit (percentage POINTS for the ratio row,
 * so it cannot be misread as a relative change).
 *
 * ═══ THE TONE IS A TOKEN, NOT A UTILITY, AND NEVER THE ONLY SIGNAL ═══
 *
 * `text-status-*` emits no CSS (the status colours live on `:root`, outside
 * `@theme`), so the colour is an inline `var()`. The sign is spelled out and a
 * visually hidden word says better or worse, so the judgement never rests on
 * colour alone. A change with no direction — users, CPU, or no change at all —
 * is muted: colouring it would be a judgement nobody configured.
 */
function ChangeChip({
  change,
  ratio,
  exact,
}: {
  readonly change: NonNullable<CompareCell['change']>;
  readonly ratio: boolean;
  readonly exact: boolean;
}) {
  const { absolute, percent, good } = change;
  const sign = absolute > 0 ? '+' : absolute < 0 ? '−' : '';
  const magnitude = Math.abs(absolute);
  const text =
    absolute === 0
      ? '='
      : percent !== null
        ? `${sign}${Math.abs(percent).toFixed(1)}%`
        : ratio
          ? `${sign}${(magnitude * 100).toFixed(2)} pp`
          : `${sign}${formatCell(magnitude)}`;

  return (
    <span
      data-testid="compare-change"
      className={cn(
        'inline-flex items-center gap-0.5 text-[0.6875rem]',
        good === null && 'text-muted',
      )}
      style={
        good === null
          ? undefined
          : { color: `var(--color-status-${good ? 'passed' : 'failed'})` }
      }
    >
      {absolute > 0 && <ChangeUpIcon className="h-3 w-3" />}
      {absolute < 0 && <ChangeDownIcon className="h-3 w-3" />}
      <Approx exact={exact}>{text}</Approx>
      {/* The space is its own text node, outside the hidden span: a space
          inside it is dropped by the name computation (see `Approx`). */}
      {good !== null && (
        <>
          {' '}
          <span className="sr-only">{good ? 'better' : 'worse'}</span>
        </>
      )}
    </span>
  );
}
