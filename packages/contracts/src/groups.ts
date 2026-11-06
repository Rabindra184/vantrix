/**
 * ═══ ONE RULE FOR WHICH REQUESTS A GROUP HOLDS ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md §3)
 *
 * A request's identity is its joined name, `[...groups, name].join('/')`, and a
 * group's is `groups.join('/')` (`packages/statistics/src/engine.ts`). Nothing
 * stored says which group a request row belongs to, so membership is read off
 * the names — here, once, because the Report's picker lists a group's requests
 * in the browser and the API merges that same group's series on the server, and
 * the two must not disagree about which requests they mean.
 *
 *   - A request is in group `G` when its name starts with `G + '/'` and `G` is
 *     one of the run's own group names. Subgroups are included: `Catalog` takes
 *     `Catalog/Recommendations/Related Items` too, as Gatling's own group
 *     figures do. `G` is never matched as a bare prefix — `Car` holds nothing.
 *   - `''` is "(no group)": every request whose name starts with no known group.
 *     A top-level `/login` is there, because its leading `/` names no group.
 *   - KNOWN LIMIT, recorded rather than fixed: a top-level request literally
 *     named `Cart/x` beside a group `Cart` is counted in `Cart`. The joined name
 *     has already lost the distinction, and every surface keyed on it (the
 *     request drill-down, G-05's path matching) shares the limit.
 *   - An unknown group has no members.
 *
 * Pure and dependency-free, so the API and the web import the same code.
 */

/** The longest of `groupNames` that `requestName` sits inside, or `''` when it
 *  sits in none. */
export function innermostGroup(requestName: string, groupNames: readonly string[]): string {
  let innermost = '';
  for (const group of groupNames) {
    if (group.length > innermost.length && requestName.startsWith(`${group}/`)) {
      innermost = group;
    }
  }
  return innermost;
}

/** The requests `group` holds, subgroups included, in `requestNames` order.
 *  `group === ''` means the requests that sit in no group. A fresh array each
 *  call. */
export function requestsInGroup(
  requestNames: readonly string[],
  groupNames: readonly string[],
  group: string,
): string[] {
  if (group === '') {
    return requestNames.filter((name) => innermostGroup(name, groupNames) === '');
  }
  if (!groupNames.includes(group)) return [];
  const prefix = `${group}/`;
  return requestNames.filter((name) => name.startsWith(prefix));
}

/** A group path as a reader sees it: `Catalog / Recommendations`, and
 *  `(no group)` for `''`. */
export function displayPath(path: string): string {
  return path === '' ? '(no group)' : path.split('/').join(' / ');
}
