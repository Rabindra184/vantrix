import { Fragment } from 'react';
import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { distributionQuery, seriesQuery, statsQuery } from '../api/metrics';
import { linkButtonClasses } from '../components/Button';
import { EmptyState } from '../components/States';
import { ChevronLeftIcon } from '../components/icons';
import DistributionChart from '../charts/DistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import ScopedStatistics from '../tables/ScopedStatistics';
import { Payload, TableSection, Undrawn, type Slot } from './payload';
import useDocumentTitle from '../useDocumentTitle';

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
    percentiles: {
      id: 'percentiles-group_cumulated',
      title: 'Cumulated response time percentiles over time',
    },
  },
  {
    family: 'group_duration',
    title: 'Duration',
    distribution: { id: 'distribution-group_duration', title: 'Duration distribution' },
    percentiles: {
      id: 'percentiles-group_duration',
      title: 'Duration percentiles over time',
    },
  },
] as const;

/**
 * D-14, narrowed. The platform records per-group series as of piece 5, so this
 * is a fact about THIS RUN, not about the product — a page that still blamed
 * the platform would be making a false claim about it. The sentence itself
 * must not say "platform" for the same reason: naming the product, even in
 * passing, reads as the product being at fault rather than this one run's
 * ingestion predating the capability.
 *
 * NO CLAIM ABOUT THE REST OF THE PAGE — THIS IS THE THIRD DRAFT TO SAY SO, AND
 * THE THIRD TO STRIKE A REASSURING CLOSING CLAUSE. The first draft closed with
 * "...and are complete"; the second, after that was struck, closed with
 * "...are computed from measurements this run does carry" — a softer claim,
 * but the same shape of claim, and it failed for the same reason. `Undrawn`
 * renders this string UNCONDITIONALLY, with no view of what `/stats` or
 * `/distribution` are doing one section up: `/stats` and `/series` are
 * independent queries, so `/stats` can be rendering `<p role="alert">` in
 * place of a row (`TableSection`'s error branch) at the exact moment `/series`
 * resolves with `groupSeriesAvailable: false`; `/distribution` can 404 for a
 * completed run with no histogram at all, which `payload.tsx` documents as
 * reachable. Either way, a clause here claiming the sections above are intact
 * would be visibly contradicted by them. If you want to reassure the reader
 * about the rest of the page, that has to come from a component that can see
 * the other queries' state — not from this static string.
 */
const NO_GROUP_SERIES =
  'This run was ingested before per-group time series were captured, so percentiles over ' +
  'time cannot be drawn for it.';

const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };

export default function GroupDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();

  useDocumentTitle(name ?? null);

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
  const cumulatedSeries = useQuery({
    ...seriesQuery(runId ?? '', 'group', name ?? '', 'group_cumulated'),
    enabled: runId !== undefined && name !== undefined,
  });
  const durationSeries = useQuery({
    ...seriesQuery(runId ?? '', 'group', name ?? '', 'group_duration'),
    enabled: runId !== undefined && name !== undefined,
  });
  const seriesFor = { group_cumulated: cumulatedSeries, group_duration: durationSeries };

  // Not reachable through the router — the route cannot match without both.
  if (runId === undefined || name === undefined) {
    return (
      <Link to="/runs" className={linkButtonClasses}>
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Back link above the heading — see `RequestDetail`'s matching comment
          on why it moved: below the `<h1>` it sat between the page's title and
          its first section. */}
      <header className="flex flex-col gap-3">
        <Link
          to={`/runs/${encodeURIComponent(runId)}`}
          className="transition-ui inline-flex w-fit items-center gap-1 text-[13px] font-medium text-accent hover:underline hover:underline-offset-2"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Back to this run
        </Link>
        {/* Rendered as text through React, which escapes it: a group name comes
            out of an uploaded simulation log. `break-all` because a nested
            group name is a slash-separated path with nowhere else to wrap. */}
        <h1 className="text-xl font-semibold tracking-tight break-all sm:text-2xl">{name}</h1>
      </header>

      {FAMILIES.map(({ family, title }) => (
        <TableSection key={family} title={title} query={stats}>
          {(data) => {
            const row = groupRow(data, name, family);
            return row === undefined ? (
              // Politely announced and drawn as an empty state, not an alert:
              // a group that recorded no duration is an answer, not a fault.
              // The sentence is unchanged.
              <div role="status">
                <EmptyState title={`This run recorded no ${title.toLowerCase()} for ${name}.`} />
              </div>
            ) : (
              <ScopedStatistics row={row} rows={data.stats} heading={title} />
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

      {FAMILIES.map(({ family, distribution, percentiles }) => (
        <Fragment key={family}>
          <Payload query={distributions[family]} slots={[distribution]}>
            {(data) => (
              <DistributionChart
                distribution={data}
                id={distribution.id}
                title={distribution.title}
              />
            )}
          </Payload>
          <Payload query={seriesFor[family]} slots={[percentiles]}>
            {(data) =>
              data.groupSeriesAvailable ? (
                <PercentilesChart series={data} id={percentiles.id} title={percentiles.title} />
              ) : (
                <Undrawn slot={percentiles} reason={NO_GROUP_SERIES} />
              )
            }
          </Payload>
        </Fragment>
      ))}
    </div>
  );
}
