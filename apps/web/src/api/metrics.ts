import {
  DistributionResponseSchema,
  ErrorSeriesResponseSchema,
  ErrorsResponseSchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
  TrendsResponseSchema,
  UsersResponseSchema,
} from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * The metric endpoints behind the run detail page: four for the eight overview
 * charts, and `/errors` for the errors table.
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
 *
 * EVERY FACTORY BELOW ALSO SETS `staleTime: Infinity`. A completed run's
 * metrics do not change — `/stats`, `/series`, `/users`, `/distribution`,
 * `/errors` and `/scatter` for a given run id are fixed the moment the run is
 * ingested, and a re-ingest produces a new run id, not new values under this
 * one. `main.tsx` sets no `staleTime` of its own, so without one here
 * TanStack's default of `0` applies: a query is stale the instant it lands,
 * and a newly mounted observer for stale data refetches on mount REGARDLESS
 * of whether another observer already holds the same key warm. That is not
 * hypothetical — it is what this page actually does. `RunShell` fetches
 * `usersQuery` and `errorsQuery` for the header and the tab strip; `stats`,
 * `users`, `distribution` and `series` are each asked for again, under the
 * identical key, by whichever of `RunOverviewTab` / `RunChartsTab` /
 * `RunErrorsTab` the reader opens — and because those are ROUTES that mount at
 * DIFFERENT times, not components sharing one render, a shared key alone only
 * dedupes observers that happen to mount while a fetch is still in flight. The
 * `staleTime` is what stops the later, separate mount from firing a second
 * request for data that has not gone anywhere. `run.ts`'s `runQueryKey` is
 * deliberately NOT given one: `pollIntervalFor` re-polls a run that is still
 * `processing` on purpose, and needs the query to be refetchable.
 */

const runPath = (id: string) => `/v1/runs/${encodeURIComponent(id)}`;

/* -------------------------------------------------------------------- *
 * stats — indicator bands ③, the request-count donut ④, the statistics table ⑤
 * -------------------------------------------------------------------- */

export const statsQueryKey = (id: string) => ['run', id, 'stats'] as const;

/**
 * Deliberately UNFILTERED. The endpoint accepts `scope`/`name`/`family`, but
 * every consumer needs the whole set: the donut's totals come from the
 * run-scope row, `StatsResponse.indicators`/`bounds`/`configurable` are
 * properties of the response rather than of any row, and the statistics table
 * is by definition every row there is. Filtering here would mean a second
 * request for the same run, cached under a second key, that could disagree.
 *
 * TWO ROUTES, ONE FETCH — but only because of `staleTime`, not because of the
 * KEY alone. This docstring used to say `RunDetail` "mounts the statistics
 * table and the chart stack as separate components", which was true before
 * this key had a route split to survive: today `RunOverviewTab` (the
 * statistics table, and the six stat tiles) and `RunChartsTab` (the indicator
 * bands and the request-count donut) are different ROUTES under `RunShell`,
 * mounted at whatever moment the reader clicks a tab — not two components
 * rendered together in one commit. A shared key on its own only dedupes
 * observers that mount while a fetch is still in flight; it says nothing
 * about a SECOND mount, minutes later, of an observer for data that already
 * resolved. `staleTime: Infinity` is what makes that second mount reuse the
 * cache instead of firing again — see this file's top-level comment for why
 * that is correct for a completed run's stats specifically.
 */
export const statsQuery = (id: string) => ({
  queryKey: statsQueryKey(id),
  queryFn: () => apiFetch(StatsResponseSchema, `${runPath(id)}/stats`),
  staleTime: Infinity,
});

/* -------------------------------------------------------------------- *
 * series — percentiles over time ⑨, requests/s ⑩, responses/s ⑪
 * -------------------------------------------------------------------- */

export const seriesQueryKey = (id: string, scope = 'run', name = '', family = 'response_time') =>
  ['run', id, 'series', scope, name, family] as const;

/**
 * `scope`/`name` default to the RUN as a whole, which is what all three
 * overview charts want; the parameters exist because the request- and
 * group-detail pages of later sub-projects call the same endpoint scoped to
 * one name, and they must not need a second fetcher to do it. `family`
 * defaults to `response_time` so the run and request pages are unchanged;
 * the group detail page passes `group_cumulated` or `group_duration`.
 */
export const seriesQuery = (id: string, scope = 'run', name = '', family = 'response_time') => ({
  queryKey: seriesQueryKey(id, scope, name, family),
  queryFn: () =>
    apiFetch(
      SeriesResponseSchema,
      `${runPath(id)}/series?scope=${encodeURIComponent(scope)}` +
        `&name=${encodeURIComponent(name)}&family=${encodeURIComponent(family)}`,
    ),
  staleTime: Infinity,
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
  staleTime: Infinity,
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
  staleTime: Infinity,
});

/* -------------------------------------------------------------------- *
 * errors — the errors table ⑥
 * -------------------------------------------------------------------- */

export const errorsQueryKey = (id: string, scope = 'run', name = '') =>
  ['run', id, 'errors', scope, name] as const;

/**
 * The trap on this endpoint is NOT the one an earlier version of this comment
 * described. Measured against `MetricsController.errors`:
 *
 *     const sel = { scope: scope ?? 'run', name: scope === undefined ? '' : (name ?? '') };
 *
 * Omitting `scope` sets `name` to `''`, not `undefined`, and the reader's SQL
 * is unconditionally `AND scope = $4 AND name = $5` with its own
 * `{ scope: 'run', name: '' }` default. So `/errors` and `/errors?scope=run&name=`
 * return byte-identical results — the unscoped form is safe.
 *
 * THE REAL TRAP IS THE INVERSE: `?name=Search` WITHOUT `scope` is silently
 * ignored. That ternary forces `name` to `''`, so the request comes back with
 * the RUN's totals while looking like it asked for one endpoint's. A caller
 * scoping a read must send BOTH parameters or neither. This matters next for
 * §13.3 RQ-11, "Errors for this request".
 *
 * These three characters are sent anyway, for a different and still-real
 * reason: the captured fixture was taken with exactly this string, so keeping
 * them identical is what makes the fixture what the browser receives.
 *
 * ═══ THE URL IS DUPLICATED, CHARACTER FOR CHARACTER, IN A SECOND PLACE ═══
 *
 * `scripts/capture-chart-fixture.mjs` re-captures
 * `apps/web/test/fixtures/reference-run.json` by issuing
 * `/v1/runs/${id}/errors?scope=run&name=` — its own literal, written before
 * this builder existed. Every unit test in this sub-project runs against that
 * capture, so if the two strings drift the fixture stops being what the browser
 * receives and no suite in the repo notices. That duplication is now six URLs
 * wide across the five endpoints and is recorded as follow-up rather than fixed
 * here; `apps/web/e2e/run-tables.spec.ts` asserts the string this builder
 * actually puts on the wire, which makes at least the app half observable.
 *
 * `scope`/`name` are parameters for the same reason `seriesQuery`'s are: the
 * request detail page's "Errors for this request" (RQ-11, piece 3) calls this
 * same endpoint scoped to one name and must not need a second fetcher to do it.
 */
export const errorsQuery = (id: string, scope = 'run', name = '') => ({
  queryKey: errorsQueryKey(id, scope, name),
  queryFn: () =>
    apiFetch(
      ErrorsResponseSchema,
      `${runPath(id)}/errors?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`,
    ),
  staleTime: Infinity,
});

/* -------------------------------------------------------------------- *
 * errors over time — errors per second, beside the errors table ⑥
 * -------------------------------------------------------------------- */

export const errorSeriesQueryKey = (id: string) => ['run', id, 'errors', 'series'] as const;

/**
 * TAKES NO `scope`/`name`, unlike `errorsQuery` directly above — and that is
 * the point rather than an omission.
 *
 * The endpoint is run scope only and declares no such parameters, so the trap
 * that comment spends a paragraph on ("`?name=Search` without `scope` is
 * silently ignored") cannot arise here: there is nothing to forget to send.
 */
export const errorSeriesQuery = (id: string) => ({
  queryKey: errorSeriesQueryKey(id),
  queryFn: () => apiFetch(ErrorSeriesResponseSchema, `${runPath(id)}/errors/series`),
  staleTime: Infinity,
});

/* -------------------------------------------------------------------- *
 * scatter — response time against global throughput ⑨ (RQ-09)
 * -------------------------------------------------------------------- */

export const scatterQueryKey = (id: string, name: string) =>
  ['run', id, 'scatter', name] as const;

/**
 * REQUEST-SCOPED BY CONSTRUCTION. Unlike `/errors` and `/series`, this endpoint
 * takes `name` and no `scope` — a run-wide saturation scatter is not a thing
 * §13.3 defines — so the `?name=` trap documented above cannot arise here:
 * there is no scope parameter to omit.
 */
export const scatterQuery = (id: string, name: string) => ({
  queryKey: scatterQueryKey(id, name),
  queryFn: () =>
    apiFetch(
      ScatterResponseSchema,
      `${runPath(id)}/scatter?name=${encodeURIComponent(name)}`,
    ),
  staleTime: Infinity,
});

/* -------------------------------------------------------------------- *
 * trends — this run in the context of its cohort
 * -------------------------------------------------------------------- */

export const trendsQueryKey = (id: string, limit: number) =>
  ['run', id, 'trends', limit] as const;

/**
 * THE ONE FACTORY IN THIS FILE WITH NO `staleTime: Infinity`, and its absence
 * is the point.
 *
 * Every other query here is cached forever because a completed run's own
 * metrics are fixed the moment it is ingested — `/stats`, `/series`,
 * `/distribution` for a given run id never change, and a re-ingest produces a
 * new run id rather than new values under this one. That argument is stated at
 * the top of this file and it is correct.
 *
 * IT DOES NOT HOLD FOR A COHORT. This answer is about a SET of runs, and
 * ingesting a new run of the same simulation changes it without changing any
 * run already in it — the new run appears, `cohortSize` grows, and the oldest
 * may fall out of the window. Cached forever, a reader who left this tab open,
 * shipped a fix, ran the test again and came back would be looking at a trend
 * that ends before the run they came to see.
 *
 * So this query takes TanStack's default `staleTime: 0` deliberately: stale on
 * arrival, refetched on the next mount. That is the behaviour the rest of the
 * file suppresses, and here it is the correct one.
 *
 * `limit` IS IN THE KEY because it is in the URL. Two windows of the same
 * cohort are two different answers, and sharing one cache entry between them
 * would serve whichever arrived first under both.
 */
export const trendsQuery = (id: string, limit = 20) => ({
  queryKey: trendsQueryKey(id, limit),
  queryFn: () =>
    apiFetch(TrendsResponseSchema, `${runPath(id)}/trends?limit=${limit}`),
});
