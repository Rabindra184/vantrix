import { useId, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { StatRow, StatsResponse } from '@perfportal/contracts';
import {
  buildTree,
  filterTree,
  sortTree,
  type MetricFamily,
  type PercentileColumn,
  type SortColumn,
  type SortDirection,
  type TableRow,
} from './buildTree';

/**
 * §13.2 ⑤ the statistics table — Appendix A G-11…G-16.
 *
 * The rendered table is the PARITY SURFACE: every number a person can read
 * about this run is in the DOM here, as text, in a real `<table>`. So this file
 * owns what a table IS and delegates what a table DOES to the pure transforms:
 * WHICH rows exist and how they nest is `buildTree`'s, and how they reorder
 * (`sortTree`) and disappear (`filterTree`) is theirs too — all three pure,
 * all three tested in the node environment against the captured payload.
 *
 * What this file owns:
 *   1. the column set, driven by the payload's own percentile keys;
 *   2. the run-scope totals row, which is deliberately NOT in the tree;
 *   3. how a number is written down — including the percentile clamp;
 *   4. the INTERACTIVE DEFAULTS — which column the table opens sorted on and
 *      which way, and which groups are open — each of which is one line that
 *      no numeric assertion can see, and each of which has a test that names
 *      it (§9 checkpoints 3 and 4).
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
export interface Column {
  /** `data-column`, the React key, AND what `sortTree` sorts on — `StatRow`'s
   *  own field name, or a percentile key (`p99.9`); no numeric field starts
   *  with `p`. One identity, so the column a reader clicks and the field it
   *  orders by cannot come apart. */
  readonly column: SortColumn;
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

/**
 * §A.5's column set, with the percentile columns DERIVED FROM THE ROWS rather
 * than declared — `percentileColumnsOf` reads the keys the payload actually
 * carries, so a project configured with a different `K-03` set moves every
 * table that calls this.
 *
 * Shared with the request detail page (RQ-01), which shows one row with these
 * same columns. Two independent definitions of "the column set" is how a table
 * comes to render Mean under the Std Dev heading.
 */
export function columnsFor(rows: readonly StatRow[]): {
  readonly executions: readonly Column[];
  readonly responseTime: readonly Column[];
} {
  const percentiles = percentileColumnsOf(rows);
  return {
    executions: EXECUTION_COLUMNS,
    responseTime: [MIN_COLUMN, ...percentiles, ...TRAILING_TIME_COLUMNS],
  };
}

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
      // The one place a payload string becomes a `SortColumn`. It is sound in
      // both directions: `sortTree` reads any non-numeric column straight off
      // `row.percentiles`, which is exactly where this key came from, and no
      // `StatRow` numeric field starts with `p`, so a percentile key can never
      // collide with one.
      column: key as PercentileColumn,
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
 * 4. SORT — WHICH COLUMN, AND WHICH WAY (G-15, §9 checkpoint 3)
 * ======================================================================== */

interface SortState {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

/**
 * THE COLUMN THE TABLE OPENS SORTED ON: THE HIGHEST PERCENTILE THE PAYLOAD
 * CONFIGURES — `p99` for the reference run, `p99.9` for a project that
 * configures one.
 *
 * Read off the payload's keys for the same reason the percentile COLUMNS are
 * (§9 checkpoint 6): `p99` is a default of Gatling's, not a fact about this
 * product, and a hard-coded default column would silently sort a project's
 * table by a percentile it never asked for — or, when the key is absent, by
 * nothing at all, which looks exactly like an unsorted table.
 *
 * WHY A PERCENTILE AND NOT THE MEAN OR THE MAX. The question a reader opens
 * this table with is "what is slow", and the mean hides a request that is
 * usually fine and occasionally terrible — which is the request they are
 * looking for. The max answers it with a single outlier. The tail percentile
 * is the column the rest of the product already treats as the answer (the
 * percentile chart, the SLO framing in §13.2), so the table opens on the
 * highest one configured.
 *
 * `meanMs` only when the payload carries no percentiles at all — every
 * `StatRow` has a mean, so the table is always sorted by SOMETHING, and never
 * by a column that does not exist.
 */
function worstFirstColumn(percentiles: readonly Column[]): SortColumn {
  for (let i = percentiles.length - 1; i >= 0; i -= 1) {
    const candidate = percentiles[i]!;
    if (percentileOf(candidate.column) !== null) return candidate.column;
  }
  return 'meanMs';
}

/**
 * WHICH WAY A COLUMN SORTS ON ITS FIRST CLICK.
 *
 * Descending for a number, because every numeric column here is a measure of
 * cost — a count, an error rate, a duration — and the first click is a
 * question about the worst of them. Ascending for the NAME, because the first
 * click on a name column is a question about the alphabet, and Z→A is nobody's
 * first guess. A second click on the same column reverses whichever it was.
 */
const firstDirectionFor = (column: SortColumn): SortDirection =>
  column === 'name' ? 'asc' : 'desc';

const ARIA_SORT: Record<SortDirection, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

/* ======================================================================== *
 * 5. THE COMPONENT
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
  const filterId = useId();
  /** Prefix for the per-column label ids the headings name themselves by. */
  const labelIdBase = useId();

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

  /**
   * THE COLUMNS COME FROM THE WHOLE PAYLOAD, NOT FROM WHAT IS ON SCREEN.
   *
   * Every row the table CAN show — collapsed children included, and the totals
   * row — so neither expanding a group nor typing in the filter box changes the
   * shape of the table underneath the reader.
   */
  const columns = useMemo(() => {
    const rendered = [...(total === null ? [] : [total]), ...flatten(tree).map((r) => r.row)];
    const { executions, responseTime } = columnsFor(rendered);
    return {
      executions,
      responseTime,
      worstFirst: worstFirstColumn(percentileColumnsOf(rendered)),
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

  /**
   * THE TABLE OPENS SORTED, WORST FIRST — §9 checkpoint 3, the second of the
   * two NON-NUMERIC checkpoints.
   *
   * `null` means "nobody has clicked a heading yet", and the opening sort is
   * derived below rather than stored, so a table handed a payload with
   * different percentile keys opens on a column that payload actually has
   * instead of on a remembered one it does not.
   *
   * Ascending here would open the table on the FASTEST row — the answer to a
   * question nobody opens a performance report to ask. That one word is the
   * whole decision, and the previous sub-project's only escaped defect was a
   * one-word interactive default that flipped with 459 tests staying green.
   */
  const [sort, setSort] = useState<SortState | null>(null);
  const opening: SortState = { column: columns.worstFirst, direction: 'desc' };
  const activeSort = sort ?? opening;

  const sortBy = (column: SortColumn) =>
    setSort((was) => {
      const current = was ?? opening;
      // The same column reverses; a new one starts at ITS own first direction,
      // rather than inheriting the direction the previous column happened to
      // be in — the reader clicked a question, not an arrow.
      return current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: firstDirectionFor(column) };
    });

  /** G-14. The RAW input, straight through — see the pipeline below. */
  const [query, setQuery] = useState('');

  /* ---- the pipeline: filter, then sort, then decide what is visible ----
   *
   * THE QUERY IS PASSED THROUGH UNTOUCHED. `filterTree` already owns what a
   * query IS — trimmed at the ends, matched as a substring against the full
   * path, and an EMPTY query is not a query at all. Re-deciding any of that
   * here would give the product two answers to the same question, and the one
   * the tests pin is the other one.
   *
   * Filtering first is not just cheaper: sorting a pruned tree and pruning a
   * sorted one give the same rows in the same order (both transforms reorder
   * or drop SIBLINGS and neither touches the shape), so the cheap order is the
   * one to write down.
   */
  const filtered = filterTree(tree, query);
  /**
   * WHETHER A FILTER IS RUNNING, asked of `filterTree` rather than re-derived.
   *
   * Its contract is explicit: with no query "the whole tree comes back — the
   * same array, not a copy of it". So identity is the signal, and this cannot
   * drift from the trimming rule the way a second `query.trim() !== ''` here
   * would the day that rule changes.
   */
  const filtering = filtered !== tree;
  const sorted = sortTree(filtered, activeSort.column, activeSort.direction);

  /**
   * A FILTER OPENS WHAT IT KEPT.
   *
   * `filterTree` keeps a match's ancestors so the match arrives WITH its
   * context — and with groups collapsed by default, that context would
   * otherwise hide the very row the reader searched for: type "Recommend" and
   * the table answers with a closed `Catalog`. Every ancestor a filter keeps is
   * there because a match is underneath it, so while a query is running every
   * kept group is open.
   *
   * The reader's own expansion state is untouched underneath — `expandedKeys`
   * is what a click still writes to — so clearing the box hands the tree back
   * exactly as they left it.
   */
  const isExpanded = (key: string): boolean => filtering || expandedKeys.has(key);

  const rows = visibleRows(sorted, isExpanded);

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

      {/* G-14, THE FILTER BOX. A real `<label htmlFor>` rather than a
          placeholder: a placeholder disappears the moment the reader types,
          which is exactly when a screen reader is asked what the field is. */}
      <div className="flex items-center gap-2">
        <label htmlFor={filterId} className="text-sm text-muted">
          Filter by name
        </label>
        <input
          id={filterId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Off, because the values worth completing here are the row names
          // already on screen, and the browser would offer yesterday's runs.
          autoComplete="off"
          className="rounded border border-default px-2 py-0.5 text-sm"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          {/* The caption is the table's ACCESSIBLE NAME as well as its
              explanation — `getByRole('table', { name: /statistics/i })` is how
              this suite and the Playwright specs find it.

              It states the percentile caveat because the ruling requires it:
              a reader comparing our 99th against another tool's needs to know
              it is an estimate, and that is true whether or not it was
              clamped. */}
          <caption className="pb-3 text-left text-sm text-muted">
            Statistics for every request and group in this run, with the run’s own totals in the
            first row. Response times are in milliseconds. The percentile columns are estimates,
            accurate to within 1%, and are shown clamped to their own row’s minimum and maximum — a
            percentile of a sample cannot lie outside that sample’s range.
          </caption>

          <thead>
            {/* Gatling's own two-row header: the column GROUPS carry the unit,
                so the percentile headings do not each have to repeat it. */}
            <tr className="border-b border-default">
              <SortableHeader
                column="name"
                label={NAME_COLUMN_LABEL}
                labelId={`${labelIdBase}-name`}
                sort={activeSort}
                onSort={sortBy}
                rowSpan={2}
                style={{ paddingLeft: indentFor(0) }}
              />
              {/* The two headings that SPAN columns are not columns: there is
                  nothing to sort by, and a control here would have to guess
                  which of the five it meant. */}
              <th colSpan={columns.executions.length} scope="colgroup" className="py-2 pr-4">
                Executions
              </th>
              <th colSpan={columns.responseTime.length} scope="colgroup" className="py-2 pr-4">
                Response Time (ms)
              </th>
            </tr>
            <tr className="border-b border-default">
              {allColumns.map((column, index) => (
                <SortableHeader
                  key={column.column}
                  column={column.column}
                  label={column.label}
                  hint={column.hint}
                  labelId={`${labelIdBase}-${index}`}
                  sort={activeSort}
                  onSort={sortBy}
                />
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
                className="border-b border-default font-semibold"
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
                expanded={isExpanded(row.key)}
                onToggle={toggle}
              />
            ))}
            {/* A table that goes silently empty when a filter matches nothing
                reads as a broken table, not as an answer. Only while a filter
                is RUNNING: a run that recorded nothing is a different message,
                and it is handled above. */}
            {filtering && rows.length === 0 && (
              <tr>
                <td colSpan={allColumns.length + 1} className="py-2 pl-2">
                  No rows match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ======================================================================== *
 * 6. THE COLUMN HEADINGS, WHICH ARE THE SORT CONTROLS
 * ======================================================================== */

/**
 * One sortable column heading: the label a reader sees, a button that sorts by
 * it, and `aria-sort` saying which way it currently is.
 *
 * ═══ THE HEADER'S ACCESSIBLE NAME IS THE COLUMN'S LABEL, AND NOTHING ELSE ═══
 *
 * §9 checkpoint 6's negative — `queryByRole('columnheader', { name: /^95th$/ })`
 * returning null for a payload with no p95 — is null for EVERY implementation
 * the moment the headers stop being named after their columns. A sort control
 * inside the `<th>` is exactly what does that, and this was measured in this
 * stack (jsdom 30 + dom-accessibility-api 0.5.16) rather than assumed:
 *
 *   `<th><button aria-labelledby="hint lbl">…</button></th>`  → th named
 *   "Sort by 95th". A DESCENDANT'S `aria-labelledby` IS consulted when a
 *   header takes its name from its contents — and this is the construction a
 *   careful implementer reaches for, because it keeps the wording out of
 *   `textContent`.
 *
 *   `<th><button aria-label="Sort by 95th">95th</button></th>` → th named
 *   "95th" in jsdom, because a descendant's `aria-label` is NOT consulted
 *   there. Browsers do not all agree, and piece 8's Playwright specs read
 *   these names in a real one.
 *
 * So the header does not leave its name to be computed from whatever is
 * inside it: `aria-labelledby` points at the SPAN THAT RENDERS THE LABEL.
 * That is the same string the heading displays and the same string a
 * hard-coded percentile list would fail to produce, so the checkpoint's
 * negative stays exactly as live as it was before there were any controls.
 *
 * For the same reason the sort indicator is an SVG and not a glyph: the
 * heading's `textContent` is what the parity assertions read, and `95th ▼` is
 * not what the column is called.
 */
function SortableHeader({
  column,
  label,
  hint,
  labelId,
  sort,
  onSort,
  rowSpan,
  style,
}: {
  column: SortColumn;
  label: string;
  hint?: string;
  labelId: string;
  sort: SortState;
  onSort: (column: SortColumn) => void;
  rowSpan?: number;
  style?: CSSProperties;
}) {
  const sorted = sort.column === column;

  return (
    <th
      scope="col"
      rowSpan={rowSpan}
      style={style}
      aria-labelledby={labelId}
      // `none` on the others, not nothing: a column that CAN be sorted and
      // currently is not is a different thing from one that cannot be.
      aria-sort={sorted ? ARIA_SORT[sort.direction] : 'none'}
      className="py-2 pr-4 font-semibold"
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        // What the click will DO. "95th" alone would be announced as a button
        // called 95th, which is the column, not the action.
        aria-label={`Sort by ${label}`}
        className="inline-flex items-center gap-1"
      >
        {/* An `<abbr title>` explains an abbreviated heading without changing
            it — the label itself is what the column is called. */}
        {hint === undefined ? (
          <span id={labelId}>{label}</span>
        ) : (
          <abbr id={labelId} title={hint}>
            {label}
          </abbr>
        )}
        <SortArrow direction={sorted ? sort.direction : null} />
      </button>
    </th>
  );
}

/**
 * Which way the sorted column points, for readers who are looking rather than
 * listening — `aria-sort` above is the same fact for the ones who are not.
 *
 * Drawn, not written: a text arrow would land in the heading's `textContent`,
 * which is the string this table's parity assertions compare against Gatling's
 * own column names.
 */
function SortArrow({ direction }: { direction: SortDirection | null }) {
  if (direction === null) return null;
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 8 6" className="h-2 w-2 shrink-0">
      <path
        d={direction === 'asc' ? 'M4 0 L8 6 L0 6 Z' : 'M0 0 L8 0 L4 6 Z'}
        fill="currentColor"
      />
    </svg>
  );
}

/* ======================================================================== *
 * 7. ROWS AND CELLS
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
 *
 * Takes a PREDICATE rather than the set of open keys, because "open" is not
 * only what the reader clicked: a running filter opens every group it kept
 * (see `isExpanded`), and this walk should not have to know which of the two
 * reasons applies.
 */
function visibleRows(
  rows: readonly TableRow[],
  isExpanded: (key: string) => boolean,
): readonly TableRow[] {
  const out: TableRow[] = [];
  const walk = (level: readonly TableRow[]) => {
    for (const row of level) {
      out.push(row);
      if (row.children.length > 0 && isExpanded(row.key)) walk(row.children);
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
  /** Per-row, via `useId` rather than `row.key`: `row.key` is built from the
   *  payload's own `name` (`keyOf` in `buildTree.ts`), and an id sourced from
   *  payload data is payload-controlled — a name containing the separator two
   *  ids collide on would be a run away from a broken `aria-labelledby`. */
  const nameId = useId();

  return (
    <tr
      data-testid="stat-row"
      data-path={row.path}
      data-scope={row.scope}
      data-depth={row.depth}
      className="border-b border-default"
    >
      {/* `<th scope="row">`: the row's name is what makes "2503" mean
          something when a screen reader announces it out of context.

          ═══ SAME DEFECT `SortableHeader` DOCUMENTS ABOVE, ON THE OTHER AXIS ═══

          A GROUP row's `<th>` also contains a labelled `<button>` — the
          expand/collapse toggle below, named `aria-label="expand Cart"` for
          the reason its own comment gives. Left to compute its name from its
          own contents, a `<th>` in Chromium concatenates a descendant's
          `aria-label` into its own name: "expand Cart" then "Cart" from the
          `<Link>`, together "expand Cart Cart" — measured the same way
          `SortableHeader`'s comment measures the column case, and the same
          failure, just reached from `aria-label` instead of `aria-labelledby`
          and from a row instead of a column. A request row has no toggle and
          is unaffected, but D-10 gave every root group real children, so this
          is not a one-row curiosity — it is both top-level groups today.

          The fix is the same one: the `<th>` does not leave its name to be
          computed from its contents. `aria-labelledby` points at the `<Link>`
          below, which renders exactly the row's name and nothing else — the
          same shape as `SortableHeader`'s span, chosen for the same reason. */}
      <th
        scope="row"
        data-column="name"
        aria-labelledby={nameId}
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
              // This label STAYS: it is the button's own name, not the th's,
              // and `aria-labelledby` above is what keeps the two apart.
              aria-label={`${expanded ? 'collapse' : 'expand'} ${row.name}`}
              className="w-4 text-muted"
            >
              <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            </button>
          ) : (
            // A leaf keeps the toggle's width so the names below a group stay
            // in one column. Never an empty button: a control that does
            // nothing is announced as a control.
            <span aria-hidden="true" className="inline-block w-4" />
          )}
          <Link id={nameId} to={detailPathFor(runId, row)} className="underline">
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
