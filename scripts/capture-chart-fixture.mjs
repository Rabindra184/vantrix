/**
 * Captures the seven payloads for the REFERENCE RUN, from the live API,
 * into `apps/web/test/fixtures/reference-run.json`.
 *
 * WHY THIS EXISTS. Every chart transform in this sub-project is unit-tested
 * against that fixture, so the fixture is what those tests mean by "the data".
 * Hand-writing it would make the whole suite a test of somebody's memory of
 * the API rather than of the API: a field renamed, a percentile map that is
 * empty where it was assumed populated, a `null` where a number was expected —
 * none of it would show up until a browser. Capturing it means the transforms
 * run against the SAME BYTES the browser receives.
 *
 * WHAT IT WRITES. Seven raw response bodies, exactly as served, under the
 * keys `stats`, `series`, `users`, `distribution`, `errors`, `scatter` and
 * `scatterWithFailures`, plus a `_capture` block recording where they came
 * from. Nothing is reshaped, rounded or trimmed.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RE-CAPTURE IT
 * ---------------------------------------------------------------------------
 *
 * 1. Bring up the backing services (Postgres, Redis, MinIO):
 *
 *      docker compose -f infra/docker-compose.yml up -d
 *
 * 2. Export the environment. There is no `.env` in this repo:
 *
 *      export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
 *      export REDIS_URL=redis://localhost:6380
 *      export S3_ENDPOINT=http://localhost:9000
 *      export S3_ACCESS_KEY=perfportal
 *      export S3_SECRET_KEY=perfportal123
 *
 * 3. Build, and start the API. This script talks to a RUNNING server over
 *    HTTP — it does not start one, so that what it captures is unambiguously
 *    what the server serves:
 *
 *      . "$HOME/.nvm/nvm.sh" && nvm use     # Node >= 22
 *      pnpm build
 *      pnpm --filter @perfportal/api start  # leave running, in another shell
 *
 * 4. Run this script. `--experimental-strip-types` is REQUIRED: it imports
 *    `apps/web/e2e/fixtures.ts`, which is TypeScript.
 *
 *      node --experimental-strip-types scripts/capture-chart-fixture.mjs
 *
 * 5. Commit the regenerated `apps/web/test/fixtures/reference-run.json` and
 *    run `pnpm test:unit` — the transform tests read it, and a re-capture that
 *    changes a number is a change to what those tests assert.
 *
 * NEVER run this while `pnpm test:integration` is running against the same
 * DATABASE_URL: that suite TRUNCATEs all 15 tables on every `createTestApp()`
 * call and will delete the org this script just seeded, mid-capture.
 *
 * ---------------------------------------------------------------------------
 *
 * SEEDING GOES THROUGH `apps/web/e2e/fixtures.ts`, not through a second copy
 * of the ingest dance. `seedRunWithData` posts the real
 * `fixtures/gatling-3.15.1.2` bundle to the running server and then drives
 * `PipelineService` directly (no worker process exists in this stack), and it
 * asserts the run reached `complete` before returning. Reusing it means the
 * fixture and the e2e suite are looking at the same kind of run, produced the
 * same way — and it is why this file imports nothing from the workspace
 * packages itself: everything it needs is declared by `apps/web`, which is the
 * package that owns those imports.
 *
 * READS AUTHENTICATE WITH A SESSION COOKIE, obtained by POSTing the seeded
 * admin's credentials to `/auth/sign-in/email` — the same call the browser's
 * own `signIn` makes (`apps/web/src/api/session.ts`). An API token with the
 * `read` scope would have been fewer lines, but the point of this fixture is
 * "the bytes the browser receives", and the browser is a cookie client.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedAdmin, seedRunWithData } from '../apps/web/e2e/fixtures.ts';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

const OUT = fileURLToPath(
  new URL('../apps/web/test/fixtures/reference-run.json', import.meta.url),
);

/**
 * The five requests, in the exact form `apps/web/src/api/metrics.ts` issues
 * them. Kept in step with that module deliberately: a fixture captured from a
 * different scope than the app requests is a fixture the transforms are tested
 * against and the app never sees.
 *
 * `errors` is the exception, and knowingly so: `metrics.ts` has no errors
 * query yet — the errors table adds one — so this URL is the shape that
 * builder must take rather than a copy of one that exists. It carries
 * `?scope=run&name=` for the same reason `series` does: the app's builder must
 * emit this exact string, and a capture taken with a different one would stop
 * being what the browser receives.
 *
 * NOT because omitting it is unsafe — measured, it is not.
 * `MetricsController.errors` sets `name` to `''` when `scope` is absent and
 * the reader's SQL is unconditionally scoped, so `/errors` and
 * `/errors?scope=run&name=` return identical rows. The real trap is the
 * inverse: `?name=X` WITHOUT `scope` is silently ignored and answers with the
 * run's totals.
 */
const ENDPOINTS = [
  { key: 'stats', path: (id) => `/v1/runs/${id}/stats` },
  { key: 'series', path: (id) => `/v1/runs/${id}/series?scope=run&name=` },
  { key: 'users', path: (id) => `/v1/runs/${id}/users` },
  {
    key: 'distribution',
    path: (id) => `/v1/runs/${id}/distribution?scope=run&name=&family=response_time`,
  },
  { key: 'errors', path: (id) => `/v1/runs/${id}/errors?scope=run&name=` },
  {
    key: 'scatter',
    // RQ-09 is inherently request-scoped, so this endpoint takes `name` and NO
    // `scope` — it cannot fall into the `?name=` trap the errors URL above
    // documents, because there is no scope parameter to omit.
    //
    // `Catalog/List Products` is the post-D-10 identity of a request Gatling
    // nests, so this capture also proves the joined name survives a URL.
    path: (id) => `/v1/runs/${id}/scatter?name=${encodeURIComponent('Catalog/List Products')}`,
  },
  {
    key: 'scatterWithFailures',
    // `Catalog/List Products` above has ZERO failures, so `scatter.ko` is `[]`
    // in that capture and the KO series is, in effect, untestable against it —
    // a transform that plotted `s.ok` twice under both series names would pass
    // every test that only ever reads that fixture. `Cart/Add To Cart` fails
    // (15 KO against 48 OK points), so this second capture is the only bytes
    // in this fixture that can pin the KO series' colour, legend and data. It
    // is also the request D-03 is pinned against in
    // apps/api/test/parity.e2e.test.ts, so the web and API suites reason
    // about the same request.
    path: (id) => `/v1/runs/${id}/scatter?name=${encodeURIComponent('Cart/Add To Cart')}`,
  },
  {
    key: 'groupSeries',
    // `Cart` because its two families diverge (141 ms cumulated against 225 ms
    // duration); `Catalog/Recommendations` agrees to within 1 ms and would let
    // a one-family implementation pass.
    path: (id) =>
      `/v1/runs/${id}/series?scope=group&name=${encodeURIComponent('Cart')}&family=group_cumulated`,
  },
];

/** Fails with the server's own words rather than a bare status code. */
async function expectOk(res, what) {
  if (!res.ok) {
    throw new Error(`${what} → HTTP ${res.status}\n${await res.text()}`);
  }
  return res;
}

/**
 * Signs in and returns the `Cookie` header value for subsequent reads.
 *
 * Node's `fetch` has no cookie jar, so the session cookie is lifted off
 * `set-cookie` and forwarded by hand. Only the `name=value` prefix of each
 * cookie is kept — `HttpOnly`, `SameSite` and the rest are response-side
 * attributes and are not sent back by a client.
 */
async function signIn({ email, password }) {
  const res = await expectOk(
    await fetch(`${BASE_URL}/auth/sign-in/email`, {
      method: 'POST',
      // `Origin` is not optional here. Better Auth rejects a state-changing
      // request whose origin it cannot check with 403 MISSING_OR_NULL_ORIGIN —
      // its CSRF defence — and Node's fetch sends none. A browser always does,
      // so sending it is what makes this the same request the app makes, not a
      // workaround.
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      body: JSON.stringify({ email, password }),
    }),
    'POST /auth/sign-in/email',
  );

  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  if (cookies.length === 0) {
    throw new Error('sign-in returned 200 but set no cookie — nothing to authenticate reads with');
  }
  return cookies.join('; ');
}

async function main() {
  // Fail early and by name if the server is not up, rather than seeding an org
  // and then discovering there is nothing to POST the bundle to.
  await expectOk(
    await fetch(`${BASE_URL}/health`).catch(() => {
      throw new Error(
        `No API answering at ${BASE_URL}. Start it first:\n` +
          '  pnpm build && pnpm --filter @perfportal/api start',
      );
    }),
    `GET ${BASE_URL}/health`,
  );

  console.log('seeding an admin and ingesting the reference bundle…');
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  console.log(`  run ${runId}`);

  const cookie = await signIn(admin);

  const captured = {};
  for (const { key, path } of ENDPOINTS) {
    const url = path(runId);
    const res = await expectOk(
      await fetch(`${BASE_URL}${url}`, { headers: { cookie } }),
      `GET ${url}`,
    );
    captured[key] = await res.json();
    console.log(`  captured ${key.padEnd(12)} ${url}`);
  }

  // Post-conditions, because a fixture that captured cleanly but is EMPTY
  // would turn every transform test into a test of the empty case while
  // reporting green. The reference bundle has 895 requests across several
  // scenarios; none of these can legitimately be zero-length.
  const nonEmpty = {
    'stats.stats': captured.stats.stats.length,
    'series.buckets': captured.series.buckets.length,
    'users.scenarios': captured.users.scenarios.length,
    'users.total': captured.users.total.length,
    'distribution.labels': captured.distribution.labels.length,
    // 24 of the reference run's 895 requests fail, in two distinct messages.
    // An empty array here would mean the errors table renders its empty state
    // in every test that reads this fixture, and pass.
    'errors.errors': captured.errors.errors.length,
    // Of all six captures, this is the one most likely to come back empty on a
    // future re-capture: it is the only endpoint parameterised by a
    // data-dependent string that must match a stored metric name exactly
    // (`?name=Catalog/List Products`), so a rename, a re-encoding, or a name
    // that stops being joined would silently produce `{ ok: [], ko: [] }`.
    'scatter.ok': captured.scatter.ok.length,
    // The opposite call from `scatter.ok` above, deliberately: that entry
    // guards `ok` only, because `Catalog/List Products` has no failures and
    // guarding its `ko` would fail every capture on a passing run. This
    // request was picked BECAUSE it fails, so its `ko` — not its `ok` — is
    // the reason this second endpoint exists at all. An empty `ko` here means
    // the one payload that can test the KO series came back untestable, and
    // that must fail loudly rather than silently produce a fixture as thin as
    // the one this task exists to fix.
    'scatterWithFailures.ko': captured.scatterWithFailures.ko.length,
    // Empty here means the run was ingested without group series — the whole
    // point of this capture — so it must fail loudly rather than be written.
    'groupSeries.buckets': captured.groupSeries.buckets.length,
  };
  for (const [what, length] of Object.entries(nonEmpty)) {
    if (length === 0) {
      // Three distinct diagnoses share this guard. For the five run-scoped
      // entries, empty means the run itself ingested but produced no data.
      // The two `scatter*` entries are parameterised by a data-dependent name
      // (see their comments above) — for them, empty more likely means that
      // name stopped matching a stored metric, or (for `scatterWithFailures`)
      // stopped failing, than that the run produced nothing.
      const cause = what.startsWith('scatter')
        ? 'either the run produced no data, or the request name above stopped matching a stored metric'
        : 'the run ingested but produced no data';
      throw new Error(
        `captured ${what} is empty — ${cause}, so this fixture would silently turn every ` +
          'transform test into a test of the empty case',
      );
    }
  }

  const output = {
    _capture: {
      // Provenance, so a stale fixture is diagnosable from the fixture itself.
      script: 'scripts/capture-chart-fixture.mjs',
      capturedAt: new Date().toISOString(),
      runId,
      bundle: 'fixtures/gatling-3.15.1.2/reference-report/simulation.log',
      baseUrl: BASE_URL,
      endpoints: Object.fromEntries(ENDPOINTS.map(({ key, path }) => [key, path(runId)])),
      counts: nonEmpty,
    },
    ...captured,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  // Trailing newline and two-space indent: this file is committed, and a
  // re-capture should produce a readable diff rather than one enormous line.
  writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
  console.log(Object.entries(nonEmpty).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
}

await main();
// The seeds hold a Prisma client and a pg Pool open at module scope; without
// this the process would hang after the file is written.
process.exit(0);
