import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  CollapseIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  PlotIcon,
  TableIcon,
} from '../components/icons';
import { downloadCsv, toCsv } from '../tables/csv';
import { formatCell } from './DataTable';
import type { ChartTableRow } from './types';

/**
 * A chart card's own view controls: swap the plot for its numbers, take those
 * numbers away as a file or on the clipboard, and fill the screen with the
 * plot.
 *
 * ═══ WHY THESE LIVE IN THE HEADER AND NOT UNDER THE CHART ═══
 *
 * The table toggle used to be a full-width text button BELOW the figure,
 * reading "Show data table". Three things were wrong with that and only the
 * first is cosmetic.
 *
 * It sat after the chart, so on a page of ten charts the control for figure N
 * was adjacent to figure N+1 — the same ambiguity `Chart` already solved for
 * its `controls` slot by putting it between the title and the plot. It was
 * also the widest thing in the card at a small size, which gave a secondary
 * action more visual weight than the figure it belonged to. And a chart's
 * actions were split across two places the moment a second one existed.
 *
 * They could not be icons before this: the e2e suite counted `<svg>` elements
 * within the whole `<figure>` to prove a chart drew, so any icon in the card
 * broke that count. `plot()` in the e2e helpers now scopes those assertions to
 * `[data-chart-canvas]`, which is what they always meant. See that helper.
 *
 * ═══ THE TOGGLE IS STILL A DISCLOSURE, NOT A MODE SWITCH ═══
 *
 * Visually the table REPLACES the plot. To assistive technology it does not
 * replace anything, because the plot is `aria-hidden` — the table has always
 * been the only route to these values for a screen reader (design §7). So
 * `aria-expanded` + `aria-controls` remains the honest pairing, and it is also
 * what the e2e suite finds the button by. `aria-pressed` would describe a
 * change of visual arrangement that no assistive technology can observe.
 *
 * ═══ CSV MATCHES THE SCREEN; JSON CARRIES THE NUMBERS ═══
 *
 * The CSV is the table you are looking at, as a file, so it goes through the
 * same `formatCell` the cells do — the convention `statisticsCsv` already set,
 * down to writing an EMPTY cell rather than `0` for a gap, because a
 * spreadsheet averaging a column will fold a zero in and leave a blank out.
 * The clipboard JSON is the machine route and carries the unrounded values,
 * which is the same split `DataTable` makes between its text and its
 * `data-value`.
 */
export default function ChartActions({
  id,
  title,
  columns,
  rows,
  tableShown,
  onToggleTable,
  expanded,
  onToggleExpanded,
  expandable,
}: {
  readonly id: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly ChartTableRow[];
  readonly tableShown: boolean;
  readonly onToggleTable: () => void;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  /**
   * False for a chart with nothing to draw. Filling the screen with an
   * explanation of why there is no chart is not a bigger view of anything.
   */
  readonly expandable: boolean;
}) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The "Copied" acknowledgement is transient, and a component unmounted
  // before it lapses must not call `setState` afterwards.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // Nothing was plotted, so there is nothing to take away. Disabled rather
  // than hidden: a header whose control count changes per chart makes the
  // reader re-find each one, and `title` says why it cannot be used.
  const hasRows = rows.length > 0;

  const filename = `perfportal-${id}.csv`;
  const exportCsv = () =>
    downloadCsv(
      filename,
      toCsv(columns, rows.map((row) => [row.label, ...row.values.map(cell)])),
    );

  const copyJson = async () => {
    const payload = JSON.stringify(
      {
        chart: id,
        title,
        columns,
        rows: rows.map((row) => ({ label: row.label, values: row.values })),
      },
      null,
      2,
    );

    // THE CLIPBOARD IS ABSENT ON ANY PAGE THAT IS NOT A SECURE CONTEXT —
    // plain http on anything but localhost, i.e. an ordinary way to reach an
    // on-prem install. Optional-chaining it would make `await undefined`
    // resolve and this would report success over a copy that went nowhere,
    // which is the exact bug the token screen shipped once already.
    if (navigator.clipboard === undefined) {
      setCopied('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied('done');
    } catch {
      setCopied('failed');
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 2000);
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* ═══ RENDERED ONLY WHEN THERE IS SOMETHING TO SAY ═══

          An always-mounted live region is the textbook advice, and it is wrong
          here for a reason this codebase has already been bitten by twice. A
          chart card is rendered ten times on a page; ten permanently-empty
          `role="status"` elements make every page-wide `getByRole('status')`
          resolve eleven elements instead of one, and the query does not fail
          when that happens — it starts answering a different question. It broke
          `RunTelemetry`'s clock-skew test within a minute of being written.

          `Chart`'s empty-state `<p role="status">` already follows this rule:
          a status role exists exactly when there is a status. `ProjectSetup`'s
          copy failure does too.

          Failure is VISIBLE as well as announced; success is announced only,
          because the button's own icon has already turned into a check. A
          silent copy failure is indistinguishable from success, and the reader
          is about to paste. */}
      {copied !== 'idle' && (
        <p
          role="status"
          className={copied === 'failed' ? 'mr-1 text-[11px] text-muted' : 'sr-only'}
        >
          {copied === 'failed'
            ? 'Copy unavailable — this page is not a secure context.'
            : 'Chart data copied to the clipboard.'}
        </p>
      )}

      <IconButton
        // `aria-controls` is how assistive tech — and the e2e suite — knows
        // WHICH table this opens on a page holding ten of them.
        aria-controls={`chart-data-${id}`}
        aria-expanded={tableShown}
        label={tableShown ? 'Show the chart' : 'Show the data table'}
        onClick={onToggleTable}
      >
        {tableShown ? <PlotIcon className="h-4 w-4" /> : <TableIcon className="h-4 w-4" />}
      </IconButton>

      <IconButton
        label="Copy the chart data as JSON"
        disabled={!hasRows}
        disabledReason="This chart has no data to copy."
        onClick={() => void copyJson()}
      >
        {copied === 'done' ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
      </IconButton>

      <IconButton
        label="Download the chart data as CSV"
        disabled={!hasRows}
        disabledReason="This chart has no data to download."
        onClick={exportCsv}
      >
        <DownloadIcon className="h-4 w-4" />
      </IconButton>

      <IconButton
        label={expanded ? 'Exit full screen' : 'Show the chart full screen'}
        disabled={!expandable}
        disabledReason="This chart has nothing to draw."
        onClick={onToggleExpanded}
      >
        {expanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
      </IconButton>
    </div>
  );
}

/**
 * A 28px square icon control, in `ProjectRail`'s collapse-toggle style rather
 * than `Button`'s — for the reason that file gives: `Button`'s smallest height
 * is 32px, which is too tall to sit on a 15px card title without pushing the
 * header taller than the text in it.
 *
 * `label` is the accessible name AND the tooltip, and it names what the next
 * activation DOES rather than what the button currently is — there is no
 * visible text to contradict it, so a stale name is the only thing a
 * non-sighted reader would have to go on.
 */
function IconButton({
  label,
  disabled = false,
  disabledReason,
  onClick,
  children,
  ...aria
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly 'aria-controls'?: string;
  readonly 'aria-expanded'?: boolean;
}) {
  return (
    <button
      type="button"
      // `type="button"` is load-bearing: a bare <button> inside a <form>
      // submits it, which is the trap `Button`'s own docstring records.
      aria-label={label}
      title={disabled ? (disabledReason ?? label) : label}
      disabled={disabled}
      onClick={onClick}
      className="transition-ui flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
      {...aria}
    >
      {children}
    </button>
  );
}

/** A plotted value for the CSV — see the file docstring on why this rounds. */
function cell(value: string | number | null | undefined): string {
  // EMPTY, not `0` and not `—`, matching `statisticsCsv`: a spreadsheet folds
  // a zero into an average and leaves a blank out, and a gap in a series is
  // the absence of a measurement rather than a measurement of nothing.
  if (value === null || value === undefined) return '';
  return formatCell(value);
}
