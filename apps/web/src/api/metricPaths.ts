/**
 * EVERY METRICS URL THIS PRODUCT ISSUES, DEFINED ONCE.
 *
 * WHY THIS MODULE EXISTS. These strings had two authors. `api/metrics.ts`
 * built them for the browser, and `scripts/capture-chart-fixture.mjs` built
 * them again, by hand, to capture `apps/web/test/fixtures/reference-run.json`
 * — the fixture every chart-transform test in `apps/web` asserts against.
 * `metrics.ts`'s own `errorsQuery` docstring recorded that duplication as
 * "six URLs wide across the five endpoints", said "no suite in the repo
 * notices" if the two drift, and left it as follow-up.
 *
 * IT HAD ALREADY DRIFTED. Measured by running both sides against one run id:
 * eight captured endpoints, seven identical, and
 *
 *     capture: /v1/runs/{id}/series?scope=run&name=
 *     browser: /v1/runs/{id}/series?scope=run&name=&family=response_time
 *
 * The capture omitted `family`. It was harmless ONLY because
 * `MetricsController.series` declares `@Query('family') family =
 * 'response_time'` and the browser's default is the same word — a server-side
 * default standing in for an omitted parameter, which is the shape this
 * repository keeps paying for. Change either default and the fixture silently
 * stops being what the browser receives, with every unit test still green.
 *
 * SO THE DUPLICATION IS GONE RATHER THAN GUARDED. Both callers import these
 * functions; the capture script supplies its own ARGUMENTS (which request to
 * scatter, which group to series) because those are genuinely its choice, and
 * owns none of the URL SHAPE.
 *
 * THE WINDOW SUFFIX IS BUILT HERE, NOT APPENDED BY THE CALLER, and that is the
 * second defect this closes by construction. `rangeSuffix` takes its join
 * character as an argument — `?` for a bare path, `&` for one that already
 * carries a query string — so every call site used to restate a fact about a
 * URL written elsewhere. `seriesQuery`'s own comment argued the point ("a `?`
 * here would produce two query strings and the server would see neither
 * bound"). A path that gains a parameter now cannot leave a caller appending
 * with the wrong character, because the same function decides both.
 *
 * IT IMPORTS `rangeSuffix` AND NOTHING ELSE, DELIBERATELY. `routes/window.ts`
 * takes only `import type { Window }` from `@perfportal/contracts`, which
 * strip-types erases, so this module has no runtime dependency at all — which
 * is what lets `scripts/capture-chart-fixture.mjs` import it under
 * `node --experimental-strip-types`. Reaching for `metrics.ts` instead would
 * drag in `apiFetch` and every response schema, and the URL would still only
 * be reachable by invoking a `queryFn` with `fetch` stubbed. Verified rather
 * than assumed: the script imports this file and runs.
 */

import type { Window } from '@perfportal/contracts';

/**
 * `''` for the whole run, `?from=&to=` otherwise.
 *
 * Always BOTH bounds. Each is meaningful alone on the wire, but a client that
 * knows both and sends one is only creating a chance to send the wrong one.
 *
 * EXPORTED FOR ITS OWN TESTS AND FOR NOTHING ELSE. No path builder outside
 * this file passes `join`, which is the whole point of the move — see the
 * header. It came from `routes/window.ts`, which keeps the router-side
 * `parseWindow`/`serialiseWindow`; `apps/web/test/window.test.ts` still pins
 * the `?`-against-`&` behaviour directly, because a builder asserting the
 * finished URL cannot say which half chose the character.
 */
export const rangeSuffix = (w: Window | null, join = '?'): string =>
  w === null ? '' : `${join}from=${w.fromMs}&to=${w.toMs}`;

export const runPath = (id: string): string => `/v1/runs/${encodeURIComponent(id)}`;

/**
 * `scope`/`name`/`family` are spelled out on the two endpoints that take all
 * three, rather than omitted where they equal the server's default. An omitted
 * parameter and a parameter carrying the default value are the same response
 * today and are not the same REQUEST, and the difference is invisible until a
 * default moves. This is also what the captured fixture's `_capture.endpoints`
 * block records, so the provenance in that file names the real call.
 */
export const statsPath = (id: string, window: Window | null = null): string =>
  `${runPath(id)}/stats${rangeSuffix(window)}`;

export const seriesPath = (
  id: string,
  scope = 'run',
  name = '',
  family = 'response_time',
  window: Window | null = null,
): string =>
  `${runPath(id)}/series?scope=${encodeURIComponent(scope)}` +
  `&name=${encodeURIComponent(name)}&family=${encodeURIComponent(family)}` +
  rangeSuffix(window, '&');

export const usersPath = (id: string, window: Window | null = null): string =>
  `${runPath(id)}/users${rangeSuffix(window)}`;

export const distributionPath = (
  id: string,
  scope = 'run',
  name = '',
  family = 'response_time',
  window: Window | null = null,
): string =>
  `${runPath(id)}/distribution?scope=${encodeURIComponent(scope)}` +
  `&name=${encodeURIComponent(name)}&family=${encodeURIComponent(family)}` +
  rangeSuffix(window, '&');

/**
 * TAKES NO WINDOW, and that is the endpoint's own shape rather than an
 * omission here: `/v1/runs/:id/errors` declares no `from`/`to`, which is why
 * `ErrorsTable` renders a notice saying its totals cover the whole run under a
 * window. Accepting one and dropping it would be worse than not accepting one.
 */
export const errorsPath = (id: string, scope = 'run', name = ''): string =>
  `${runPath(id)}/errors?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`;

export const errorSeriesPath = (id: string, window: Window | null = null): string =>
  `${runPath(id)}/errors/series${rangeSuffix(window)}`;

/** Request-scoped by construction — this endpoint takes `name` and no `scope`. */
export const scatterPath = (id: string, name: string, window: Window | null = null): string =>
  `${runPath(id)}/scatter?name=${encodeURIComponent(name)}` + rangeSuffix(window, '&');

export const telemetryPath = (id: string, window: Window | null = null): string =>
  `${runPath(id)}/telemetry${rangeSuffix(window)}`;

export const trendsPath = (id: string, limit = 20): string =>
  `${runPath(id)}/trends?limit=${limit}`;
