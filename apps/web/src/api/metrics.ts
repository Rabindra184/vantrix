import {
  DistributionResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
  UsersResponseSchema,
} from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * The four metric endpoints behind the eight overview charts.
 *
 * Four fetches, eight charts (design §2): `/stats` feeds the indicator bands
 * and the request-count donut, `/series` feeds percentiles-over-time,
 * requests/s and responses/s, `/users` feeds concurrent users and the arrival
 * rate, `/distribution` feeds the response-time distribution. A chart NEVER
 * fetches; it receives already-validated data and turns it into marks.
 *
 * Every one of these goes through `apiFetch` with its contract schema — the
 * same schema the API validates its own output against. `fetchRun`'s exception
 * (see `./run.ts`) does not apply here: these endpoints answer 200 or an
 * error, never a run body at 202/422, and charts mount only under the run
 * detail page's existing `state === 'ready'` branch, so the processing case
 * cannot arise (design §6).
 *
 * KEYS extend the convention `runQueryKey` established: `['run', id, …]`,
 * never `['runs', …]`, which is the LIST's prefix keyed by cursor. Colliding
 * the two would make an invalidation of the list discard every chart payload
 * the reader has open. Each key is a FUNCTION of everything the URL varies by,
 * so two scopes of the same endpoint cannot share a cache entry.
 */

const runPath = (id: string) => `/v1/runs/${encodeURIComponent(id)}`;

/* -------------------------------------------------------------------- *
 * stats — indicator bands ③ and the request-count donut ④
 * -------------------------------------------------------------------- */

export const statsQueryKey = (id: string) => ['run', id, 'stats'] as const;

/**
 * Deliberately UNFILTERED. The endpoint accepts `scope`/`name`/`family`, but
 * both charts need the whole set: the donut's totals come from the run-scope
 * row, and `StatsResponse.indicators`/`bounds`/`configurable` are properties of
 * the response rather than of any row. Filtering here would mean a second
 * request for the same run, cached under a second key, that could disagree.
 */
export const statsQuery = (id: string) => ({
  queryKey: statsQueryKey(id),
  queryFn: () => apiFetch(StatsResponseSchema, `${runPath(id)}/stats`),
});

/* -------------------------------------------------------------------- *
 * series — percentiles over time ⑨, requests/s ⑩, responses/s ⑪
 * -------------------------------------------------------------------- */

export const seriesQueryKey = (id: string, scope = 'run', name = '') =>
  ['run', id, 'series', scope, name] as const;

/**
 * `scope`/`name` default to the RUN as a whole, which is what all three
 * overview charts want; the parameters exist because the request- and
 * group-detail pages of later sub-projects call the same endpoint scoped to
 * one name, and they must not need a second fetcher to do it.
 */
export const seriesQuery = (id: string, scope = 'run', name = '') => ({
  queryKey: seriesQueryKey(id, scope, name),
  queryFn: () =>
    apiFetch(
      SeriesResponseSchema,
      `${runPath(id)}/series?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`,
    ),
});

/* -------------------------------------------------------------------- *
 * users — concurrent users ⑦ and users started per second ⑦ᵇ
 * -------------------------------------------------------------------- */

export const usersQueryKey = (id: string) => ['run', id, 'users'] as const;

/** Takes no parameters: the response already carries every scenario and the
 *  cross-scenario total, and both charts read it whole. */
export const usersQuery = (id: string) => ({
  queryKey: usersQueryKey(id),
  queryFn: () => apiFetch(UsersResponseSchema, `${runPath(id)}/users`),
});

/* -------------------------------------------------------------------- *
 * distribution — response time distribution ⑧
 * -------------------------------------------------------------------- */

export const distributionQueryKey = (
  id: string,
  scope = 'run',
  name = '',
  family = 'response_time',
) => ['run', id, 'distribution', scope, name, family] as const;

/**
 * `family` defaults to `response_time` and is not expected to vary in this
 * sub-project: the latency family is explicitly NOT rendered, because Gatling
 * 3.15.1.2 reports no latency (design §1) and there is nothing to reach parity
 * with. It is a parameter rather than a constant only because the endpoint has
 * one, and hard-coding it into the URL while leaving it out of the key would
 * be the shape that silently serves one family's data under another's key.
 */
export const distributionQuery = (
  id: string,
  scope = 'run',
  name = '',
  family = 'response_time',
) => ({
  queryKey: distributionQueryKey(id, scope, name, family),
  queryFn: () =>
    apiFetch(
      DistributionResponseSchema,
      `${runPath(id)}/distribution?scope=${encodeURIComponent(scope)}` +
        `&name=${encodeURIComponent(name)}&family=${encodeURIComponent(family)}`,
    ),
});
