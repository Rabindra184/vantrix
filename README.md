# PerfPortal

A performance-testing analytics platform. It ingests performance-test result
bundles (currently: Gatling), aggregates them into exact and estimated
statistics, evaluates them against SLA rules, and serves the results over
HTTP.

Licensed under [Apache-2.0](LICENSE).

## Names you will see

**PerfPortal is the product. Vantrix is the published-artifact namespace.**
Two names in one repository looks like a rename half-done; it is not, and
knowing which is which saves reading the wrong docs.

| You will see | Where | What it is |
|--------------|-------|------------|
| `PerfPortal` | the UI, this README, `@perfportal/*` packages, `PERFPORTAL_*` variables | The product and the source tree. |
| `Vantrix` | `dev.vantrix.gatling` (the Gradle plugin id), `dev.vantrix:gatling-gradle-plugin` (its Maven coordinates), `VANTRIX_*` variables, `github.com/Rabindra184/vantrix/agent` (the Go module path) | The **stable namespace of things published outside this repository** — coordinates other people's builds already resolve, and environment variables already set on their CI. |

Those coordinates are load-bearing for consumers, so they are deliberately
NOT being renamed: changing a plugin id breaks every `plugins { id(...) }`
block already written against it, and changing a Go module path breaks every
`import`. New surfaces take `PerfPortal`/`PERFPORTAL_*`; the four Vantrix
names above stay.

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
- **`apps/runner`** — single-node on-prem Gatling executor. The UI queues an
  uploaded Gatling jar or runnable bundle; this process claims one queued job at a
  time, starts Gatling locally, tails `simulation.log` while it is written, and
  closes the live run into the normal worker/report pipeline.

These apps are built from, and depend on, the packages below; `api` cannot
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
export PERFPORTAL_DB_PASSWORD='change-me'
export PERFPORTAL_S3_ACCESS_KEY='change-me'
export PERFPORTAL_S3_SECRET_KEY='change-me-too'
docker compose -f infra/docker-compose.yml up -d
pnpm install
pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
pnpm build
# --admin-email as well as the API token: `pnpm bootstrap` on its own mints a
# machine credential and nothing that can sign in, and the login page has no
# sign-up link (deliberately — see Authentication below). Without this flag
# the stack comes up with no way for a human to reach the dashboard.
pnpm bootstrap --admin-email you@example.test
pnpm test              # unit
pnpm test:integration   # needs the services above
```

Both credentials are printed once, to stdout: an API token (`pp_…`) for CI and
a generated password for the admin account. Copy them now — the token is
stored only as an Argon2id hash and the password only as Better Auth's own
hash.

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

**The session cookie requires TLS anywhere but loopback.**
`packages/persistence/src/auth.ts` mints it `Secure` unless the base URL's
host is `localhost`, `127.0.0.1` or `[::1]`. So on a non-TLS deployment
reachable by hostname a browser never stores it — every session attempt looks
identical to "no credential" and lands on `/v1`'s generic 401. That is
deliberate: a session cookie a browser will send in the clear across a real
network is one an attacker on the path can read. If sign-in behaves as though
it silently does nothing on a real deployment, check that it is served over
HTTPS before suspecting the auth code.

**The loopback exemption exists because Safari needs it.** Measured with a
three-engine probe against a plain-HTTP loopback server setting one `Secure`
cookie: Chromium and Firefox stored it, WebKit did not. Loopback is a
potentially-trustworthy origin by every browser's own spec — there is no
network between the two ends — but WebKit does not extend `Secure` handling to
it. Without the exemption **nobody can sign in to a local instance in
Safari**, and the WebKit end-to-end project cannot get past the login form.

## Deploying it

`infra/docker-compose.yml`'s `onprem` profile builds and runs the whole
platform on one node. Three things about it are not optional, and each one
fails in a way that does not name itself:

**`PERFPORTAL_AUTH_SECRET` is required.** It becomes `BETTER_AUTH_SECRET`,
which signs every session cookie. Better Auth refuses to run on its built-in
default when `NODE_ENV=production` — which `infra/Dockerfile` sets — but it
refuses from an async context nothing awaits until the first `/auth` request,
so the symptom of forgetting it used to be a container that started, passed
its health check, served the SPA, and then failed every sign-in forever.
`apps/api/src/config.ts` now checks it at startup instead, so the container
exits immediately with a message naming the variable. Generate one with
`openssl rand -base64 32`; anything under 32 characters is refused.

**`PERFPORTAL_PUBLIC_URL` must be the origin a browser will actually use.**
It becomes `BETTER_AUTH_URL`, which is what Better Auth derives its
trusted-origin (CSRF) check from. Left at the default, a deployment reached at
`https://perf.example.com` refuses its own sign-in as an invalid origin.

**It must be behind TLS, and the compose file provides none.** The session
cookie is minted `secure: true` unconditionally, so a browser stores nothing
over plain HTTP unless the host is literally `localhost` — sign-in appears to
succeed and every subsequent request 401s. Terminate TLS in front of it
(Caddy, nginx, a cloud load balancer) and forward to the `api` service's port
3000. The proxy must set `X-Forwarded-Proto: https`; that header is the only
thing the API reads from a proxy, and it decides one thing — whether to send
`Strict-Transport-Security`. A two-line Caddyfile is enough:

```
perf.example.com {
    reverse_proxy api:3000
}
```

`infra/docker-compose.yml` ships that as an opt-in `tls` profile — see
`infra/README.md`. The proxy is also the right place to compress **dynamic**
responses: the API precompresses its static assets at build time (below) but
sends JSON uncompressed, and a run's `/series` payload is not small.

### Security headers

`apps/api/src/security-headers.ts` sets them on every response — the SPA's
assets, `/auth/*` and `/v1` alike — because it is mounted ahead of all three
on the same Express instance. `X-Powered-By` is disabled, and the set is
`Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Resource-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`,
and `Strict-Transport-Security` on TLS requests only.

Two things about the CSP are worth knowing before changing anything:

- **`script-src` carries no `'unsafe-inline'`** and instead carries a
  `sha256-` hash of `index.html`'s theme script — computed at boot from the
  built file, never written down, so editing those five lines cannot silently
  break the page.
- **`style-src` does carry `'unsafe-inline'`**, and that is the weakest line
  in the policy. ECharts writes inline `style` attributes on every render and
  there are up to ten charts on a run page; the choice is that or no charts.

`/v1/docs` (Swagger UI) gets its own, looser policy — it is a third-party page
whose inline script changes with its own version, so hashing it would break on
a dependency bump with a blank page and no other signal.

### How the SPA is delivered

Three changes, and the numbers are measured against a real server rather than
estimated:

**Every authenticated route is a lazy chunk.** `App.tsx` used to import all of
them statically, so the login page downloaded and parsed **1,117,911 bytes** of
JavaScript — the whole app, `echarts` included — to render an email field and
a password field. `echarts` is now its own 611 KB chunk that only the five
chart routes pull.

**Assets are precompressed at build time**, not per request: a Vite plugin
(`apps/web/vite.config.ts`) writes `.br` and `.gz` beside each compressible
asset, and `apps/api/src/spa.ts` negotiates. Compressing once per build rather
than once per reader is what makes brotli quality 11 affordable.

**Fingerprinted assets are `immutable`, `index.html` is `no-cache`.** Vite
fingerprints every asset, so a given `/assets/…` URL's content cannot change —
that is exactly the condition `immutable` describes, and `express.static`'s
default was `max-age=0`, revalidating a megabyte on every reload.
`index.html` has to be the opposite: its URL is stable while its content names
the current fingerprints, so a cached copy points at assets the next deploy
deleted.

Together, the login page went from **1,117,911 bytes of uncompressed
JavaScript to 101,893 bytes over the wire** — everything it fetches, including
the CSS and the document.

### Releases

Pushing a tag `v<semver>` (`.github/workflows/release.yml`) publishes three
things, and nothing publishes without a tag:

| Artefact | Where | Consumed by |
|----------|-------|-------------|
| `ghcr.io/<owner>/perfportal:<version>` and `:latest` | GitHub Container Registry | `docker run`, or `image:` in place of `build:` in a compose file |
| `dev.vantrix:gatling-gradle-plugin:<version>` | GitHub Packages | the Gradle plugin, `clients/gatling-gradle` |
| `perfportal-agent-{linux,darwin}-{amd64,arm64}` + `SHA256SUMS` | the GitHub Release | load generators, see [`agent/README.md`](agent/README.md) |

The image is `linux/amd64` only. A multi-arch build would run the whole
`pnpm install && pnpm build` under QEMU for arm64, which takes tens of minutes
and starts timing out rather than failing cleanly; an amd64 image still runs
on Apple Silicon under emulation.

`main` separately republishes the plugin as `0.1.0-SNAPSHOT` on every push, for
the bleeding edge. **GitHub Packages rejects unauthenticated Maven downloads
even from a public repository**, so a plugin consumer needs a personal access
token with `read:packages` — see [`clients/gatling-gradle/README.md`](clients/gatling-gradle/README.md).
That is a GitHub Packages property, not a choice this project made; publishing
to the Gradle Plugin Portal or Maven Central would remove it and is the open
item there.

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
POST /v1/runs/live         open    { tool, environment?, branch?, commitSha?, test?, idempotencyKey? }
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

`test` names which TEST the run belongs to, as a slug (`checkout-soak`, never
`"Checkout soak"`) — the same optional field `POST /v1/runs` takes as
`metadata.test`. Omit it and the run groups by the simulation class its log
header declares, which is what every run did before the field existed. Set it
to run ONE simulation as TWO tests with different injection profiles: a smoke
on every merge and a soak overnight are not comparable, and one trend line
over both hides them both. A slug naming no existing test creates it.

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

### How the worker learns about a stream

Bytes accepted above land in blob storage, never in Redis. A dedicated worker
process (`LiveFoldOwner`) folds the chunk objects of a `running` run into a
live, incrementally-maintained set of statistics and publishes a delta on a
timer. Redis carries five channels for this, and none of them carry the bytes
themselves — only notifications and computed deltas:

| Channel | Direction | Carries |
|---|---|---|
| `live:opened` | API → worker | a run id, on a successful `POST /v1/runs/live` |
| `live:advance` | API → worker | a run id, when a chunk is **accepted** (not on a gap or a replay) |
| `live:closed` | API → worker | a run id, when `POST /v1/runs/:id/close` claims it off `running` |
| `live:{runId}` | worker → subscribers | a delta, published each tick |
| `live:{runId}:deltas` | worker → replay | the same delta, appended to a stream capped by a byte budget |

**None of the five ever carries bytes.** The bytes are already durable in
blob storage by the time any API-side channel is published to — that is
the whole reason these are notifications rather than a queue: duplicating a
run's bytes into Redis as well would mean storing every byte twice.

`live:opened` and `live:advance` are optimisations over the worker's own poll
of `running` runs, never replacements for it. Redis pub/sub has no
persistence, so a message published while every worker is down (a deploy, an
outage) reaches nobody — it is the poll, not either channel, that makes a run
opened during an outage eventually fold.

**`live:closed` is not an optimisation.** Closing a run enqueues its terminal
parse immediately, and the pipeline takes the same advisory lock the fold
owner is still holding — deliberately, so a run can never be folded and
parsed at once. The pipeline's whole budget for waiting that out is BullMQ's
three attempts on exponential backoff from 2 s, about six seconds, while the
owner's release latency without this channel is one tick interval plus an
unbounded in-flight tick. Exhausting those attempts leaves the run at
`parsing` until the sweeper's 15-minute staleness window notices, so a live
run's worst-case time to a verdict becomes a quarter of an hour. The tick's
own release pass still covers a dropped message; what the channel removes is
the latency, and the latency is the defect.

### The worker's connection budget

Each owned run holds one dedicated Postgres connection for its whole
ownership — the fold owner claims a run on the same advisory lock the
pipeline uses, and that lock must be held and released on one connection.
`apps/worker/src/main.ts` therefore sizes the worker's Postgres pool well
above the driver default of 10, deriving every term from a client some
component actually holds:

| Term | At defaults | Held by |
|---|---|---|
| `maxOwnedRuns` | 25 | one pooled client per owned run, for its lock's lifetime |
| fold-owner discovery | 1 | the tick's `SELECT id FROM run WHERE status = 'running'` |
| `concurrency × 2` | 4 | `PipelineService.process` — the lock client, plus a brief one for its commit |
| sweeper | 1 | one client, `BEGIN` to `COMMIT` |
| **pg pool total** | **31** | |
| Prisma's own pool | 3 | `concurrency + 1`, pinned via `connection_limit` |
| **per worker replica** | **34** | |

**Prisma's pool is a second pool, and it has to be pinned.** `createPrisma`
opens its own, entirely separate pool against the same database. Left
unpinned, Prisma sizes it as `num_physical_cpus × 2 + 1` — roughly 9 to 17
— so a replica that budgeted 31 really took 40 to 48, and the overshoot
varied with the host's CPU count rather than with anything in the code. The
worker now passes an explicit `connectionLimit`; an operator's own
`connection_limit` in `DATABASE_URL` still wins.

Two worker replicas is therefore ~68 connections before a single API
replica, against `postgres:16-alpine`'s stock `max_connections = 100`.
`infra/docker-compose.yml` raises it to 200. **The API's own Prisma pool is
still unpinned** — the API holds no long-lived connections the way the fold
owner does, so it has never been the binding term, but anyone sizing a
production database should count it.

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
