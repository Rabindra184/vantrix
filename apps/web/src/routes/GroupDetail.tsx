import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { distributionQuery, statsQuery } from '../api/metrics';
import DistributionChart from '../charts/DistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import ScopedStatistics from '../tables/ScopedStatistics';
import { Payload, TableSection, type Slot } from './payload';

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

/**
 * §13.4's five containers, two per family plus the shared ranges chart. Ids
 * match what each chart component passes to `Chart`, suffixed per family so the
 * two never collide.
 */
const FAMILIES = [
  {
    family: 'group_cumulated',
    title: 'Cumulated response time',
    distribution: {
      id: 'distribution-group_cumulated',
      title: 'Cumulated response time distribution',
    },
  },
  {
    family: 'group_duration',
    title: 'Duration',
    distribution: { id: 'distribution-group_duration', title: 'Duration distribution' },
  },
] as const;

const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };

export default function GroupDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });
  const cumulated = useQuery({
    ...distributionQuery(runId ?? '', 'group', name ?? '', 'group_cumulated'),
    enabled: runId !== undefined && name !== undefined,
  });
  const duration = useQuery({
    ...distributionQuery(runId ?? '', 'group', name ?? '', 'group_duration'),
    enabled: runId !== undefined && name !== undefined,
  });
  const distributions = { group_cumulated: cumulated, group_duration: duration };

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

      <Payload query={stats} slots={[INDICATORS]}>
        {(data) => (
          <IndicatorsChart
            // GR-09: Gatling's group page has one `RangesContainerId`, not two.
            // Cumulated response time is the group measure its own statistics
            // table leads with, so that is the row folded into the one ranges
            // chart — duration has no ranges chart of its own.
            stats={data}
            row={groupRow(data, name, 'group_cumulated')}
            label={name}
            noun="group"
          />
        )}
      </Payload>

      {FAMILIES.map(({ family, distribution }) => (
        <Payload key={family} query={distributions[family]} slots={[distribution]}>
          {(data) => (
            <DistributionChart
              distribution={data}
              id={distribution.id}
              title={distribution.title}
            />
          )}
        </Payload>
      ))}
    </div>
  );
}
