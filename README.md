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
| API token (bearer)  | CI / machines  | An org *and* a project | `pnpm bootstrap` (see `infra/README.md`) for the first token, or, once signed in, `POST /v1/projects/{slug}/tokens` — see below |
| Session cookie       | Humans         | An org only, no project | `POST /auth/sign-up/email` / `/auth/sign-in/email`, or `pnpm bootstrap --admin-email <email>` |

### Minting, listing and revoking API tokens

A signed-in human (session cookie only — **a bearer token cannot mint another
token**, even one holding every scope the caller already has; see
`SessionOnlyGuard`) manages a project's API tokens through three routes:

```text
POST   /v1/projects/{slug}/tokens          mint  — { name, scopes } → { token, prefix, name, scopes, createdAt }
GET    /v1/projects/{slug}/tokens          list  — never returns the secret or the hash
DELETE /v1/projects/{slug}/tokens/{prefix} revoke — idempotent; a retry returns the original revokedAt
```

`token` is returned **once**, at mint — only its hash is persisted, so a lost
token means minting a replacement, not recovering the old one. `prefix` is the
value to use for `DELETE`: it is everything up to the last underscore of
`pp_<hex>_<secret>` (i.e. `pp_<hex>` itself, including the `pp_`), not the
segment between the two underscores.

A token may carry any of four scopes, and a caller can request any
combination it wants — this grants nothing a signed-in session in that org did
not already have, except `telemetry` and `stream`, neither of which any
session ever holds:

| Scope       | Grants |
|-------------|--------|
| `ingest`    | `POST /v1/runs` — upload a result bundle. |
| `read`      | Every bearer-reachable `GET` under `/v1`. Not the token list above: these three routes are session-only and reject a bearer token whatever scopes it carries. |
| `telemetry` | `POST /v1/telemetry` only — host counters from a load generator, and nothing else. Deliberately its own scope rather than a reuse of `ingest`, so a token living on a shared, often-ephemeral load generator can do exactly one thing. |
| `stream`    | `POST /v1/runs/live`, `POST /v1/runs/{id}/stream`, `POST /v1/runs/{id}/close` — nothing else. Deliberately its own scope rather than a reuse of `ingest`, for the same reason `telemetry` is: the token lives on a load generator — the least-trusted, most disposable host in a deployment, often shared across a fleet — and `ingest` would let it upload a finished bundle for the whole project. |

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

| Code       | Run state              | Meaning to CI |
|------------|-------------------------|---------------|
| `200`      | complete · pass         | Ingested; all SLA rules held. |
| `200`      | incomplete              | Closed without completing a normal ingest: a live run whose `close` received zero bytes, or one whose producer went silent long enough for the sweeper to finalize it (see "Streaming a run live"). Verdict is always `not_evaluated`: this never passes a gate, because a partial run could otherwise satisfy every SLA rule purely by having stopped early. |
| `422`      | complete · breach       | Ingested successfully — the gate failed. Body lists every breached rule with actual vs. threshold. |
| `202`      | pending / parsing / running | Still working. `Retry-After` header and a `statusUrl` body field are returned (no `Location` header) — identical whether the run is queued, being parsed, or still being streamed to. |
| `400`      | failed                  | Bundle could not be parsed — including an unrecognised archive (`BUNDLE_NOT_ARCHIVE`). Body names likely cause and fix. |
| `401`/`403`| —                       | Invalid or revoked token / token not scoped to this project. |
| `413`      | —                       | Bundle over the decompressed-size cap. |

**On 422:** this is a deliberate abuse of the status code — the run ingested
perfectly and the gate failed, whereas 422 semantically means the request
could not be processed. It is used so CI can gate on an exit code without
extra scripting; 422 is the least-wrong code available. **422 means the
performance gate failed, not that the upload was bad.**

A run with no SLA rules configured completes with verdict `not_evaluated`,
which is not a failure state. `incomplete` reaches the same verdict for a
different reason: it is not that no rule applied, but that no rule ever got
the chance to, because the run never reached a finished pipeline run at all.

Every row above is produced by one function, `RunsService.statusFor`, used by
both `POST /v1/runs` and `GET /v1/runs/{id}` — that sharing is the "same code
for the same state" guarantee this table describes, made structural rather
than aspirational.

## Streaming a run live

A load generator that already writes `simulation.log` incrementally can skip
the upload-a-finished-bundle path (`POST /v1/runs`) and stream bytes as they
are produced, through three routes that require the `stream` scope (see
above) and, like ingest, accept only a bearer token — a session names no
project, so it can never satisfy any of them:

```text
POST /v1/runs/live         open    { tool, environment?, branch?, commitSha?, idempotencyKey? }
                                    → 201 { runId, streamUrl, nextOffset }
POST /v1/runs/{id}/stream  stream  raw chunk bytes, "X-Stream-Offset" header required
                                    → 202 { nextOffset }  or  409 { …, nextOffset }
POST /v1/runs/{id}/close   close   no body
                                    → shares POST /v1/runs's 200/202/400/413/422 table above
```

`open` puts the run into the `running` state immediately — there is nothing
to wait for yet — and returns `nextOffset`, the byte offset to start (or
resume) streaming at. `idempotencyKey` makes a retried `open` (say, after a
lost response) rejoin the run it already created instead of starting a
second one.

**Exactly one process may stream a given run.** The offset protocol below
makes an agent's own retries safe, and it makes two *sequential* writers
safe, but it does not serialize two writers that overlap: both can read the
same cursor, both can then write their own bytes to the object keyed by that
one offset, and only one of them wins the compare-and-set that advances the
cursor. The stored bytes are then whichever `put` landed last while the
cursor describes whichever advance won — a run whose assembled log does not
match its own byte count, with nothing downstream able to tell. Hand the
`runId` to one agent. If a producer is restarted, it resumes from
`nextOffset`; it does not run alongside the old one.

Every `stream` call carries the chunk as **raw bytes under a Content-Type
the server does not parse** — send `application/octet-stream`. A body sent as
`application/json` or `application/x-www-form-urlencoded` is consumed by the
framework's own body parser before the route sees it, and is rejected with
`400 STREAM_BODY_CONSUMED`.

Every `stream` call also carries `X-Stream-Offset`, a required request header
naming the byte offset this chunk's body begins at. The server holds the
run's own byte cursor and judges the header against it **before writing
anything**:

- **Offset equals the cursor.** The expected next chunk: it is appended, the
  cursor advances, and the response is `202 { nextOffset: <new cursor> }`.
- **Offset is BEHIND the cursor — a replay.** Nothing is written. The
  response is still `202 { nextOffset: <cursor> }`, the same shape as a
  fresh accept. This is what makes an agent's own retries idempotent:
  resending a chunk whose response was lost, or that already landed, is
  always safe, because it is a pure acknowledgment, never a rewrite.
- **Offset is AHEAD of the cursor — a gap** — or the run is no longer
  `running` (already closed): `409`, `application/problem+json`, naming
  `nextOffset` (the real cursor) to resume from. The two cases share one
  response because the caller cannot act on them any differently.

Getting this backwards is the one mistake that corrupts a run silently: a
gap accepted and written anyway becomes an orphan chunk that `close`'s
assembly step folds into the log at the wrong position regardless, and the
checksum taken of that already-corrupted assembly still passes — nothing
downstream ever notices. Reading the cursor before any write, for both the
gap and the replay case, is what keeps that unconstructible.

Two separate limits answer `413`, and they bound different things: a single
chunk body over `MAX_STREAM_CHUNK_BYTES` (8 MiB by default — the API buffers
a chunk in memory to judge it, so this is deliberately far below a whole
run), and a chunk that would carry the run's cumulative accepted bytes past
`MAX_BUNDLE_BYTES`, the same limit `POST /v1/runs` enforces. Both use the
`BUNDLE_TOO_LARGE` code; the problem+json says which one was hit, because
the first is fixed by re-chunking and the second is not.

`close` finalizes the run. A run that received at least one byte is
assembled and queued through the same pipeline a bundle upload runs through,
so its response shares `POST /v1/runs`'s 200/202/400/413/422 state machine
above. A run closed having received zero bytes finalizes immediately as
`incomplete` instead (`200`, `verdict: not_evaluated`; see the verdict
contract above). Closing a run that is not currently `running` — already
closed, or never a live run — is a `409`.

**A run whose producer never calls `close` does not stay open.** The worker's
sweeper finalizes a `running` run as `incomplete` once its byte cursor has not
moved for `RUNNING_STALE_AFTER_MS` (10 minutes by default). That threshold is
on silence, not on run length: a live run streams for as long as the load test
does, and only the time since its last accepted chunk counts against it.

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
