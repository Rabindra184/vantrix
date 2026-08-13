import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { buildTree, type MetricFamily, type TableRow } from './buildTree';

/**
 * §13.2 ⑤ the statistics table — Appendix A G-11, G-12, G-13 and G-16.
 *
 * The rendered table is the PARITY SURFACE: every number a person can read
 * about this run is in the DOM here, as text, in a real `<table>`. So this file
 * owns three things and delegates everything else — WHICH rows exist and how
 * they nest is `buildTree`'s (pure, tested against the captured payload in the
 * node environment), and WHAT the reader can do to them — sort, filter — is
 * task 6's, on top of this.
 *
 * What this file owns:
 *   1. the column set, driven by the payload's own percentile keys;
 *   2. the run-scope totals row, which is deliberately NOT in the tree;
 *   3. how a number is written down — including the percentile clamp.
 */

/* ======================================================================== *
 * 1. WHICH GROUP ROW — settled by measurement, not asserted
 * ======================================================================== */

/**
 * Every group appears twice in the payload, once per family, and the global
 * table shows ONE row per group (design §4).
 *
 * Task 1 measured which: Gatling's own global statistics table shows `Cart` as
 * min 106 / max 179 / mean 141 / stddev 19, and this payload's
 * `group_cumulated` Cart row is 106 / 179 / 141.07 / 18.79 — exact on all four,
 * verified the same way for `Catalog` and `Catalog/Recommendations`.
 * `group_duration` is 188 / 264 / 224.74 / 19.04 and matches none of them.
 *
 * A CONSTANT, not a prop: it is a fact about what this table IS, and a caller
 * free to pass `group_duration` would be free to render a global table Gatling
 * does not have. The group DETAIL page shows both families, and that is piece
 * 4's (design §4).
 */
const GLOBAL_GROUP_FAMILY: MetricFamily = 'group_cumulated';

/* ======================================================================== *
 * 2. THE PERCENTILE CLAMP — ruling-percentile-clamp.md
 * ======================================================================== */

/**
 * A percentile of a sample cannot lie outside that sample's own range, so an
 * estimate that does is known to be wrong — and min/max are tracked exactly
 * while percentiles carry DDSketch's 1% relative error. Clamping projects the
 * estimate onto the interval it was always constrained to; it is a better
 * estimate, not a prettier one.
 *
 * Measured on the reference run: `Catalog/Recommendations` reports p99 2515.4
 * against max 2503, and `Cart` reports p99 179.49 against max 179 — and so does
 * the run-scope totals row, at 2515.4 against 2503. The table puts p99 and Max
 * in adjacent columns, so unclamped a reader sees a 99th percentile larger than
 * the maximum and reasonably concludes the product is broken.
 *
 * NOT the pipeline's bug being hidden: task 1 confirmed we are exact on all
 * four exactly-tracked quantities and out by up to 14 ms in the sparse tail,
 * which is exactly the estimator's advertised error. The caption says the
 * percentiles are estimates, because that is true clamped or not.
 *
 * The right long-term home is `packages/statistics`, where the exact extremes
 * and the estimated percentiles are produced together and every consumer — the
 * API, the charts, any future export — would benefit. Recorded as follow-up in
 * the ruling; doing it in the browser fixes one surface, which is this one.
 */
export function clampPercentile(value: number, row: StatRow): number {
  return Math.min(Math.max(value, row.minMs), row.maxMs);
}

/* ======================================================================== *
 * 3. THE COLUMNS
 * ======================================================================== */

/**
 * One column: its identity, its heading, and how to read and write a row's
 * value on it.
 *
 * THE HEADER AND THE CELLS COME FROM THE SAME LIST, which is the point of this
 * type. Two parallel arrays — one of labels, one of accessors — is how a table
 * comes to render Mean under the Std Dev heading, and nothing about that is
 * visible in a diff.
 */
interface Column {
  /** `data-column`, and the React key. `StatRow`'s own field name, or a
   *  percentile key (`p99.9`) — no numeric field starts with `p`. */
  readonly column: string;
  /** The heading a reader sees, and the column's accessible name. */
  readonly label: string;
  /** Expanded in a `title`, for a heading that is an abbreviation. */
  readonly hint?: string;
  /** `undefined` when this row HAS no value here — which is not zero. */
  readonly value: (row: StatRow) => number | undefined;
  readonly format: (value: number) => string;
}

/**
 * Counts, written plain — no grouping separators. These cells are compared
 * against numbers the API and Gatling both write plain, and a locale-dependent
 * separator would make what a test reads depend on where it ran.
 *
 * No non-finite branch, unlike the two below: `count`, `okCount` and `koCount`
 * are `z.number().int()` in the contract, so a `NaN` here would be a broken
 * payload, and rendering it as `NaN` is how that gets noticed rather than
 * smoothed into a dash that reads as "none recorded".
 */
const formatCount = (value: number): string => String(value);

/**
 * Whole milliseconds, which is what Gatling's own table writes: its ROOT row
 * reads 16 / 109 / 2503 / 228 / 370 for a payload carrying 16 / 108.86 / 2503 /
 * 227.91 / 369.69. Rounded, never truncated — flooring 179.9 to 179 is wrong by
 * nearly a millisecond in the one direction a reader will not question.
 *
 * The unrounded value stays in the DOM beside it (`data-value`), so rounding
 * here is a display decision rather than a loss.
 */
const formatMs = (value: number): string =>
  Number.isFinite(value) ? String(Math.round(value)) : '—';

/** Two decimals, as Gatling writes `% KO` (2.68) and `Cnt/s` (14.21). */
const formatRate = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : '—');

/** Gatling's own name for the leftmost column, and it holds groups too. */
const NAME_COLUMN_LABEL = 'Requests';

/** §13.2 ⑤ / §A.5 C-01…C-05, in order. */
const EXECUTION_COLUMNS: readonly Column[] = [
  { column: 'count', label: 'Total', value: (r) => r.count, format: formatCount },
  { column: 'okCount', label: 'OK', value: (r) => r.okCount, format: formatCount },
  { column: 'koCount', label: 'KO', value: (r) => r.koCount, format: formatCount },
  {
    column: 'errorRate',
    label: '% KO',
    // The payload stores a FRACTION (0.0268); the column is a percentage. The
    // conversion happens once, here, so `data-value` carries the same quantity
    // the cell displays rather than one a reader has to know to multiply.
    value: (r) => r.errorRate * 100,
    format: formatRate,
  },
  {
    column: 'throughputRps',
    label: 'Cnt/s',
    hint: 'Count of events per second',
    value: (r) => r.throughputRps,
    format: formatRate,
  },
];

const MIN_COLUMN: Column = {
  column: 'minMs',
  label: 'Min',
  value: (r) => r.minMs,
  format: formatMs,
};

/** §A.5 C-11…C-13 — after the percentiles, as Gatling orders them. */
const TRAILING_TIME_COLUMNS: readonly Column[] = [
  { column: 'maxMs', label: 'Max', value: (r) => r.maxMs, format: formatMs },
  { column: 'meanMs', label: 'Mean', value: (r) => r.meanMs, format: formatMs },
  {
    column: 'stddevMs',
    label: 'Std Dev',
    hint: 'Standard deviation',
    value: (r) => r.stddevMs,
    format: formatMs,
  },
];

/** `p50`, `p99.9` — the shape `StatRow.percentiles` documents for its keys. */
const PERCENTILE_KEY = /^p(\d+(?:\.\d+)?)$/;

/** The percentile a key names, or `null` for a key that names none. */
const percentileOf = (key: string): number | null => {
  const match = PERCENTILE_KEY.exec(key);
  return match === null ? null : Number(match[1]);
};

/**
 * `p95` → `95th`, `p99.9` → `99.9th`.
 *
 * The digits are the payload's OWN spelling, not a re-formatted number, so a
 * project configured with `p99.90` gets its heading back unaltered.
 *
 * §13.2 ⑤ and §A.5 name these columns `50th`, `75th`, `95th`, `99th`, and that
 * is what is rendered — deliberately, and not Gatling's own `95th pct`: the
 * unit belongs to the `Response Time (ms)` group heading above, which is where
 * Gatling puts it too, and repeating `pct` in four adjacent headings is noise a
 * reader has to skip four times.
 *
 * A key that is not `p<number>` labels itself. There is no such key in any
 * payload the contract describes, and inventing an ordinal for one would render
 * a column heading nobody could trace back to the data.
 */
export function percentileColumnLabel(key: string): string {
  const match = PERCENTILE_KEY.exec(key);
  if (match === null) return key;
  const digits = match[1]!;
  return `${digits}${ordinalSuffix(Number(digits))}`;
}

/** English ordinals, so `p1` is `1st` and not `1th`. */
function ordinalSuffix(n: number): string {
  // 99.9th, not 99.9nd: a fraction has no ordinal form, and "th" is how they
  // are conventionally written.
  if (!Number.isInteger(n)) return 'th';
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/**
 * THE PERCENTILE COLUMNS COME FROM THE PAYLOAD'S KEYS — §9 checkpoint 6, and a
 * standing constraint of this plan.
 *
 * `StatRow.percentiles` is a `Record<string, number>` whose keys are the
 * project's configured percentiles (§A.6 K-03: 50/75/95/99 by default, and
 * configurable). A hard-coded list renders four empty columns for a project
 * configured with three, and silently drops the fourth it did configure.
 *
 * THE UNION over every row the table renders, not the first row's keys: the
 * keys are per-row, and a payload where one row lacks a key must still show
 * that key's column for the rows that have it — and a GAP, not a zero, for the
 * one that does not. Taken over all rows including collapsed children, so
 * expanding a group never changes the shape of the table.
 *
 * Ordered by the percentile itself rather than by key order, because JSON
 * object order is not something the API promises and `99th` before `50th`
 * would be a table nobody could read. Ties and unrecognised keys keep their
 * arrival order (`Array.prototype.sort` is stable since ES2019).
 */
function percentileColumnsOf(rows: readonly StatRow[]): readonly Column[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.percentiles)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }

  return keys
    .sort((a, b) => {
      const av = percentileOf(a);
      const bv = percentileOf(b);
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
      return av - bv;
    })
    .map((key) => ({
      column: key,
      label: percentileColumnLabel(key),
      value: (row: StatRow) => {
        const raw = row.percentiles[key];
        // A row without this key has no value on this column. Rendered as 0 it
        // would read as the fastest row in the table.
        if (raw === undefined || !Number.isFinite(raw)) return undefined;
        return clampPercentile(raw, row);
      },
      format: formatMs,
    }));
}

/* ======================================================================== *
 * 4. THE COMPONENT
 * ======================================================================== */

/** How far one level of nesting indents, and the root's own left padding. */
const INDENT_REM = 1.5;
const GUTTER_REM = 0.5;

/**
 * INDENTED FROM `row.depth`, WHICH IS THE ROW'S POSITION IN THE TREE — never
 * from a count of `/`s in its path. An orphan (`Catalog/Recommendations` in a
 * payload with no `Catalog`) is a ROOT at depth 0 carrying a two-segment path,
 * and indenting it as a child would put it under whatever row happened to be
 * above it.
 */
const indentFor = (depth: number): string => `${depth * INDENT_REM + GUTTER_REM}rem`;

export default function StatisticsTable({ stats, runId }: { stats: StatsResponse; runId: string }) {
  const headingId = useId();

  const tree = useMemo(() => buildTree(stats, GLOBAL_GROUP_FAMILY), [stats]);

  /**
   * THE RUN-SCOPE ROW, WHICH IS NOT A TREE ROW.
   *
   * `buildTree` excludes it deliberately, and Gatling's report agrees
   * structurally: "All Requests" sits alone in `<table
   * id="container_statistics_head">` while every group and request is in
   * `container_statistics_body`. It is the table's TOTAL — inside the tree it
   * would sort under an empty name and double every count the reader adds up.
   *
   * So it is read straight off the payload here. Nothing in `buildTree`'s
   * tests can notice its absence, which is exactly why it is rendered
   * explicitly rather than left to be discovered.
   *
   * `?? null` rather than an invented row: a payload with no run row gets no
   * totals row, because zeros would assert a measurement nobody took.
   */
  const total = useMemo(() => stats.stats.find((row) => row.scope === 'run') ?? null, [stats]);

  const columns = useMemo(() => {
    const rendered = [...(total === null ? [] : [total]), ...flatten(tree).map((r) => r.row)];
    return {
      executions: EXECUTION_COLUMNS,
      responseTime: [MIN_COLUMN, ...percentileColumnsOf(rendered), ...TRAILING_TIME_COLUMNS],
    };
  }, [tree, total]);

  /**
   * GROUPS START COLLAPSED — §9 checkpoint 4, and one of the two NON-NUMERIC
   * checkpoints this plan requires.
   *
   * The empty set is the whole decision, and it is one line, which is precisely
   * the failure mode the checkpoint exists for: the previous sub-project's only
   * escaped defect was an interactive default that could flip with 459 tests
   * staying green. Expanded by default, a run with deep groups opens as a wall
   * of rows in which the shape of the run — how many top-level groups there
   * are — is invisible.
   *
   * Keyed by `TableRow.key`, which is stable across sort and filter (task 2),
   * so expanding a group and then sorting the table does not collapse it.
   */
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (key: string) =>
    setExpandedKeys((was) => {
      const next = new Set(was);
      // `delete` reports whether it removed anything, so this is "flip it"
      // without asking twice.
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const rows = useMemo(() => visibleRows(tree, expandedKeys), [tree, expandedKeys]);

  if (total === null && tree.length === 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2 id={headingId} className="text-xl font-semibold">
          Statistics
        </h2>
        {/* No table at all, rather than headings over nothing: an empty table
            reads as a run that was measured and found to have done nothing. */}
        <p>No statistics were recorded for this run.</p>
      </section>
    );
  }

  const allColumns = [...columns.executions, ...columns.responseTime];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-xl font-semibold">
        Statistics
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          {/* The caption is the table's ACCESSIBLE NAME as well as its
              explanation — `getByRole('table', { name: /statistics/i })` is how
              this suite and the Playwright specs find it.

              It states the percentile caveat because the ruling requires it:
              a reader comparing our 99th against another tool's needs to know
              it is an estimate, and that is true whether or not it was
              clamped. */}
          <caption className="pb-3 text-left text-sm text-[var(--color-text-muted)]">
            Statistics for every request and group in this run, with the run’s own totals in the
            first row. Response times are in milliseconds. The percentile columns are estimates,
            accurate to within 1%, and are shown clamped to their own row’s minimum and maximum — a
            percentile of a sample cannot lie outside that sample’s range.
          </caption>

          <thead>
            {/* Gatling's own two-row header: the column GROUPS carry the unit,
                so the percentile headings do not each have to repeat it. */}
            <tr className="border-b border-[var(--color-border)]">
              <th
                rowSpan={2}
                scope="col"
                className="py-2 pr-4 font-semibold"
                style={{ paddingLeft: indentFor(0) }}
              >
                {NAME_COLUMN_LABEL}
              </th>
              <th colSpan={columns.executions.length} scope="colgroup" className="py-2 pr-4">
                Executions
              </th>
              <th colSpan={columns.responseTime.length} scope="colgroup" className="py-2 pr-4">
                Response Time (ms)
              </th>
            </tr>
            <tr className="border-b border-[var(--color-border)]">
              {allColumns.map((column) => (
                <th key={column.column} scope="col" className="py-2 pr-4 font-semibold">
                  {/* An `<abbr title>` explains an abbreviated heading without
                      changing it: the accessible name still comes from the
                      text, which is what the column is called. */}
                  {column.hint === undefined ? (
                    column.label
                  ) : (
                    <abbr title={column.hint}>{column.label}</abbr>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          {/* TWO BODIES, so the totals row is structurally apart from the rows
              that sort and filter — the same separation Gatling makes with two
              tables. Task 6 reorders the second one; this one never moves. */}
          {total !== null && (
            <tbody>
              <tr
                data-testid="stat-row-total"
                data-scope="run"
                className="border-b border-[var(--color-border)] font-semibold"
              >
                <th
                  scope="row"
                  data-column="name"
                  className="py-1 pr-4"
                  style={{ paddingLeft: indentFor(0) }}
                >
                  {/* Gatling's own wording. Not a link: this is the run, and
                      the reader is already on its page. */}
                  All Requests
                </th>
                <Cells row={total} columns={allColumns} />
              </tr>
            </tbody>
          )}

          <tbody>
            {rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                runId={runId}
                columns={allColumns}
                expanded={expandedKeys.has(row.key)}
                onToggle={toggle}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ======================================================================== *
 * 5. ROWS AND CELLS
 * ======================================================================== */

/** Depth-first, parents before children — every row, expanded or not. */
function flatten(rows: readonly TableRow[]): TableRow[] {
  return rows.flatMap((row) => [row, ...flatten(row.children)]);
}

/**
 * The rows a reader can currently see: every root, and the children of a group
 * they have opened. A collapsed group's children are not rendered at all rather
 * than hidden with CSS — `display: none` on a hundred rows is a hundred rows a
 * screen reader still has to be told to skip.
 */
function visibleRows(
  rows: readonly TableRow[],
  expandedKeys: ReadonlySet<string>,
): readonly TableRow[] {
  const out: TableRow[] = [];
  const walk = (level: readonly TableRow[]) => {
    for (const row of level) {
      out.push(row);
      if (row.children.length > 0 && expandedKeys.has(row.key)) walk(row.children);
    }
  };
  walk(rows);
  return out;
}

/**
 * G-16: every row links to its own detail page.
 *
 * The link carries the row's FULL PATH, not the leaf name it displays —
 * `Recommendations` does not identify `Catalog/Recommendations`, and two groups
 * in different parents may share a leaf name. Encoded as ONE path segment, so
 * a group's separators arrive at the route as data (`Catalog%2FRecommendations`)
 * rather than as extra segments no route matches.
 *
 * Piece 3 fills `/requests/:name` and piece 4 `/groups/:name`; today they are
 * an honest "not built yet" placeholder (design §1), which is why request
 * identity can still change under D-10 without breaking a compatibility
 * surface that does not exist yet.
 */
export function detailPathFor(runId: string, row: TableRow): string {
  const section = row.scope === 'group' ? 'groups' : 'requests';
  return `/runs/${encodeURIComponent(runId)}/${section}/${encodeURIComponent(row.path)}`;
}

function Row({
  row,
  runId,
  columns,
  expanded,
  onToggle,
}: {
  row: TableRow;
  runId: string;
  columns: readonly Column[];
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const expandable = row.children.length > 0;

  return (
    <tr
      data-testid="stat-row"
      data-path={row.path}
      data-scope={row.scope}
      data-depth={row.depth}
      className="border-b border-[var(--color-border)]"
    >
      {/* `<th scope="row">`: the row's name is what makes "2503" mean
          something when a screen reader announces it out of context. */}
      <th
        scope="row"
        data-column="name"
        className="py-1 pr-4 font-normal"
        style={{ paddingLeft: indentFor(row.depth) }}
      >
        <span className="inline-flex items-center gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={() => onToggle(row.key)}
              aria-expanded={expanded}
              // The accessible name says what the click will DO, and names the
              // row it will do it to — one "expand" button repeated down a
              // table tells a screen-reader user nothing about which group.
              aria-label={`${expanded ? 'collapse' : 'expand'} ${row.name}`}
              className="w-4 text-[var(--color-text-muted)]"
            >
              <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            </button>
          ) : (
            // A leaf keeps the toggle's width so the names below a group stay
            // in one column. Never an empty button: a control that does
            // nothing is announced as a control.
            <span aria-hidden="true" className="inline-block w-4" />
          )}
          <Link to={detailPathFor(runId, row)} className="underline">
            {row.name}
          </Link>
        </span>
      </th>
      <Cells row={row.row} columns={columns} />
    </tr>
  );
}

/**
 * One row's numbers, from the same column list the headings came from — so a
 * cell cannot land under the wrong heading.
 */
function Cells({ row, columns }: { row: StatRow; columns: readonly Column[] }) {
  return (
    <>
      {columns.map((column) => {
        const value = column.value(row);
        return (
          <td
            key={column.column}
            data-column={column.column}
            className="py-1 pr-4 tabular-nums"
            // THE EXACT VALUE, beside the rounded one — the same split the
            // charts' data table makes, and for the same reason: a parity spec
            // comparing against Gatling's displayed integers reads the text,
            // one comparing against the API's own numbers reads this, and
            // neither has to reach back into the payload. Omitted entirely for
            // a gap, so present and absent mean what the cell shows.
            data-value={value === undefined ? undefined : String(value)}
          >
            {/* A gap is not a zero: a row whose payload carries no p99 has no
                p99, and `0` in a response-time column reads as the fastest row
                in the table. */}
            {value === undefined ? '—' : column.format(value)}
          </td>
        );
      })}
    </>
  );
}
