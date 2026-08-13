import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { buildTree, type MetricFamily, type TableRow } from '../src/tables/buildTree.js';
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
 */
const ALL_PATHS = [
  'Cart',
  'Catalog',
  'Catalog/Recommendations',
  'Add To Cart',
  'List Products',
  'Place Order',
  'Product Detail',
  'Related Items',
  'Search',
  'View Cart',
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
    expect(paths(catalog.children)).toEqual(['Catalog/Recommendations']);
    expect(paths(tree)).not.toContain('Catalog/Recommendations');
    expect(catalog.depth).toBe(0);
    expect(find(tree, 'Catalog/Recommendations').depth).toBe(1);
    // …and the child carries no children of its own: `Related Items` is a
    // request, and in this payload requests do not nest (see below).
    expect(find(tree, 'Catalog/Recommendations').children).toEqual([]);
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
   * **Measured against the captured payload: request names carry no group
   * path.** All seven — `Add To Cart`, `List Products`, `Place Order`,
   * `Product Detail`, `Related Items`, `Search`, `View Cart` — are bare leaf
   * names, and not one contains a `/`. So a request cannot be associated with
   * the group it ran in, and every request sits at the root beside the
   * top-level groups.
   *
   * This is a PARITY GAP, not a design choice: Gatling's own global statistics
   * table nests five of these seven under their groups. See the task report.
   * The gap is upstream of this file — `RequestEvent.groups` is parsed and
   * then dropped by the statistics engine — and no mapping from request name
   * to group is invented here to paper over it.
   */
  it('puts every request at the root, because request names carry no group path', () => {
    const requestNames = stats.stats.filter((r) => r.scope === 'request').map((r) => r.name);
    expect(requestNames.length).toBe(7);
    expect(requestNames.filter((n) => n.includes('/'))).toEqual([]);

    const tree = buildTree(stats, 'group_cumulated');
    const requests = flat(tree).filter((r) => r.scope === 'request');
    expect(requests.length).toBe(7);
    expect(requests.every((r) => r.depth === 0)).toBe(true);
    expect(paths(tree.filter((r) => r.scope === 'request')).sort()).toEqual(requestNames.sort());
  });

  /**
   * Spec §3 requires the builder to cope with path-qualified request names
   * "in some runs and not others". The reference run is the "not" case, so
   * the "is" case needs a payload the reference run does not supply. The
   * rename is a well-formed input, not a doctored one: it is exactly what the
   * statistics engine would emit if it joined `RequestEvent.groups` onto the
   * request name the way it already does for group rows.
   */
  it('nests a request whose name IS path-qualified, when a payload has one', () => {
    const tree = buildTree(renamed('Related Items', 'Catalog/Recommendations/Related Items'), 'group_cumulated');
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
    const deep = buildTree(
      renamed('Related Items', 'Catalog/Recommendations/Related Items'),
      'group_cumulated',
    );
    expect(find(deep, 'Catalog/Recommendations/Related Items').depth).toBe(2);

    const cut = without((r) => r.name === 'Catalog' && r.scope === 'group');
    const tree = buildTree(
      { ...cut, stats: cut.stats.map((r) =>
        r.scope === 'request' && r.name === 'Related Items'
          ? { ...r, name: 'Catalog/Recommendations/Related Items' }
          : r,
      ) },
      'group_cumulated',
    );
    const recs = find(tree, 'Catalog/Recommendations');
    expect(recs.depth).toBe(0);
    expect(paths(recs.children)).toEqual(['Catalog/Recommendations/Related Items']);
    expect(find(tree, 'Catalog/Recommendations/Related Items').depth).toBe(1);
    expect(find(tree, 'Catalog/Recommendations/Related Items').name).toBe('Related Items');
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
