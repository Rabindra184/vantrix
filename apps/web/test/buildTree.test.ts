import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  filterTree,
  sortTree,
  type MetricFamily,
  type SortColumn,
  type SortDirection,
  type TableRow,
} from '../src/tables/buildTree.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑤ the statistics table's row tree (Appendix A G-11…G-13), built from
 * `GET /v1/runs/:id/stats` and nothing else.
 *
 * Read against `fixtures/reference-run.json` — the payload captured from the
 * live API for the real Gatling reference run, the same bytes the browser
 * receives.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The brief's three example tests are all
 * satisfiable by code that is wrong, and the failure modes are not exotic:
 *
 * - "nests a slash-separated group under its parent" uses `toContain` on the
 *   children, so an implementation that makes EVERY row a child of every group
 *   passes it.
 * - "shows an orphaned path at root rather than dropping it" uses `toContain`
 *   on the root paths, so an implementation that never nests anything passes
 *   it, and so does one that shows the orphan at root while silently losing
 *   some OTHER row — the exact failure the test was written to catch, just
 *   displaced by one row.
 * - "carries every row of the requested family, and none of the other" asserts
 *   `families.has('group_duration') === false` and that the group paths are
 *   distinct. **An empty tree passes both.** So does a tree that drops all
 *   three groups. So does one that ignores the `family` argument entirely and
 *   keeps whichever of the two duplicate rows the payload happens to list
 *   first — which is `group_cumulated` here, so the test can never see it.
 *
 * All three are kept, verbatim where the brief wrote them, because they pin
 * the intended shape. Each is immediately followed by the assertion that
 * actually discriminates: an exact path set rather than a membership check, a
 * conservation check across the whole flattened tree rather than its root, and
 * a NUMERIC check that the `family` argument selected the rows it names.
 */

const stats = fixture.stats as unknown as StatsResponse;

/** Depth-first flatten, parents before children — the render order. */
const flat = (rs: readonly TableRow[]): TableRow[] => rs.flatMap((r) => [r, ...flat(r.children)]);

const paths = (rs: readonly TableRow[]): string[] => rs.map((r) => r.path);

/** The payload with some rows removed, for the malformed-input cases. */
const without = (pred: (r: StatRow) => boolean): StatsResponse => ({
  ...stats,
  stats: stats.stats.filter((r) => !pred(r)),
});

/** The payload with one row's `name` rewritten — for path-qualified requests. */
const renamed = (from: string, to: string): StatsResponse => ({
  ...stats,
  stats: stats.stats.map((r) => (r.name === from && r.scope === 'request' ? { ...r, name: to } : r)),
});

const find = (rs: readonly TableRow[], path: string): TableRow => {
  const hit = flat(rs).find((r) => r.path === path);
  if (!hit) throw new Error(`no row at path ${JSON.stringify(path)}`);
  return hit;
};

/**
 * The reference run's ten table rows, in payload order: three groups (one row
 * each, not two) and seven requests. Spelled out so that a row appearing,
 * vanishing or moving is a test failure rather than a silent change.
 *
 * D-10: five of the seven requests carry their group path joined onto their
 * name, so their PATH — the identity this list is keyed on — is the joined
 * form, not the bare leaf. `Place Order` and `Search` genuinely have no group
 * and keep their bare name as their path.
 */
const ALL_PATHS = [
  'Cart',
  'Catalog',
  'Catalog/Recommendations',
  'Cart/Add To Cart',
  'Cart/View Cart',
  'Catalog/List Products',
  'Catalog/Product Detail',
  'Catalog/Recommendations/Related Items',
  'Place Order',
  'Search',
];

describe('buildTree — the statistics row tree ⑤ (G-11…G-13)', () => {
  /* ---------------------------------------------------------------- *
   * hierarchy from the name, which is the only signal there is
   * ---------------------------------------------------------------- */

  it('nests a slash-separated group under its parent', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const catalog = tree.find((r) => r.path === 'Catalog')!;
    expect(catalog.children.map((c) => c.path)).toContain('Catalog/Recommendations');
    // Displayed leaf name, not the full path — the parent supplies the context.
    expect(catalog.children.find((c) => c.path === 'Catalog/Recommendations')!.name).toBe(
      'Recommendations',
    );
  });

  /**
   * The discriminating form of the test above. `toContain` on the children
   * cannot fail for an implementation that parents everything to everything;
   * an exact list, plus the absence of the child from the root, can.
   */
  it('nests it there and ONLY there, one level down', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const catalog = find(tree, 'Catalog');
    // D-10: `Catalog` has two of its own direct-child requests besides the
    // `Recommendations` subgroup — all three are its children, and none of
    // them is promoted to the root.
    expect(paths(catalog.children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);
    expect(paths(tree)).not.toContain('Catalog/Recommendations');
    expect(catalog.depth).toBe(0);
    expect(find(tree, 'Catalog/Recommendations').depth).toBe(1);
    // …and the child nests its own request one level further down: `Related
    // Items` ships as `Catalog/Recommendations/Related Items`.
    expect(paths(find(tree, 'Catalog/Recommendations').children)).toEqual([
      'Catalog/Recommendations/Related Items',
    ]);
  });

  it('leaves a group with no slash at the root', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const cart = find(tree, 'Cart');
    expect(cart.name).toBe('Cart');
    expect(cart.depth).toBe(0);
    expect(paths(tree)).toContain('Cart');
  });

  /* ---------------------------------------------------------------- *
   * request rows: MEASURED, not assumed (spec §3)
   * ---------------------------------------------------------------- */

  /**
   * D-10, resolved: the engine joins a request's group path onto its name, so
   * the tree nests requests under their groups exactly as Gatling's own report
   * does. Five of the reference run's seven requests nest; `Search` and
   * `Place Order` genuinely have no group and stay at the root.
   */
  it('nests a request under its group, and leaves a groupless one at the root', () => {
    const requestNames = stats.stats.filter((r) => r.scope === 'request').map((r) => r.name);
    expect(requestNames.length).toBe(7);

    const tree = buildTree(stats, 'group_cumulated');
    const requests = flat(tree).filter((r) => r.scope === 'request');
    expect(requests.length).toBe(7);

    // Derived from the payload, not listed: a request is at root exactly when
    // its own name has no group prefix.
    const rootNames = requestNames.filter((n) => !n.includes('/'));
    expect(paths(tree.filter((r) => r.scope === 'request')).sort()).toEqual(rootNames.sort());
    expect(requests.filter((r) => r.depth > 0).length).toBe(requestNames.length - rootNames.length);
  });

  /**
   * Spec §3 requires the builder to cope with path-qualified request names.
   * D-10 means the reference run itself is now that case: `Related Items`
   * ships as `Catalog/Recommendations/Related Items`, joined onto the group
   * path the way group rows already were before D-10.
   */
  it('nests a request whose name IS path-qualified, exactly as the reference run has it', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const recs = find(tree, 'Catalog/Recommendations');
    expect(paths(recs.children)).toEqual(['Catalog/Recommendations/Related Items']);
    const item = find(tree, 'Catalog/Recommendations/Related Items');
    expect(item.name).toBe('Related Items');
    expect(item.depth).toBe(2);
    expect(item.scope).toBe('request');
    expect(paths(tree)).not.toContain('Catalog/Recommendations/Related Items');
  });

  /* ---------------------------------------------------------------- *
   * malformed input: the orphan
   * ---------------------------------------------------------------- */

  it('shows an orphaned path at root rather than dropping it', () => {
    // A payload whose child exists without its parent. Dropping it loses a row
    // silently, which is worse than showing it unnested.
    const orphaned = {
      ...stats,
      stats: stats.stats.filter((r) => r.name !== 'Catalog'),
    };
    const tree = buildTree(orphaned, 'group_cumulated');
    expect(tree.map((r) => r.path)).toContain('Catalog/Recommendations');
  });

  /**
   * The discriminating form. The test above checks membership at the root, so
   * it cannot tell "the orphan was promoted" apart from "nothing nests at
   * all", and it says nothing about the other nine rows — an implementation
   * that promotes the orphan while dropping `Cart` passes it.
   *
   * This asserts CONSERVATION: removing one row from the payload removes
   * exactly that row from the tree, and everything else survives, at the root
   * because its parent is gone.
   */
  it('loses nothing else when a parent is missing, and shows the orphan with its full path', () => {
    const orphaned = without((r) => r.name === 'Catalog' && r.scope === 'group');
    const tree = buildTree(orphaned, 'group_cumulated');

    expect(flat(tree).length).toBe(ALL_PATHS.length - 1);
    expect(paths(flat(tree)).sort()).toEqual(ALL_PATHS.filter((p) => p !== 'Catalog').sort());
    // Promoted to the root, at depth 0, and nested under nothing.
    const orphan = find(tree, 'Catalog/Recommendations');
    expect(orphan.depth).toBe(0);
    expect(paths(tree)).toContain('Catalog/Recommendations');
    // Its full path is its display name: there is no parent row left to supply
    // the "Catalog" half, so showing it as "Recommendations" would lose it.
    expect(orphan.name).toBe('Catalog/Recommendations');
  });

  it('orphans only as far as it must, keeping a surviving intermediate parent', () => {
    // `A/B/C` with `A` gone but `A/B` present: `A/B` is the orphan, `A/B/C`
    // still nests under it. Only the immediate prefix is consulted.
    //
    // Derived rather than hard-coded: D-10 means the reference run already
    // ships `Related Items` joined onto its group path, so this test reads
    // that joined name off the payload instead of assuming it is the bare
    // `Related Items` a pre-D-10 run would have had.
    const relatedItems = stats.stats.find(
      (r) => r.scope === 'request' && r.name.endsWith('/Related Items'),
    )!;
    const group = relatedItems.name.slice(0, relatedItems.name.lastIndexOf('/'));

    const deep = buildTree(stats, 'group_cumulated');
    expect(find(deep, relatedItems.name).depth).toBe(2);

    const cut = without((r) => r.name === 'Catalog' && r.scope === 'group');
    const tree = buildTree(cut, 'group_cumulated');
    const recs = find(tree, group);
    expect(recs.depth).toBe(0);
    expect(paths(recs.children)).toEqual([relatedItems.name]);
    expect(find(tree, relatedItems.name).depth).toBe(1);
    expect(find(tree, relatedItems.name).name).toBe('Related Items');
  });

  /* ---------------------------------------------------------------- *
   * one row per group, from the family the caller asked for
   * ---------------------------------------------------------------- */

  it('carries every row of the requested family, and none of the other', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const families = new Set(flat(tree).map((r) => r.row.family));
    expect(families.has('group_duration')).toBe(false);
    // A group appears twice in the payload; the table shows one row per group.
    const groups = flat(tree).filter((r) => r.scope === 'group');
    expect(new Set(groups.map((r) => r.path)).size).toBe(groups.length);
  });

  /**
   * The discriminating form, part one: the test above is satisfied by an EMPTY
   * tree, and by a tree with no group rows in it at all. This pins the exact
   * ten rows the reference run must produce.
   */
  it('produces exactly the ten rows the payload describes — three groups, seven requests', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const rows = flat(tree);
    expect(paths(rows).sort()).toEqual([...ALL_PATHS].sort());
    expect(rows.filter((r) => r.scope === 'group').length).toBe(3);
    expect(rows.filter((r) => r.scope === 'request').length).toBe(7);
    expect(rows.every((r) => r.scope === 'group' || r.scope === 'request')).toBe(true);
    // Ten rows out of fourteen: one group family is dropped (6 → 3) and the
    // run-scope total is not a tree row (see the test below).
    expect(rows.length).toBe(10);
    expect(stats.stats.length).toBe(14);
  });

  /**
   * The discriminating form, part two — and the one that matters most.
   *
   * `family` is the ONLY argument, and the brief's test cannot see whether it
   * was read: the payload lists `group_cumulated` before `group_duration` for
   * every group, so "take the first row for this name" produces a tree that
   * passes `families.has('group_duration') === false` while ignoring the
   * argument completely. Asking for the OTHER family, and checking a NUMBER,
   * is what fails such an implementation.
   *
   * The numbers are the captured payload's, and the two families are far
   * apart on `Cart`: cumulated min 106 / mean 141.07, duration min 188 /
   * mean 224.74 (task 1's measurement, §"the measurement — Cart").
   */
  it('reads the family argument — the same call with group_duration gives the other numbers', () => {
    const cumulated = find(buildTree(stats, 'group_cumulated'), 'Cart');
    const duration = find(buildTree(stats, 'group_duration'), 'Cart');

    expect(cumulated.row.family).toBe('group_cumulated');
    expect(duration.row.family).toBe('group_duration');
    expect(cumulated.row.minMs).toBe(106);
    expect(duration.row.minMs).toBe(188);
    expect(cumulated.row.meanMs).not.toBe(duration.row.meanMs);
    // Same shape either way: the family picks WHICH group row, never how many.
    expect(paths(flat(buildTree(stats, 'group_duration'))).sort()).toEqual([...ALL_PATHS].sort());
    // …and the keys differ, so a caller holding both cannot collide them.
    expect(cumulated.key).not.toBe(duration.key);
  });

  it('keeps the request rows out of the group-family filter', () => {
    // Requests are `response_time` in both trees — filtering the whole payload
    // by `family` rather than filtering only the duplicated group rows would
    // empty the table of requests.
    for (const family of ['group_cumulated', 'group_duration'] satisfies MetricFamily[]) {
      const rows = flat(buildTree(stats, family));
      const requests = rows.filter((r) => r.scope === 'request');
      expect(requests.length).toBe(7);
      expect(requests.every((r) => r.row.family === 'response_time')).toBe(true);
      expect(rows.filter((r) => r.scope === 'group').every((r) => r.row.family === family)).toBe(
        true,
      );
    }
  });

  /* ---------------------------------------------------------------- *
   * the run-scope row
   * ---------------------------------------------------------------- */

  /**
   * The run-scope row (`scope: 'run'`, `name: ''`) is the table's TOTAL, not a
   * tree row. Gatling renders it the same way: `index.html` puts "All
   * Requests" in its own `<table id="container_statistics_head">` and every
   * other row in `container_statistics_body`.
   *
   * Excluding it is a decision, so it is asserted rather than left to be
   * discovered — an empty-named row silently sorting to the top of the table
   * is exactly the kind of thing no other test here would notice.
   */
  it('excludes the run-scope total, which is the table header row and not a tree row', () => {
    const tree = buildTree(stats, 'group_cumulated');
    expect(flat(tree).some((r) => r.scope === 'run')).toBe(false);
    expect(paths(flat(tree))).not.toContain('');
    expect(stats.stats.filter((r) => r.scope === 'run').length).toBe(1);
  });

  /* ---------------------------------------------------------------- *
   * the row identity later tasks depend on
   * ---------------------------------------------------------------- */

  it('gives every row a stable, unique key that survives a re-build', () => {
    const once = flat(buildTree(stats, 'group_cumulated')).map((r) => r.key);
    const twice = flat(buildTree(stats, 'group_cumulated')).map((r) => r.key);
    expect(twice).toEqual(once);
    expect(new Set(once).size).toBe(once.length);
    expect(once).toContain('group:group_cumulated:Catalog/Recommendations');
    expect(once).toContain('request:response_time:Search');
  });

  it('carries the payload row through untouched, so no column is computed here', () => {
    const source = stats.stats.find((r) => r.scope === 'request' && r.name === 'Search')!;
    expect(find(buildTree(stats, 'group_cumulated'), 'Search').row).toEqual(source);
  });

  /* ---------------------------------------------------------------- *
   * degenerate payloads
   * ---------------------------------------------------------------- */

  it('returns an empty tree for a payload with no group or request rows', () => {
    expect(buildTree(without((r) => r.scope !== 'run'), 'group_cumulated')).toEqual([]);
    expect(buildTree({ ...stats, stats: [] }, 'group_cumulated')).toEqual([]);
  });

  it('keeps the first of two rows that claim the same scope, name and family', () => {
    const dupe = stats.stats.find((r) => r.scope === 'request' && r.name === 'Search')!;
    const tree = buildTree({ ...stats, stats: [...stats.stats, { ...dupe, count: 999 }] }, 'group_cumulated');
    const hits = flat(tree).filter((r) => r.path === 'Search');
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.count).toBe(dupe.count);
  });
});

/* ====================================================================== *
 * sortTree — §7 "sorting keeps children with their parent", §9 checkpoint 1
 * ====================================================================== */

/**
 * WHAT THIS BLOCK IS CAREFUL ABOUT. The brief's three example tests are, on
 * this payload, satisfied by code that does not sort at all or sorts only half
 * the tree. Measured against stubs before the implementation existed:
 *
 * - "reorders siblings without moving a child away from its parent" **passes
 *   for `sortTree = (rows) => rows`**, whatever `Catalog`'s child count is:
 *   it checks membership with `toContain`, not order, so no rearrangement of
 *   the children — correct or missing — can fail it.
 * - "sorts siblings by the requested column, descending" walks the ROOTS only.
 *   A sort that orders the roots and leaves every child list in payload order
 *   passes it — and so passes the whole brief, since the test above is the
 *   only one that looks inside a parent.
 * - "is stable for equal values" re-sorts an ALREADY-SORTED list. That is the
 *   one input on which an unstable comparator, a name tie-break, and a
 *   correct stable sort all agree. It also passes for the identity function.
 *
 * All three are kept verbatim. Each is followed by the assertion that
 * discriminates: an EXACT expected order at every level of a tree with a
 * multi-child parent, a tie-break checked from a DIFFERENT starting order than
 * the payload's, and — for parentage — a tree whose shape is not recoverable
 * from the paths alone, which is what §9 checkpoint 1's flatten-and-re-nest
 * mutation actually breaks.
 */

/** The payload with request rows given path-qualified names (the D-10 shape). */
const requestsAt = (map: Record<string, string>): StatsResponse => ({
  ...stats,
  stats: stats.stats.map((r) =>
    r.scope === 'request' && map[r.name] !== undefined ? { ...r, name: map[r.name]! } : r,
  ),
});

/** The payload with one percentile key removed from the named rows. */
const withoutPercentile = (key: string, names: readonly string[]): StatsResponse => ({
  ...stats,
  stats: stats.stats.map((r) => {
    if (!names.includes(r.name)) return r;
    const kept = Object.fromEntries(Object.entries(r.percentiles).filter(([k]) => k !== key));
    return { ...r, percentiles: kept };
  }),
});

/** `key` → the sorted paths of its children: the tree's SHAPE, order removed. */
const shapeOf = (rs: readonly TableRow[]): Map<string, string> =>
  new Map(flat(rs).map((r) => [r.key, [...paths(r.children)].sort().join('|')]));

/** Every sibling list in the tree, root first, for a sortedness sweep. */
const siblingLists = (rs: readonly TableRow[]): (readonly TableRow[])[] => [
  rs,
  ...flat(rs).map((r) => r.children),
];

const p95 = (r: TableRow) => r.row.percentiles.p95 ?? 0;

/** The `StatRow` fields that are numeric columns; everything else is a percentile key. */
const NUMERIC_FIELDS = new Set([
  'count',
  'okCount',
  'koCount',
  'errorRate',
  'minMs',
  'maxMs',
  'meanMs',
  'stddevMs',
  'throughputRps',
]);

/**
 * The test's own reading of a column, written independently of the
 * implementation's so the sweep below is not checking the sort against itself.
 * Only used with columns every row carries.
 */
const value = (r: TableRow, column: SortColumn): number =>
  (NUMERIC_FIELDS.has(column)
    ? (r.row as unknown as Record<string, number>)[column]
    : r.row.percentiles[column]) ?? 0;

describe('sortTree — siblings reorder, children stay with their parent (§7)', () => {
  /* ---------------------------------------------------------------- *
   * parentage
   * ---------------------------------------------------------------- */

  it('reorders siblings without moving a child away from its parent', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const sorted = sortTree(tree, 'p95', 'desc');
    const catalog = sorted.find((r) => r.path === 'Catalog')!;
    // The child is still under Catalog, not promoted to root by the sort.
    expect(catalog.children.map((c) => c.path)).toContain('Catalog/Recommendations');
    expect(sorted.map((r) => r.path)).not.toContain('Catalog/Recommendations');
  });

  /**
   * The discriminating form, part one: the SHAPE is preserved exactly —
   * every row keeps the same children, and the tree still holds the same ten
   * rows carrying the same `StatRow` objects at the same depths. A sort that
   * drops, duplicates or re-parents anything fails here rather than in task 5.
   */
  it('preserves the tree exactly — same rows, same parents, same depths', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const sorted = sortTree(tree, 'p95', 'desc');

    expect(shapeOf(sorted)).toEqual(shapeOf(tree));
    expect(paths(flat(sorted)).sort()).toEqual([...ALL_PATHS].sort());
    for (const before of flat(tree)) {
      const after = flat(sorted).find((r) => r.key === before.key)!;
      expect(after.depth).toBe(before.depth);
      expect(after.name).toBe(before.name);
      // The payload row is carried through by REFERENCE: the sort computes
      // nothing and copies nothing.
      expect(after.row).toBe(before.row);
    }
  });

  /**
   * The discriminating form, part two — and the one §9 checkpoint 1 needs.
   *
   * A tree whose shape is NOT recoverable from the paths alone. `buildTree`'s
   * rule is that only GROUPS adopt children, so a request that happens to be
   * named `Catalog` is a leaf beside the group of the same name, and `path` is
   * no longer a unique key. Any sort that flattens and re-nests by path sees
   * two rows at path `Catalog` and has to pick one; picking the request hands
   * it `Catalog/Recommendations` and empties the group.
   *
   * **This is the test the checkpoint needed, and one direction was not
   * enough.** Measured: the flatten-and-re-nest mutation indexes the flattened
   * rows by path and keeps the first, so it is only wrong when the REQUEST
   * sorts above the group — which `p95`/`desc` never does (2671.01 against
   * 1939.53) and `p95`/`asc` always does. The invariant is independent of the
   * column and the direction, so it is asserted over several of both.
   */
  it('keeps the child under the GROUP when a request shares the group name', () => {
    // `Search` renamed to `Catalog`: a request at the same path as the group.
    const tree = buildTree(renamed('Search', 'Catalog'), 'group_cumulated');
    const columns = ['p95', 'p50', 'minMs', 'count', 'name'] satisfies SortColumn[];
    // D-10: `Catalog` has three children of its own (the `Recommendations`
    // subgroup plus its two direct-child requests) — checked as a set here,
    // because the order among them is what the sweep test below already
    // covers; this test's job is to prove they land under the GROUP, not the
    // same-named REQUEST.
    const catalogsChildren = [
      'Catalog/List Products',
      'Catalog/Product Detail',
      'Catalog/Recommendations',
    ];

    for (const column of columns) {
      for (const direction of ['asc', 'desc'] satisfies SortDirection[]) {
        const sorted = sortTree(tree, column, direction);
        const where = `${column}/${direction}`;
        const group = sorted.find((r) => r.path === 'Catalog' && r.scope === 'group')!;
        const request = sorted.find((r) => r.path === 'Catalog' && r.scope === 'request')!;

        expect(`${where}: ${[...paths(group.children)].sort().join()}`).toBe(
          `${where}: ${catalogsChildren.join()}`,
        );
        expect(`${where}: ${paths(request.children).join()}`).toBe(`${where}: `);
        // Exactly once in the whole tree, and never at the root.
        expect(flat(sorted).filter((r) => r.path === 'Catalog/Recommendations').length).toBe(1);
        expect(paths(sorted)).not.toContain('Catalog/Recommendations');
      }
    }
  });

  /**
   * The other shape the paths cannot express: the ORPHAN. `Catalog/Recommendations`
   * with no `Catalog` is a ROOT at depth 0 showing its full path, and sorting
   * must not re-derive any of that from its two path segments (task 2's
   * mutation E, and this brief's standing warning: key on `row.depth`).
   */
  it('leaves an orphan at the root, at depth 0, with its full path as its name', () => {
    const tree = buildTree(without((r) => r.name === 'Catalog' && r.scope === 'group'), 'group_cumulated');
    const sorted = sortTree(tree, 'p95', 'desc');

    const orphan = find(sorted, 'Catalog/Recommendations');
    expect(paths(sorted)).toContain('Catalog/Recommendations');
    expect(orphan.depth).toBe(0);
    expect(orphan.name).toBe('Catalog/Recommendations');
    // D-10: with `Catalog` gone, its two direct-child requests
    // (`Catalog/List Products`, `Catalog/Product Detail`) are orphaned too,
    // alongside the subgroup — six roots where the full tree has four.
    expect(flat(sorted).length).toBe(ALL_PATHS.length - 1);
    // Sorted on its merits, at the top: with `Catalog` (p95 2671.01) gone,
    // the orphaned `Catalog/Recommendations` (2515.46) is the largest of the
    // survivors.
    expect(paths(sorted)[0]).toBe('Catalog/Recommendations');
  });

  /* ---------------------------------------------------------------- *
   * the order itself
   * ---------------------------------------------------------------- */

  it('sorts siblings by the requested column, descending', () => {
    const sorted = sortTree(buildTree(stats, 'group_cumulated'), 'p95', 'desc');
    for (let i = 1; i < sorted.length; i++) {
      expect(p95(sorted[i - 1]!)).toBeGreaterThanOrEqual(p95(sorted[i]!));
    }
  });

  /**
   * The discriminating form: the EXACT root order, from the captured payload's
   * own p95 figures, and ascending as its exact reverse. The pairwise loop
   * above passes for any tree whose roots happen to be non-increasing; this
   * fails for anything but the one right answer.
   */
  it('puts the roots in exactly the order the payload s p95 figures dictate', () => {
    const tree = buildTree(stats, 'group_cumulated');
    // D-10 leaves only four roots: Catalog 2671.01, Search 1939.53,
    // Cart 172.45, Place Order 92.77. The other five requests, and their
    // p95 figures, now sort inside `Cart` and `Catalog`'s own child lists —
    // see "sorts the children of a parent too" below.
    const worstFirst = ['Catalog', 'Search', 'Cart', 'Place Order'];
    expect(paths(sortTree(tree, 'p95', 'desc'))).toEqual(worstFirst);
    expect(paths(sortTree(tree, 'p95', 'asc'))).toEqual([...worstFirst].reverse());
  });

  /**
   * The one the brief's tests cannot reach: a parent with MORE THAN ONE child.
   * D-10 means the reference run itself now gives `Catalog` three — the
   * `Recommendations` subgroup and its two direct-child requests — so this
   * is no longer a synthetic payload; it is `stats` unchanged, and it is the
   * only input here on which "sort the roots and forget to recurse" is
   * visible.
   */
  it('sorts the children of a parent too, not just the roots', () => {
    const tree = buildTree(stats, 'group_cumulated');
    // Payload order under Catalog: the group row first, then the two requests.
    const catalogBefore = find(tree, 'Catalog');
    expect(paths(catalogBefore.children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);

    const desc = sortTree(tree, 'p95', 'desc');
    // Recommendations 2515.46, Product Detail 295.93, List Products 41.68.
    expect(paths(find(desc, 'Catalog').children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/Product Detail',
      'Catalog/List Products',
    ]);
    expect(paths(desc)).toEqual(['Catalog', 'Search', 'Cart', 'Place Order']);
    // Two levels down is sorted as well, and still two levels down.
    expect(find(desc, 'Catalog/Recommendations/Related Items').depth).toBe(2);

    const asc = sortTree(tree, 'p95', 'asc');
    expect(paths(find(asc, 'Catalog').children)).toEqual([
      'Catalog/List Products',
      'Catalog/Product Detail',
      'Catalog/Recommendations',
    ]);
  });

  /** Every sibling list at every depth, swept generically for both directions. */
  it('leaves every sibling list in the tree non-increasing, and asc non-decreasing', () => {
    const tree = buildTree(stats, 'group_cumulated');
    for (const column of ['count', 'meanMs', 'maxMs', 'errorRate', 'p50', 'p99'] satisfies SortColumn[]) {
      for (const direction of ['asc', 'desc'] satisfies SortDirection[]) {
        for (const siblings of siblingLists(sortTree(tree, column, direction))) {
          for (let i = 1; i < siblings.length; i++) {
            const a = value(siblings[i - 1]!, column);
            const b = value(siblings[i]!, column);
            if (direction === 'desc') expect(a).toBeGreaterThanOrEqual(b);
            else expect(a).toBeLessThanOrEqual(b);
          }
        }
      }
    }
  });

  /* ---------------------------------------------------------------- *
   * stability
   * ---------------------------------------------------------------- */

  it('is stable for equal values, so a re-sort does not shuffle', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const once = sortTree(tree, 'count', 'desc').map((r) => r.path);
    const twice = sortTree(sortTree(tree, 'count', 'desc'), 'count', 'desc').map((r) => r.path);
    expect(twice).toEqual(once);
  });

  /**
   * The discriminating form. Re-sorting an already-sorted list is the one
   * input on which every comparator agrees, and the test above also passes for
   * a sort that does nothing. Stability means TIES KEEP THE ORDER THEY CAME
   * IN, so it can only be seen from an incoming order that is not the one the
   * comparator would produce anyway.
   *
   * `count` has exactly two values in the reference run — 160 and 85 — so
   * sorting by it is almost entirely ties. Sorted by p95 ascending FIRST, then
   * by count descending, the two blocks must come out in p95-ascending order.
   * An implementation that re-reads the payload, or tie-breaks on the name,
   * gives the payload/alphabetical order instead.
   */
  it('carries ties in the order they arrived, not the payload s or the alphabet s', () => {
    const tree = buildTree(stats, 'group_cumulated');

    // From payload order: ties fall out in payload order. (D-10 leaves four
    // roots: Catalog and Search at count 160, Cart and Place Order at 85.)
    expect(paths(sortTree(tree, 'count', 'desc'))).toEqual([
      'Catalog',
      'Search',
      'Cart',
      'Place Order',
    ]);
    // From p95-ascending order: the SAME two blocks, each in p95-ascending
    // order. Nothing about the payload or the alphabet produces this.
    const byP95 = sortTree(tree, 'p95', 'asc');
    expect(paths(sortTree(byP95, 'count', 'desc'))).toEqual([
      'Search',
      'Catalog',
      'Place Order',
      'Cart',
    ]);
    // Ascending is the same tie order, not its reverse: the direction applies
    // to the VALUES, and ties are not values.
    expect(paths(sortTree(byP95, 'count', 'asc'))).toEqual([
      'Place Order',
      'Cart',
      'Search',
      'Catalog',
    ]);
  });

  /* ---------------------------------------------------------------- *
   * purity — the sort is a transform, not a mutation
   * ---------------------------------------------------------------- */

  /**
   * `sortTree` takes `readonly TableRow[]`, and TypeScript stops there:
   * `(rows as TableRow[]).sort()` type-checks nowhere but `rows.sort()` on an
   * array the caller still holds is one keystroke away, and every test above
   * would still pass while the caller's tree silently reordered underneath a
   * React render.
   */
  it('does not touch the tree it was given, at any depth', () => {
    const tree = buildTree(stats, 'group_cumulated');
    const pristine = buildTree(stats, 'group_cumulated');

    sortTree(tree, 'p95', 'desc');
    sortTree(tree, 'count', 'asc');
    sortTree(tree, 'name', 'desc');

    expect(tree).toEqual(pristine);
    expect(paths(tree)).toEqual(paths(pristine));
    expect(paths(find(tree, 'Catalog').children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);
  });

  /* ---------------------------------------------------------------- *
   * the name column, and the columns that can be absent
   * ---------------------------------------------------------------- */

  it('sorts by the displayed name, case-insensitively, in both directions', () => {
    const tree = buildTree(stats, 'group_cumulated');
    // D-10 leaves four roots; the five nested requests sort inside their
    // parents' own child lists, covered elsewhere.
    const alphabetical = ['Cart', 'Catalog', 'Place Order', 'Search'];
    expect(paths(sortTree(tree, 'name', 'asc'))).toEqual(alphabetical);
    expect(paths(sortTree(tree, 'name', 'desc'))).toEqual([...alphabetical].reverse());

    // Every name in the reference run is Title Case, so it cannot tell a
    // case-INSENSITIVE sort from a case-sensitive one — measured: making the
    // comparison case-sensitive changed nothing and failed no test. A payload
    // with mixed case can: ASCII order puts every capital ahead of every
    // lowercase letter, which is how a table ends up listing `apple pie`
    // after `Catalog` and reading as broken. (`Search` and `Place Order` are
    // the only two bare — groupless — requests D-10 leaves to rename here;
    // the other five now carry a group prefix and are not roots at all.)
    const mixed = buildTree(
      requestsAt({ Search: 'apple pie', 'Place Order': 'Banana' }),
      'group_cumulated',
    );
    expect(paths(sortTree(mixed, 'name', 'asc'))).toEqual(['apple pie', 'Banana', 'Cart', 'Catalog']);
  });

  /**
   * A percentile column exists only if the payload has that key, and the keys
   * are per-row (`Record<string, number>`). A row without the sorted key has
   * no value on that column — it is not a row whose p99 is zero — so it sorts
   * to the END whichever way the arrow points, rather than into the "fastest"
   * slot at 0 where a reader would read it as the best in the table.
   */
  it('sends rows missing the sorted percentile to the end, in both directions', () => {
    // `Search` and `Place Order` are the two bare — groupless — requests
    // D-10 leaves at the root; they are also the only two rows this test can
    // strip a percentile from and still see the effect at the root level.
    const tree = buildTree(withoutPercentile('p99', ['Search', 'Place Order']), 'group_cumulated');
    expect(find(tree, 'Search').row.percentiles.p99).toBeUndefined();

    for (const direction of ['asc', 'desc'] satisfies SortDirection[]) {
      const sorted = paths(sortTree(tree, 'p99', direction));
      // Last two, and in the order they arrived — missing is not a value to
      // sort by, so the ties among them are ties.
      expect(sorted.slice(-2)).toEqual(['Place Order', 'Search']);
      expect(sorted.length).toBe(4);
    }
    // The rows that DO have the key are ordered on it as usual.
    expect(paths(sortTree(tree, 'p99', 'desc')).slice(0, 2)).toEqual(['Catalog', 'Cart']);
  });

  it('returns an empty tree for an empty tree, and is a no-op on a single row', () => {
    expect(sortTree([], 'p95', 'desc')).toEqual([]);
    const one = sortTree(buildTree(without((r) => r.name !== 'Search'), 'group_cumulated'), 'count', 'desc');
    expect(paths(one)).toEqual(['Search']);
  });
});

/* ====================================================================== *
 * filterTree — the match keeps its ancestors (§7), §9 checkpoint 2
 * ====================================================================== */

/**
 * WHAT THIS BLOCK IS CAREFUL ABOUT — and this time it was MEASURED, by running
 * the brief's four example tests against nine deliberately wrong
 * implementations of `filterTree` (results in the task 4 report):
 *
 * - **Two of the four cannot fail at all.** "returns nothing for a query that
 *   matches nothing" and "is case-insensitive" passed for ALL NINE, including
 *   `filterTree = () => []` — a filter that empties the table for every query,
 *   the single worst thing this function can do — and `(rows) => rows`, which
 *   never filters anything. The case test compares two filtered results TO
 *   EACH OTHER and never to an expected value, so any filter that ignores its
 *   query satisfies it, and so does the near miss that matters: one that
 *   lowercases the QUERY but not the ROW, since every path in this payload is
 *   Title Case and `'catalog'` then matches nothing either way.
 * - The other two catch the coarse mutations — the empty filter, the half-case
 *   comparison, and §9 checkpoint 2's promote-matches-to-root — and MISS five
 *   real ones: keeping every child of a surviving ancestor instead of pruning
 *   to the matching branch (a single-child parent can't tell the two apart —
 *   D-10 gives `Catalog` three children in the reference run itself, which is
 *   what exercises this gap directly, rather than needing a synthetic
 *   payload for it), matching the displayed leaf instead of the full path,
 *   not trimming the query, reading the query as a REGEX, and mutating the
 *   caller's tree in place.
 *
 * All four are kept verbatim, because they pin the intended shape. Each is
 * followed by the assertion that can fail: an EXACT surviving path set rather
 * than a membership or a length check, a case test against a LITERAL
 * expectation on a mixed-case payload, a matches-nothing test that first
 * proves the same tree is non-empty for a query that does match, and — for
 * ancestors — a multi-child parent (the D-10 shape) where keeping the branch
 * and keeping the subtree differ.
 */

/** Request names path-qualified two levels down, for the ancestor CHAIN cases. */
const deepPayload = (): StatsResponse =>
  requestsAt({ 'Related Items': 'Catalog/Recommendations/Related Items' });

/** The D-10 shape: `Catalog` with three children, so a branch is not a subtree. */
const widePayload = (): StatsResponse =>
  requestsAt({
    'List Products': 'Catalog/List Products',
    'Product Detail': 'Catalog/Product Detail',
    'Related Items': 'Catalog/Recommendations/Related Items',
  });

describe('filterTree — a match keeps its context (§7, checkpoint 2)', () => {
  /* ---------------------------------------------------------------- *
   * ancestors
   * ---------------------------------------------------------------- */

  it('keeps the ancestors of a match, so the match keeps its context', () => {
    const filtered = filterTree(buildTree(stats, 'group_cumulated'), 'Recommendations');
    expect(filtered.map((r) => r.path)).toEqual(['Catalog']);
    expect(filtered[0]!.children.map((c) => c.path)).toEqual(['Catalog/Recommendations']);
  });

  /**
   * The discriminating form. The test above pins the two rows it names; this
   * pins that they are the ONLY two, that the kept ancestor is kept AS AN
   * ANCESTOR (depth 0, its own children pruned to the matching branch) and not
   * as a match in its own right, and that the match is still nested rather
   * than promoted — which is exactly what §9 checkpoint 2 breaks.
   */
  it('keeps the ancestor and nothing else, with the branch pruned to the match', () => {
    const filtered = filterTree(buildTree(widePayload(), 'group_cumulated'), 'Recommendations');

    // `Catalog` has three children in this payload. Only the matching branch
    // survives: an implementation that keeps a surviving row's whole subtree
    // hands back `Catalog/List Products` and `Catalog/Product Detail` too.
    expect(paths(filtered)).toEqual(['Catalog']);
    expect(paths(find(filtered, 'Catalog').children)).toEqual(['Catalog/Recommendations']);
    // The match's own subtree comes with it — `Related Items` is under
    // `Catalog/Recommendations` here, and its path contains the query too.
    expect(paths(flat(filtered))).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
    expect(paths(filtered)).not.toContain('Catalog/Recommendations');
    expect(find(filtered, 'Catalog').depth).toBe(0);
    expect(find(filtered, 'Catalog/Recommendations').depth).toBe(1);
  });

  /**
   * The whole ancestor CHAIN, not just the parent. A match two levels down
   * keeps both rows above it, in order, at their original depths — the shape
   * a single `parentPathOf` hop would get wrong.
   */
  it('keeps every ancestor of a match, not only the nearest one', () => {
    const filtered = filterTree(buildTree(deepPayload(), 'group_cumulated'), 'Related');

    expect(paths(flat(filtered))).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
    expect(flat(filtered).map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(find(filtered, 'Catalog/Recommendations/Related Items').scope).toBe('request');
  });

  it('keeps a matching parent whole, with its children', () => {
    const filtered = filterTree(buildTree(stats, 'group_cumulated'), 'Catalog');
    const catalog = filtered.find((r) => r.path === 'Catalog')!;
    expect(catalog.children.length).toBeGreaterThan(0);
  });

  /**
   * The discriminating form: `Catalog` with THREE children, all of them kept,
   * including the grandchild — a match takes its whole subtree with it.
   * `length > 0` above cannot see the difference on the reference run, where
   * `Catalog` has one child and any filter that keeps the parent at all keeps
   * a non-empty list.
   */
  it('keeps a matching parent s whole subtree, every child and grandchild', () => {
    const filtered = filterTree(buildTree(widePayload(), 'group_cumulated'), 'Catalog');

    expect(paths(filtered)).toEqual(['Catalog']);
    expect(paths(find(filtered, 'Catalog').children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);
    expect(paths(flat(filtered)).sort()).toEqual([
      'Catalog',
      'Catalog/List Products',
      'Catalog/Product Detail',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
  });

  /* ---------------------------------------------------------------- *
   * what a query matches: the PATH, and as a literal substring
   * ---------------------------------------------------------------- */

  /**
   * **The decision this file pins: the query is matched against `path`, the
   * full name, not against `name`, the displayed leaf.** See the rationale in
   * `filterTree`. Typing `Catalog/Rec` must find `Catalog/Recommendations`;
   * against the leaf it finds nothing.
   */
  it('matches the full path, so a path-shaped query finds a nested row', () => {
    const tree = buildTree(stats, 'group_cumulated');

    expect(paths(flat(filterTree(tree, 'Catalog/Rec')))).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
    // A bare separator matches every row whose path HAS one — no root does,
    // and D-10 gives most nested rows one, group and request alike.
    expect(paths(flat(filterTree(tree, '/')))).toEqual([
      'Cart',
      'Cart/Add To Cart',
      'Cart/View Cart',
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);
    // …and the leaf still matches, because a leaf is a substring of its path.
    expect(paths(flat(filterTree(tree, 'ecommend')))).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
  });

  /**
   * The match is a SUBSTRING of the path and nothing else: not the key, not
   * the family, not the scope. `key` is `${scope}:${family}:${name}`, so a
   * filter matching on it returns all three groups for `group_cumulated` and
   * all seven requests for `request` — a table that answers a query about
   * nothing the reader typed.
   */
  it('matches the path only — not the key, the family or the scope', () => {
    const tree = buildTree(stats, 'group_cumulated');
    expect(filterTree(tree, 'group_cumulated')).toEqual([]);
    expect(filterTree(tree, 'request')).toEqual([]);
    expect(filterTree(tree, 'response_time')).toEqual([]);
    // The keys really do contain those strings: the assertions above are live.
    expect(flat(tree).map((r) => r.key)).toContain('group:group_cumulated:Catalog');
  });

  /**
   * Substring, LITERALLY — regex is out of scope for this piece (design §7),
   * so a query full of metacharacters is a query for those characters. Read
   * as a pattern, `.*` matches every row and `Cata.og` matches `Catalog`;
   * read as text, neither matches anything, because no path contains a dot.
   */
  it('treats the query as literal text, not a pattern', () => {
    const tree = buildTree(stats, 'group_cumulated');
    expect(filterTree(tree, '.*')).toEqual([]);
    expect(filterTree(tree, 'Cata.og')).toEqual([]);
    expect(filterTree(tree, '^Cart$')).toEqual([]);
    expect(filterTree(tree, '(')).toEqual([]);
    // The same tree is not empty for the literal spelling: `Cart` matches
    // itself and both of its own children, which is the whole subtree.
    expect(paths(flat(filterTree(tree, 'Cart')))).toEqual([
      'Cart',
      'Cart/Add To Cart',
      'Cart/View Cart',
    ]);
  });

  /* ---------------------------------------------------------------- *
   * case
   * ---------------------------------------------------------------- */

  it('is case-insensitive', () => {
    const lower = filterTree(buildTree(stats, 'group_cumulated'), 'catalog');
    const upper = filterTree(buildTree(stats, 'group_cumulated'), 'CATALOG');
    expect(lower.map((r) => r.path)).toEqual(upper.map((r) => r.path));
  });

  /**
   * The discriminating form. The test above compares two filtered results to
   * each other and never to an expected value, so it passes for `() => []`,
   * for `(rows) => rows`, and — the failure a reader would actually hit — for
   * a filter that lowercases the QUERY but compares it against the row's
   * original case. Every path in the reference run is Title Case, so that bug
   * is invisible until a lowercase path exists to match a lowercase query.
   */
  it('lowercases BOTH sides — an expected result, on a mixed-case payload', () => {
    const tree = buildTree(stats, 'group_cumulated');
    // `Catalog` itself matches, so its whole subtree — the two direct-child
    // requests D-10 gives it, and the `Recommendations` branch — comes along.
    const expected = [
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ];
    for (const query of ['catalog', 'CATALOG', 'Catalog', 'cAtAlOg']) {
      expect(`${query}: ${paths(flat(filterTree(tree, query))).join()}`).toBe(
        `${query}: ${expected.join()}`,
      );
    }

    // A payload with lowercase paths: an UPPERCASE query must still find
    // them. `Search` and `Place Order` are D-10's two groupless requests —
    // the only ones a rename here can turn into distinct roots.
    const mixed = buildTree(
      requestsAt({ Search: 'apple pie', 'Place Order': 'Banana' }),
      'group_cumulated',
    );
    expect(paths(filterTree(mixed, 'APPLE'))).toEqual(['apple pie']);
    expect(paths(filterTree(mixed, 'apple'))).toEqual(['apple pie']);
    expect(paths(filterTree(mixed, 'BANANA'))).toEqual(['Banana']);
    expect(paths(filterTree(mixed, 'banana'))).toEqual(['Banana']);
  });

  /* ---------------------------------------------------------------- *
   * the empty query, and the query that matches nothing
   * ---------------------------------------------------------------- */

  it('returns nothing for a query that matches nothing', () => {
    expect(filterTree(buildTree(stats, 'group_cumulated'), 'zzz-no-such-row')).toEqual([]);
  });

  /**
   * The discriminating form: the SAME tree, filtered by a query that does
   * match, is not empty — which `filterTree = () => []` cannot satisfy — and
   * the near-miss queries are one character away from a real path rather than
   * a string no implementation could match.
   */
  it('empties the table only for a query no path contains', () => {
    const tree = buildTree(stats, 'group_cumulated');
    expect(flat(tree).length).toBe(10);

    // `'Cart '` is deliberately NOT in this list: the query is trimmed, so a
    // trailing space still finds `Cart` (see the trimming test below). `'Cart/'`
    // is deliberately NOT in this list either, post-D-10: `Cart` now has real
    // children whose paths start with `Cart/`, so that query hits.
    for (const miss of ['zzz-no-such-row', 'Catalogg', 'Catalog//Recommendations', 'xCart']) {
      expect(`${miss}: ${paths(flat(filterTree(tree, miss))).join()}`).toBe(`${miss}: `);
    }
    // …and the tree it just emptied is full for a query that hits.
    expect(paths(flat(filterTree(tree, 'ar'))).length).toBeGreaterThan(0);
    expect(paths(flat(filterTree(tree, 'Search')))).toEqual(['Search']);
  });

  /**
   * THE NON-NUMERIC CHECKPOINT §8 NAMES: "a filter that matches everything".
   * An empty box is not a query — it is the absence of one — and the table
   * with no filter typed is the whole table. A filter that reads `''` as a
   * query still matches every path (every string contains `''`), so this
   * would pass by accident; the assertions below pin the tree back IDENTICALLY,
   * shape and all, which a filter that rebuilds or reorders rows would not.
   */
  it('returns the whole tree, unchanged, for an empty or blank query', () => {
    const tree = buildTree(stats, 'group_cumulated');
    for (const blank of ['', ' ', '   ', '\t', '\n']) {
      const filtered = filterTree(tree, blank);
      expect(`${JSON.stringify(blank)}: ${paths(flat(filtered)).join()}`).toBe(
        `${JSON.stringify(blank)}: ${paths(flat(tree)).join()}`,
      );
      expect(filtered).toEqual(tree);
      expect(shapeOf(filtered)).toEqual(shapeOf(tree));
    }
    expect(paths(flat(filterTree(tree, ''))).sort()).toEqual([...ALL_PATHS].sort());
  });

  /**
   * Surrounding whitespace is typing, not intent: a query pasted with a
   * trailing space, or typed after one, means the word. Interior spaces are
   * part of the query — `Add To Cart` has two of them.
   */
  it('trims the query at its ends and keeps the spaces inside it', () => {
    const tree = buildTree(stats, 'group_cumulated');
    expect(paths(filterTree(tree, '  Catalog  '))).toEqual(['Catalog']);
    // `Add To Cart` is `Cart/Add To Cart` post-D-10 — no longer a root, so
    // its match keeps `Cart` above it as context.
    expect(paths(flat(filterTree(tree, 'To Cart')))).toEqual(['Cart', 'Cart/Add To Cart']);
    expect(paths(flat(filterTree(tree, ' To Cart ')))).toEqual(['Cart', 'Cart/Add To Cart']);
  });

  /* ---------------------------------------------------------------- *
   * exact surviving sets, and the order they survive in
   * ---------------------------------------------------------------- */

  /**
   * Every root that matches, in the order the tree had them — filtering is not
   * a sort, and a filter that rebuilt the list from a map or a set would say
   * otherwise. `Catalog` is absent from the `Cart` result: substring, not
   * fuzzy.
   */
  it('keeps the surviving rows in their original sibling order', () => {
    const tree = buildTree(stats, 'group_cumulated');
    // `Cart` matches itself; its two children are nested under it, not
    // separate roots, post-D-10.
    expect(paths(filterTree(tree, 'Cart'))).toEqual(['Cart']);
    // `p`: matches `Catalog` (via its two direct-child requests, both of
    // which have "Products"/"Product" in their path) and `Place Order`, in
    // their original root order. `Cart` and `Search` have no `p` anywhere in
    // their own subtree and are gone.
    expect(paths(filterTree(tree, 'p'))).toEqual(['Catalog', 'Place Order']);
    expect(paths(flat(filterTree(tree, 'p')))).toEqual([
      'Catalog',
      'Catalog/List Products',
      'Catalog/Product Detail',
      'Place Order',
    ]);
    // `Catalog/Recommendations` has no `p` anywhere in its own branch, so it
    // is the one child of `Catalog` that does not survive.
    expect(paths(flat(filterTree(tree, 'p')))).not.toContain('Catalog/Recommendations');
  });

  it('filters the children of a surviving parent too, not just the roots', () => {
    const filtered = filterTree(buildTree(widePayload(), 'group_cumulated'), 'Products');
    expect(paths(flat(filtered))).toEqual(['Catalog', 'Catalog/List Products']);
  });

  /* ---------------------------------------------------------------- *
   * the rows themselves come through untouched
   * ---------------------------------------------------------------- */

  /**
   * A surviving row is the SAME row: same key, same depth, same displayed
   * name, and the same `StatRow` by reference. `depth` in particular is the
   * row's position in the ORIGINAL tree and is not renumbered by the filter —
   * a kept ancestor is still depth 0, and a match kept at depth 1 does not
   * become a root because its siblings left.
   */
  it('carries every surviving row through untouched — key, depth, name, row', () => {
    const tree = buildTree(widePayload(), 'group_cumulated');
    const byKey = new Map(flat(tree).map((r) => [r.key, r]));

    for (const query of ['a', 'Catalog', 'Recommendations', 'Cart', '/']) {
      for (const row of flat(filterTree(tree, query))) {
        const original = byKey.get(row.key)!;
        expect(`${query}: ${row.key}`).toBe(`${query}: ${original.key}`);
        expect(row.depth).toBe(original.depth);
        expect(row.name).toBe(original.name);
        expect(row.scope).toBe(original.scope);
        expect(row.row).toBe(original.row);
      }
    }
  });

  /**
   * The orphan again (task 2's rule, task 3's mutation E): `Catalog/Recommendations`
   * with no `Catalog` is a ROOT at depth 0 whose displayed name is its full
   * path. The filter must not re-derive depth or name from the path's two
   * segments — keyed on `row.depth`, never on a segment count.
   */
  it('leaves an orphaned match at the root, at depth 0, with its full path as its name', () => {
    const tree = buildTree(without((r) => r.name === 'Catalog' && r.scope === 'group'), 'group_cumulated');
    const filtered = filterTree(tree, 'Recommendations');

    // The orphaned `Catalog/Recommendations` itself matches, so its own
    // child — `Related Items`, nested one level under it post-D-10 — comes
    // along as part of its subtree.
    expect(paths(flat(filtered))).toEqual([
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
    const orphan = find(filtered, 'Catalog/Recommendations');
    expect(orphan.depth).toBe(0);
    expect(orphan.name).toBe('Catalog/Recommendations');
    // There is no `Catalog` row to keep as its ancestor, and none is invented.
    expect(paths(flat(filtered))).not.toContain('Catalog');
  });

  /* ---------------------------------------------------------------- *
   * purity, and composition with the sort
   * ---------------------------------------------------------------- */

  it('does not touch the tree it was given, at any depth', () => {
    const tree = buildTree(widePayload(), 'group_cumulated');
    const pristine = buildTree(widePayload(), 'group_cumulated');

    filterTree(tree, 'Recommendations');
    filterTree(tree, 'Catalog');
    filterTree(tree, '');
    filterTree(tree, 'zzz');

    expect(tree).toEqual(pristine);
    expect(paths(flat(tree)).length).toBe(10);
    expect(paths(find(tree, 'Catalog').children)).toEqual([
      'Catalog/Recommendations',
      'Catalog/List Products',
      'Catalog/Product Detail',
    ]);
  });

  /**
   * Task 5 composes the two: the table sorts what it filtered. Neither order
   * of composition may lose the ancestor or promote the match.
   */
  it('composes with the sort in either order, keeping the match nested', () => {
    const tree = buildTree(widePayload(), 'group_cumulated');

    const filteredThenSorted = sortTree(filterTree(tree, 'Products'), 'p95', 'desc');
    const sortedThenFiltered = filterTree(sortTree(tree, 'p95', 'desc'), 'Products');

    for (const result of [filteredThenSorted, sortedThenFiltered]) {
      expect(paths(flat(result))).toEqual(['Catalog', 'Catalog/List Products']);
      expect(find(result, 'Catalog/List Products').depth).toBe(1);
    }
  });

  /* ---------------------------------------------------------------- *
   * degenerate input
   * ---------------------------------------------------------------- */

  it('returns an empty tree for an empty tree, whatever the query', () => {
    expect(filterTree([], 'Catalog')).toEqual([]);
    expect(filterTree([], '')).toEqual([]);
  });
});
