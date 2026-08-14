import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { statsQuery } from '../api/metrics';
import ScopedStatistics from '../tables/ScopedStatistics';
import { TableSection } from './payload';

/**
 * §13.4 — one group's page.
 *
 * EVERYTHING HERE IS DOUBLED. A request carries one measure; a group carries
 * two — cumulated response time (the sum of its child requests' durations) and
 * duration (its own wall clock) — and they diverge whenever requests inside the
 * group overlap. On the reference run `Cart` is 141 ms cumulated against 225 ms
 * duration. Gatling reports both, so this page shows both.
 *
 * The name is a full path arriving as ONE encoded segment, decided in piece 2:
 * `Catalog%2FRecommendations` reaches here as `Catalog/Recommendations`.
 */

/**
 * The row for one group AND one family.
 *
 * THREE FIELDS, NOT TWO. One group name carries both families, so a lookup that
 * matched only (scope, name) would return whichever `find` reached first and
 * render cumulated numbers under the duration heading — a plausible count, a
 * plausible mean, and nothing about the page looking wrong.
 */
export function groupRow(
  stats: StatsResponse,
  path: string,
  family: string,
): StatRow | undefined {
  return stats.stats.find(
    (r) => r.scope === 'group' && r.name === path && r.family === family,
  );
}

const FAMILIES = [
  { family: 'group_cumulated', title: 'Cumulated response time' },
  { family: 'group_duration', title: 'Duration' },
] as const;

export default function GroupDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });

  // Not reachable through the router — the route cannot match without both.
  if (runId === undefined || name === undefined) {
    return (
      <Link to="/runs" className="underline">
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Rendered as text through React, which escapes it: a group name comes
          out of an uploaded simulation log. */}
      <h1 className="text-2xl font-semibold">{name}</h1>
      <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
        Back to this run
      </Link>

      {FAMILIES.map(({ family, title }) => (
        <TableSection key={family} title={title} query={stats}>
          {(data) => {
            const row = groupRow(data, name, family);
            return row === undefined ? (
              <p role="status">This run recorded no {title.toLowerCase()} for {name}.</p>
            ) : (
              <ScopedStatistics row={row} rows={data.stats} />
            );
          }}
        </TableSection>
      ))}
    </div>
  );
}
