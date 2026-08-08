# PerfPortal

A performance-testing analytics platform. It ingests performance-test result
bundles (currently: Gatling), aggregates them into exact and estimated
statistics, evaluates them against SLA rules, and serves the results over
HTTP.

## Apps

- **`apps/api`** — NestJS on Express (`@nestjs/platform-express`; multipart
  bodies are parsed by `busboy` piped straight from `req`): token auth,
  `POST /v1/runs` (bundle ingest), run/status/verdict reads, stats/series/errors
  reads, OpenAPI.
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
