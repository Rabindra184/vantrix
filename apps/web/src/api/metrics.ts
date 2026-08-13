import {
  DistributionResponseSchema,
  ErrorsResponseSchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
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
 * THREE CONSUMERS, ONE FETCH. `RunDetail` mounts the statistics table and the
 * chart stack as separate components and each asks for this query by name; the
 * KEY is what makes that one request and one cache entry rather than two of
 * each. Hoisting the call to their common parent would work too, and would
 * couple the chart stack's payload to a decision about tables — the key already
 * says these are the same data.
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
});
