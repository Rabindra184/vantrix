# PerfPortal

A performance-testing analytics platform. It ingests performance-test result
bundles (currently: Gatling), aggregates them into exact and estimated
statistics, evaluates them against SLA rules, and serves the results over
HTTP.

## Apps

- **`apps/api`** — NestJS on Express (`@nestjs/platform-express`; multipart
  bodies are parsed by `busboy` piped straight from `req`): token auth,
  `POST /v1/runs` (bundle ingest), run/status/verdict reads, stats/series/errors
  reads, and three endpoints backing the Appendix A charts —
  `GET /v1/runs/{id}/distribution` (response-time histogram bins),
  `GET /v1/runs/{id}/users` (concurrent-users and start-rate series), and
  `GET /v1/runs/{id}/scatter` (response time against global RPS, split into
  OK/KO series) — plus OpenAPI.
- **`apps/worker`** — claims queued ingest jobs, decompresses the whole bundle
  into memory (a deliberate design choice, not a streaming parse — see
  `packages/storage/src/bundle.ts`'s `openTarGzBundle`, spec §5.1), runs the
  aggregation engine and SLA evaluation behind an async contract, and
  persists the result. It runs in its own process and event loop, so a slow
  parse can never block API latency.

Both apps are built from, and depend on, the packages below; `api` cannot
import the parsing or aggregation packages directly — ingestion happens only
in the worker.

## Packages

| Package                       | Responsibility |
|--------------------------------|----------------|
| `@perfportal/core`             | Canonical event model, run metadata, error taxonomy. No I/O. |
| `@perfportal/contracts`        | Shared HTTP request/response schemas used by the API and its tests. |
| `@perfportal/plugin-gatling`   | The Gatling adapter: parses `simulation.log` into canonical events. Pure. |
| `@perfportal/statistics`       | Bucketing, DDSketch percentiles, warm-up handling, stats rollups. Pure functions. |
| `@perfportal/sla`              | SLA rule evaluation against persisted statistics. |
| `@perfportal/persistence`      | Prisma schema/migrations plus raw-SQL repositories and metric writers/readers. |
| `@perfportal/storage`          | S3-compatible blob store and tar.gz bundle source. |

Packages marked "pure" are forbidden by lint rule from touching the
filesystem, the network, or the database (`eslint.config.js`,
`no-restricted-imports`) — parsing and aggregation stay testable with a
fixture directory and nothing else.

## Local setup

Local infrastructure (Postgres, Redis, MinIO), environment variables, first
run, and how to post a run by hand are all in **[`infra/README.md`](infra/README.md)**.

Quick path:

```bash
nvm use
docker compose -f infra/docker-compose.yml up -d
pnpm install
pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
pnpm build
pnpm bootstrap          # mints an org/project/API token — see infra/README.md
pnpm test              # unit
pnpm test:integration   # needs the services above
```

## Authentication

`apps/api` mounts Better Auth at `/auth/*` (built from `@perfportal/persistence`'s
`createAuth`, see `packages/persistence/src/auth.ts`) beside `/v1`. Two
credential types are accepted on `/v1`, for different callers:

| Credential          | For           | Names           | Obtained via |
|----------------------|----------------|------------------|--------------|
| API token (bearer)  | CI / machines  | An org *and* a project | `pnpm bootstrap` — see `infra/README.md` |
| Session cookie       | Humans         | An org only, no project | `POST /auth/sign-up/email` / `/auth/sign-in/email`, or `pnpm bootstrap --admin-email <email>` |

Because a session names no project, **ingest requires a token**:
`POST /v1/runs` and `GET /v1/projects/{slug}/runs` both reject a session with
a `400 PROJECT_REQUIRED`, naming a project token as the fix. Their
remediation text points ingest-with-a-session at `GET /v1/runs` as the
org-wide, session-reachable equivalent for listing. `GET /v1/runs` is
scoped by *credential*, not by URL: a project-scoped bearer token sees only
that project's runs (the same restriction `GET /v1/projects/{slug}/runs`
enforces), while a session sees every run across its whole org. Both forms
support `limit` and `cursor` for cursor pagination. Every other `/v1` route
that takes a run id accepts either credential and scopes results to that
credential's own org.

**Deviation from decision D-1:** `/v1` always returns RFC 9457
`application/problem+json` with a required `remediation` field. `/auth/*` is
Better Auth's own surface and keeps Better Auth's native error shapes — this
is a deliberate, scoped exception, not an oversight; an `/auth/*` error body
has no `remediation` field to expect.

`BETTER_AUTH_URL` (optional, defaults to `http://localhost:<PORT>`) sets the
base URL Better Auth derives `trustedOrigins` from — its CSRF origin check.
The default is fine locally; **set it to the service's public origin in any
real deployment.**

**The session cookie requires TLS.** `packages/persistence/src/auth.ts` mints
it with `secure: true` unconditionally, so on a non-TLS deployment reachable
by hostname (not `localhost`), a browser never stores it — every session
attempt then looks identical to "no credential" and lands on `/v1`'s generic
401. If session sign-in behaves as though it silently does nothing on a real
deployment, check that the deployment is served over HTTPS before suspecting
the auth code.

## The verdict contract

`POST /v1/runs` and `GET /v1/runs/{id}` return the same status code
for the same run state, so a CI poll loop is identical to the initial post:

| Code       | Run state          | Meaning to CI |
|------------|---------------------|---------------|
| `200`      | complete · pass     | Ingested; all SLA rules held. |
| `422`      | complete · breach    | Ingested successfully — the gate failed. Body lists every breached rule with actual vs. threshold. |
| `202`      | pending / parsing    | Still working. `Retry-After` header and a `statusUrl` body field are returned (no `Location` header). |
| `400`      | failed               | Bundle could not be parsed — including an unrecognised archive (`BUNDLE_NOT_ARCHIVE`). Body names likely cause and fix. |
| `401`/`403`| —                    | Invalid or revoked token / token not scoped to this project. |
| `413`      | —                    | Bundle over the decompressed-size cap. |

**On 422:** this is a deliberate abuse of the status code — the run ingested
perfectly and the gate failed, whereas 422 semantically means the request
could not be processed. It is used so CI can gate on an exit code without
extra scripting; 422 is the least-wrong code available. **422 means the
performance gate failed, not that the upload was bad.**

A run with no SLA rules configured completes with verdict `not_evaluated`,
which is not a failure state.

## Proving it end to end

`apps/api/test/parity.e2e.test.ts` is the keystone test: it posts the whole
Gatling reference report bundle over HTTP, runs the real pipeline, and
asserts the exact statistics the fixture is known to produce (895 requests,
871/24 OK/KO, max 2503ms, mean 228ms, stddev 370ms, indicator bands
848/0/23/24, and the 500/503 error counts) — figures verified independently
of this stack, so if ingest, persistence, or serialization corrupts
anything, the numbers move.

The parity suite now asserts every data row in `PerfPortal_Enterprise_PRD.md`
Appendix A by name (`PT-G-*`, `PT-RQ-*`, `PT-GR-*` test names map directly to
matrix rows), including the distribution, users, and scatter endpoints above.
One number is easy to misread there: the fixture's true global minimum
response time is **16ms**, not the **28** the response-time distribution
chart's first bin appears to show — that `28` is the midpoint label of the
first of 100 bins (§A.9 F-8), not the minimum.
