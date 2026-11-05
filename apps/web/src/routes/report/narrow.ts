import type { StatRow, StatsResponse, UsersResponse } from '@perfportal/contracts';

/**
 * ═══ WHAT THE REPORT TAKES FROM /stats AND /users UNDER A PICK, NARROWED HERE ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, sections 4 and 5)
 *
 * `/stats` does not change for the pickers. Everything the Requests section
 * draws from it under a pick is ADDITIVE — request counts, OK/KO counts and the
 * indicator bands, which are counts of responses under, between and over the
 * bounds and failed — so a group's is the sum of its members' own rows, read
 * off the payload the section already holds. Virtual users already carries one
 * series per scenario. Neither needs a request of its own.
 *
 * Pure, and a fresh object each call: the payloads come out of the query cache
 * under `staleTime: Infinity`, and writing into one would change what every
 * other observer of that entry draws.
 */

/** The four bands, in the contract's own order. */
const BANDS = ['under', 'between', 'over', 'failed'] as const;

/**
 * `stats` cut to the requests in `names` (a group's members, from
 * `requestsInGroup`, or one picked request) and the group rows on their paths.
 *
 *   - REQUEST rows named in `names`, every family the payload carries for them.
 *   - GROUP rows whose path some named request sits inside (`name` starts with
 *     `group + '/'`), both of each group's rows (`group_cumulated` and
 *     `group_duration`, the statistics table picks one), in payload order. This
 *     is what lets `buildTree` nest a member under its group instead of
 *     promoting it to the root with its full path. NOTE what it includes: for a
 *     picked request, or a picked NESTED group, the ancestors too — for
 *     `Catalog/Recommendations`, the `Catalog` row, whose figures are the whole
 *     of `Catalog`'s. A table that wants the pick's own subtree only drops the
 *     group rows that are not the pick or under it.
 *   - NO run row. It is the whole run's total, which a pick is not, and it is
 *     what the statistics table draws as "All Requests" — and what
 *     `toRequestCounts` reads, so a caller drawing the number of requests under
 *     a pick has to count the narrowed request rows instead.
 *   - Scenario rows go too: they are a different axis, not part of a group.
 *
 * `indicators` is the sum of the kept `response_time` request rows' bands. The
 * server answers the response's own `indicators` from the run's
 * `response_time` row, so the narrowed sum is over the same family — and over
 * REQUEST rows alone, because a group row's bands count its executions, which
 * its requests' rows already count once.
 *
 * `bounds`, `configurable` and `window` describe the read, not a row, and are
 * kept as they are.
 */
export function narrowStats(stats: StatsResponse, names: readonly string[]): StatsResponse {
  const wanted = new Set(names);
  const onPath = (group: string): boolean => names.some((name) => name.startsWith(`${group}/`));
  const rows: StatRow[] = stats.stats.filter((row) =>
    row.scope === 'request' ? wanted.has(row.name) : row.scope === 'group' && onPath(row.name),
  );

  const indicators = { under: 0, between: 0, over: 0, failed: 0 };
  for (const row of rows) {
    if (row.scope !== 'request' || row.family !== 'response_time') continue;
    for (const band of BANDS) indicators[band] += row.indicators[band];
  }

  return { ...stats, stats: rows, indicators };
}

/**
 * `users` cut to one scenario, whose own buckets become the total.
 *
 * `total` is the per-scenario sum at each offset (`UsersResponseSchema`), so
 * with one scenario left it IS that scenario's buckets — copied, never shared,
 * so the narrowed payload's two arrays are not one array a caller can mutate
 * through the other. A scenario the run does not have keeps nothing: no
 * scenario and an empty total, never the run's.
 */
export function narrowUsers(users: UsersResponse, scenario: string): UsersResponse {
  const kept = users.scenarios.filter((s) => s.scenario === scenario);
  return {
    ...users,
    scenarios: kept,
    total: kept.flatMap((s) => s.buckets.map((bucket) => ({ ...bucket }))),
  };
}
