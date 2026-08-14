import type { StatRow, StatsResponse } from '@perfportal/contracts';

/**
 * §13.2 ⑤ the statistics table's row tree (Appendix A G-11…G-13):
 * `StatsResponse` → the hierarchy the table renders.
 *
 * Pure data in, pure data out. No React, nothing that needs a DOM — which is
 * what lets the tree, and later the sort and the filter, be asserted in the
 * node environment against the captured payload rather than through a
 * rendered table.
 */

/**
 * One rendered row.
 *
 * `path` is the identity — the payload's full `name`, what the row's detail
 * link and the filter match on. `name` is what the reader sees, which is the
 * LEAF segment whenever a parent row is present to supply the rest of the
 * context, and the full path when there is not (see `buildTree`'s orphan
 * rule). `depth` is the row's actual position in this tree, not its segment
 * count, so an orphan promoted to the root is depth 0 and indents like one.
 */
export interface TableRow {
  /** Stable across sort and filter: `${scope}:${family}:${name}`. */
  readonly key: string;
  readonly scope: 'run' | 'group' | 'request';
  /** The LEAF name, for display. The full path when nothing above supplies context. */
  readonly name: string;
  /** The full name, for links and matching. */
  readonly path: string;
  readonly depth: number;
  readonly row: StatRow;
  readonly children: readonly TableRow[];
}

/** The scopes that are table rows. `run` and `scenario` are not — see below. */
type RowScope = TableRow['scope'];

/**
 * Derived from the contract row rather than imported: `@perfportal/contracts`
 * exports `MetricFamilySchema` but no inferred `MetricFamily` type, and
 * `@perfportal/core`'s same-named type is a different package's declaration.
 * Taking it off `StatRow` guarantees this signature can never drift from the
 * field it selects on.
 */
export type MetricFamily = StatRow['family'];

const SEPARATOR = '/';

/**
 * HIERARCHY IS ENCODED IN THE NAME, AND NOWHERE ELSE (design §3).
 *
 * No `StatRow` carries a parent id. Group names are path-like — `Cart`,
 * `Catalog`, `Catalog/Recommendations` — and splitting on `/` is the only
 * signal there is. A name with no separator is a root.
 *
 * The parent relation this produces is acyclic by construction: a parent's
 * path is a strict prefix of its child's and therefore strictly shorter, so
 * following parents upwards always terminates.
 */
const parentPathOf = (path: string): string | null => {
  const cut = path.lastIndexOf(SEPARATOR);
  return cut <= 0 ? null : path.slice(0, cut);
};

const leafNameOf = (path: string): string => {
  const cut = path.lastIndexOf(SEPARATOR);
  return cut < 0 ? path : path.slice(cut + 1);
};

const keyOf = (row: StatRow): string => `${row.scope}:${row.family}:${row.name}`;

/**
 * WHICH ROWS ARE TABLE ROWS.
 *
 * `run` is excluded. The run-scope row (`name: ''`) is the table's TOTAL, not
 * a row in the hierarchy, and Gatling's own report agrees structurally: its
 * `index.html` puts "All Requests" alone in `<table
 * id="container_statistics_head">` and every group and request in a separate
 * `container_statistics_body`. Included here it would sort under an empty
 * name and double every count the reader adds up. The caller reads it
 * directly off `stats.stats` when it wants a totals row.
 *
 * `scenario` is excluded for the same reason it is absent from Gatling's
 * global table: it is a different axis, not a level of this tree. The
 * reference payload contains none.
 */
const isRowScope = (scope: StatRow['scope']): scope is RowScope =>
  scope === 'group' || scope === 'request';

/**
 * WHICH OF A GROUP'S TWO ROWS (design §4).
 *
 * Every group appears twice — once `group_cumulated`, once `group_duration` —
 * and the global table shows one row per group. Task 1 measured which:
 * `group_cumulated` reproduces Gatling's own global table exactly on min, max,
 * mean and std dev for all three groups, and `group_duration` matches none of
 * them. That is the caller's decision to state, so it arrives as `family`
 * rather than being assumed here.
 *
 * The filter applies to GROUP rows only. Request rows are `response_time` and
 * are not duplicated, so filtering the whole payload by `family` would empty
 * the table of every request — a table of three rows that still passes any
 * test phrased as "no `group_duration` row is present".
 *
 * (`latency` is out of scope for this piece, design §1. A latency table would
 * need a second argument for the non-group rows; it does not get one here
 * rather than getting a guess.)
 */
const wantedFamily = (scope: RowScope, family: MetricFamily): MetricFamily =>
  scope === 'group' ? family : 'response_time';

interface Node {
  readonly row: StatRow;
  readonly scope: RowScope;
  readonly path: string;
  readonly children: Node[];
  parented: boolean;
}

/**
 * `StatsResponse` → the row tree, in payload order, with `family` selecting
 * which of each group's two rows appears.
 *
 * Deterministic and total: every kept row reaches the output exactly once, at
 * the root if its parent is missing. Nothing is dropped for being malformed,
 * because a statistics table that silently loses a row is worse than one that
 * shows a row unnested.
 */
export function buildTree(stats: StatsResponse, family: MetricFamily): readonly TableRow[] {
  /* ---- 1. select: the right scopes, the right family, once each -------- */

  const nodes: Node[] = [];
  /** `${scope}:${name}` — a group and a request MAY share a name, and both stay. */
  const seen = new Set<string>();

  for (const row of stats.stats) {
    if (!isRowScope(row.scope)) continue;
    if (row.family !== wantedFamily(row.scope, family)) continue;
    // First wins. A payload carrying the same (scope, name, family) twice is
    // malformed; rendering it twice would give two rows with the same link and
    // the same key, which React and every later sort would then disagree about.
    const identity = `${row.scope}:${row.name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    nodes.push({ row, scope: row.scope, path: row.name, children: [], parented: false });
  }

  /* ---- 2. index the possible parents ---------------------------------- */

  // Only GROUPS can be parents. A request named `Catalog` does not adopt
  // `Catalog/Recommendations`: requests are leaves in every payload Gatling
  // produces, and treating one as a container would invent a hierarchy the
  // payload never claimed.
  const groupsByPath = new Map<string, Node>();
  for (const node of nodes) {
    if (node.scope === 'group' && !groupsByPath.has(node.path)) groupsByPath.set(node.path, node);
  }

  /* ---- 3. parent each node, or leave it at the root -------------------- */

  const roots: Node[] = [];
  for (const node of nodes) {
    const parentPath = parentPathOf(node.path);
    const parent = parentPath === null ? undefined : groupsByPath.get(parentPath);
    if (parent && parent !== node) {
      parent.children.push(node);
      node.parented = true;
    } else {
      // THE ORPHAN RULE. `Catalog/Recommendations` in a payload with no
      // `Catalog` is shown at the root rather than dropped. Only the IMMEDIATE
      // prefix is consulted, so `A/B/C` still nests under a surviving `A/B`
      // when `A` is the one that is missing.
      roots.push(node);
    }
  }

  /* ---- 4. materialise, assigning depth from placement ------------------ */

  const materialise = (node: Node, depth: number): TableRow => ({
    key: keyOf(node.row),
    scope: node.scope,
    // A nested row shows its leaf segment because the parent row above it
    // supplies the rest. A row at the root has nothing above it, so an orphan
    // shows its full path — displayed as `Recommendations`, it would be
    // indistinguishable from a top-level group of that name.
    name: node.parented ? leafNameOf(node.path) : node.path,
    path: node.path,
    depth,
    row: node.row,
    children: node.children.map((child) => materialise(child, depth + 1)),
  });

  return roots.map((node) => materialise(node, 0));
}

/* ======================================================================== *
 * SORTING (design §7)
 * ======================================================================== */

export type SortDirection = 'asc' | 'desc';

/**
 * The numeric columns are `StatRow`'s own field names, so a column is the
 * field it sorts on and cannot drift from it.
 */
const NUMERIC_COLUMNS = [
  'count',
  'okCount',
  'koCount',
  'errorRate',
  'minMs',
  'maxMs',
  'meanMs',
  'stddevMs',
  'throughputRps',
] as const;

export type NumericColumn = (typeof NUMERIC_COLUMNS)[number];

/**
 * The percentile columns are NOT a fixed list. `StatRow.percentiles` is a
 * `Record<string, number>` whose keys come from the project's configured
 * percentiles — `p50`, `p95`, `p99.9` — so the table's percentile columns, and
 * therefore its sortable percentile columns, are whatever the payload carries
 * (§9 checkpoint 6). No `StatRow` numeric field begins with `p`, so the two
 * halves of `SortColumn` cannot collide.
 */
export type PercentileColumn = `p${string}`;

/** `name` is the leftmost column and sortable like any other. */
export type SortColumn = 'name' | NumericColumn | PercentileColumn;

const NUMERIC_COLUMN_SET: ReadonlySet<string> = new Set(NUMERIC_COLUMNS);

/**
 * A row's value on a column, or `undefined` when it HAS none.
 *
 * `undefined` is not zero. A row whose payload carries no `p99.9` has no p99.9
 * — read as 0 it would sort into the fastest slot in the table and be read as
 * the best row in it. Non-finite values (a `NaN` that survived a division)
 * are treated the same way, because they cannot be ordered at all.
 */
const valueOf = (row: StatRow, column: SortColumn): number | undefined => {
  const raw = NUMERIC_COLUMN_SET.has(column)
    ? (row as unknown as Record<string, unknown>)[column]
    : row.percentiles[column];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
};

/**
 * Case-insensitive, and deliberately NOT `localeCompare`: the default locale
 * comes from the host, and a table whose row order depends on the reader's
 * browser is a table two people cannot discuss.
 */
const compareNames = (a: TableRow, b: TableRow, direction: SortDirection): number => {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an === bn) return 0;
  const ascending = an < bn ? -1 : 1;
  return direction === 'asc' ? ascending : -ascending;
};

const compare = (
  a: TableRow,
  b: TableRow,
  column: SortColumn,
  direction: SortDirection,
): number => {
  if (column === 'name') return compareNames(a, b, direction);

  const av = valueOf(a.row, column);
  const bv = valueOf(b.row, column);

  // A row with no value on this column sorts LAST in both directions. It is
  // not the smallest and it is not the largest; it is absent, and the reader
  // should find it where absent things are, not at whichever end the arrow
  // currently points. (So `desc` is not the exact reverse of `asc` for a
  // column some rows lack. That asymmetry is the point.)
  if (av === undefined || bv === undefined) {
    if (av === bv) return 0;
    return av === undefined ? 1 : -1;
  }

  if (av === bv) return 0;
  return direction === 'asc' ? av - bv : bv - av;
};

/**
 * Sort the tree, keeping every child with its parent (design §7).
 *
 * SORTING A TREE IS NOT SORTING A LIST. Each SIBLING LIST is ordered against
 * itself and the recursion carries on into the children; the tree's shape is
 * never touched. A flat sort — or a flatten, sort and re-nest — reads the
 * hierarchy back out of the row paths, and the hierarchy is not in the paths:
 * `buildTree` decides that only a GROUP adopts children (so a request named
 * `Catalog` is a leaf beside the group of that name) and that an orphan is a
 * ROOT at depth 0. Re-deriving either from two path segments loses it.
 * `depth` is carried through untouched for the same reason.
 *
 * PURE. The input arrays are copied before they are ordered, because a caller
 * holding the tree across a React render must not have it reordered underneath
 * them. Unchanged leaves are shared by reference rather than cloned; every
 * `TableRow` is readonly, and rebuilding them would only make the sort look
 * like it computed something.
 *
 * STABLE, which is `Array.prototype.sort`'s guarantee since ES2019 and is
 * relied on here rather than re-implemented with an index decoration: the
 * comparator returns 0 for equal values and NEVER falls back to a name or path
 * tie-break, so ties come out in the order they arrived. That is what makes a
 * second click on a second column refine the first rather than discard it.
 */
export function sortTree(
  rows: readonly TableRow[],
  column: SortColumn,
  direction: SortDirection,
): readonly TableRow[] {
  return [...rows]
    .sort((a, b) => compare(a, b, column, direction))
    .map((row) =>
      row.children.length === 0
        ? row
        : { ...row, children: sortTree(row.children, column, direction) },
    );
}

/* ======================================================================== *
 * FILTERING (design §7, §9 checkpoint 2)
 * ======================================================================== */

/**
 * WHAT THE QUERY IS MATCHED AGAINST: `path`, THE FULL NAME — NOT `name`, THE
 * DISPLAYED LEAF.
 *
 * The two are different for a nested row: `Catalog/Recommendations` displays
 * as `Recommendations` because the `Catalog` row above supplies the rest.
 * Matching the leaf alone makes that row unfindable by typing `Catalog/Rec` —
 * the exact string the reader copied out of the detail link — and matching the
 * path is a strict SUPERSET of matching the leaf, because a leaf is always a
 * substring of its own path. So nothing findable by the displayed name stops
 * being findable.
 *
 * The cost usually charged against path matching is that a row can be surfaced
 * by text it does not display — matched on a parent's name it never shows. It
 * is not charged here, because THIS filter keeps ancestors. A path match that
 * is not also a leaf match must overlap the parent-prefix half of the path,
 * and `buildTree` guarantees the only rows carrying such a prefix are ones
 * whose ancestors ARE that prefix (a row is nested only under the group at its
 * immediate parent path). Those ancestors are kept and rendered above the
 * match, so every character the reader typed is on screen — spread down the
 * indent, which is where the hierarchy put it. The one row with no ancestors
 * to render is the orphan, and `buildTree` already displays a root's FULL path
 * as its name. Either way `path` is what the reader can see.
 *
 * Substring, not regex: design §7 puts regex out of scope for this piece and
 * records it as a gap against G-14. So the query is literal text — `.*` is a
 * search for a dot and a star, and finds nothing, rather than quietly
 * selecting every row.
 */
const matches = (row: TableRow, needle: string): boolean =>
  row.path.toLowerCase().includes(needle);

/**
 * Filter the tree by name, KEEPING THE ANCESTORS OF EVERY MATCH (design §7).
 *
 * A node survives if it matches, or if any descendant does. A surviving
 * ancestor is kept AS an ancestor: at its own depth, with its children pruned
 * to the branches that lead to a match. Promoting matches to the root instead
 * — §9 checkpoint 2 — is what turns `Catalog/Recommendations` into a row with
 * no context, and on the D-10 payload it also collapses three sibling requests
 * into an unnested list of things that no longer say which group they ran in.
 *
 * A MATCHING NODE KEEPS ITS WHOLE SUBTREE, untouched and by reference. This
 * costs nothing in correctness: a child's path is its parent's path plus a
 * segment, so any query the parent's path contains, the child's path contains
 * too — the subtree would survive a recursive walk unchanged, and returning it
 * as-is only skips rebuilding rows that are already the right answer.
 *
 * AN EMPTY QUERY IS NOT A QUERY. A blank filter box is the absence of a
 * filter, so the whole tree comes back — the same array, not a copy of it.
 * (`''.includes` would answer `true` for every row and get the same rows out,
 * but through a full rebuild, and it would leave "no filter" indistinguishable
 * from "a filter that happens to match everything" at the one place where the
 * distinction is cheap to state.) The query is trimmed at its ends first: a
 * trailing space is typing, not intent. Interior spaces are kept — `Add To
 * Cart` is two of them.
 *
 * PURE, like `sortTree`: the input arrays are never mutated, `depth` and
 * `name` are carried through rather than re-derived (an orphan is still a
 * depth-0 root showing its full path), and unchanged subtrees are shared by
 * reference rather than cloned.
 */
export function filterTree(rows: readonly TableRow[], query: string): readonly TableRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;

  const keep = (row: TableRow): TableRow | null => {
    if (matches(row, needle)) return row;
    const children = row.children.map(keep).filter((child): child is TableRow => child !== null);
    // No match at or under this row: it is not context for anything.
    return children.length === 0 ? null : { ...row, children };
  };

  return rows.map(keep).filter((row): row is TableRow => row !== null);
}
