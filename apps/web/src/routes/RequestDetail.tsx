import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { statsQuery } from '../api/metrics';

/**
 * §13.3 — one request's own page.
 *
 * THE NAME IS A FULL PATH, arriving as ONE encoded segment. `detailPathFor`
 * encodes it (`tables/StatisticsTable.tsx:822`), the route spells it as a
 * single `:name` (`App.tsx:42`), and `useParams` decodes it — so
 * `Catalog%2FList%20Products` reaches here as `Catalog/List Products`, which
 * is exactly the identity the engine rolls the request up under (D-10).
 */

/**
 * The row this page is about.
 *
 * SCOPE IS PART OF THE MATCH, not an afterthought. `Catalog` is a group AND a
 * name a request could plausibly have; matching on name alone would render a
 * group's cumulated numbers under a request heading and look entirely normal.
 */
export function requestRow(stats: StatsResponse, path: string): StatRow | undefined {
  return stats.stats.find((r) => r.scope === 'request' && r.name === path);
}

export default function RequestDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  // Fired here, unconsumed here: this is the shell. Tasks 4 and 5 read
  // `.data` through `requestRow` for the statistics table and the indicator
  // bands; calling the query now — under the SAME key `Tables`/`Overview` use
  // — means their first render finds a warm cache entry rather than a second
  // request for a payload this page already fetched.
  useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });

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
      {/* The name the reader clicked, so the page is recognisably the one they
          asked for. Rendered as text through React, which escapes it: this is a
          request name out of an uploaded simulation log, i.e. a string an
          ingesting client controls. */}
      <h1 className="text-2xl font-semibold">{name}</h1>
      <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
        Back to this run
      </Link>
    </div>
  );
}
