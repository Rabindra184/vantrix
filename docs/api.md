# PerfPortal HTTP API

Everything the UI does goes through the same `/v1` API that CI and load
generators use. This page covers the parts you need to integrate with it:
how to authenticate, how to send a run, how to read the verdict, and how to
stream a run while it executes.

The complete, always-current reference is generated from the code and served
by every instance:

- **Swagger UI:** `/v1/docs`
- **OpenAPI 3.1 document:** `/v1/openapi.json`

Both are public; everything else under `/v1` needs a credential.

**Contents**

- [Authentication](#authentication)
- [Sending a finished run](#sending-a-finished-run)
- [The verdict contract](#the-verdict-contract)
- [Streaming a run live](#streaming-a-run-live)
- [Endpoint map](#endpoint-map)
- [Errors](#errors)

---

## Authentication

Two credential types are accepted on `/v1`, for two kinds of caller:

| Credential | For | Scoped to | Obtained via |
|---|---|---|---|
| **API token** (`Authorization: Bearer pp_…`) | CI, load generators, scripts | one org **and** one project | the project's **API tokens** page, or `POST /v1/projects/{slug}/tokens` |
| **Session cookie** | people, in a browser | one org (no project) | signing in at `/login` (Better Auth, mounted at `/auth/*`) |

A session sees every project in its org. A token sees exactly one project,
and only what its scopes allow.

### Managing API tokens

Tokens are managed by a signed-in person. **A bearer token can never mint,
list or revoke tokens**, whatever scopes it carries.

```text
POST   /v1/projects/{slug}/tokens           mint   { name, scopes, expiresAt? } → { token, prefix, … }
GET    /v1/projects/{slug}/tokens           list   (never returns the secret or its hash)
DELETE /v1/projects/{slug}/tokens/{prefix}  revoke (idempotent)
```

- The plaintext `token` is returned **once**, at mint. Only an Argon2id hash
  is stored, so a lost token is replaced, not recovered.
- `prefix` is everything before the last underscore of `pp_<hex>_<secret>`,
  i.e. `pp_<hex>`. That is the value `DELETE` takes.
- `expiresAt` is optional. Omit it for a token that lives until revoked. An
  expired or revoked token answers `401`, and says which.

### Scopes

| Scope | Shown in the UI as | Grants |
|---|---|---|
| `ingest` | Completed reports | `POST /v1/runs`: upload a finished result bundle. |
| `read` | Read dashboards | Every bearer-reachable `GET` under `/v1`. |
| `stream` | Live run stream | `POST /v1/runs/live`, `…/{id}/stream` and `…/{id}/close`, and nothing else. |
| `telemetry` | Generator telemetry | `POST /v1/telemetry` only: host counters from a load generator. |
| `runner` | On-prem runner | Queue, cancel and retry on-prem runner jobs, and manage packages. |

`stream` and `telemetry` are deliberately separate from `ingest`. A token
that lives on a load generator, often a shared and disposable host, should
be able to do exactly one thing.

### Which credential can send a run

| Route | Credential | Why |
|---|---|---|
| `POST /v1/runs` | token with `ingest` | CI's path. |
| `POST /v1/runs/live` (+ `stream`, `close`) | token with `stream` | The Gradle plugin's path. |
| `POST /v1/projects/{slug}/runs` | session only | The browser upload on **Add results**. |

A session names no project, so `POST /v1/runs` and the live routes refuse it
with `400 PROJECT_REQUIRED`. The project-scoped route exists so the browser
can upload without a token; a token already names its project and does not
need it.

`GET /v1/runs` is scoped by *credential*, not by URL. A project token sees
that project's runs; a session sees every run in its org. Both support
`limit` and `cursor` pagination.

### Sessions and cookies

- **`BETTER_AUTH_URL` must be the origin a browser uses.** Better Auth
  derives its CSRF check (`trustedOrigins`) from it, so a mismatch makes
  sign-in fail with *Invalid origin*. It defaults to
  `http://localhost:<PORT>`. In the Docker deployment it is set from
  `PERFPORTAL_PUBLIC_URL`.
- **The session cookie is `Secure` by default**, except on `localhost`,
  `127.0.0.1` and `[::1]`. Over plain HTTP on any other host, a browser
  silently drops it, and every request after sign-in looks unauthenticated.
  Serve the app over HTTPS, or set `ALLOW_INSECURE_COOKIES=true` (in the
  Docker deployment, `PERFPORTAL_ALLOW_INSECURE_COOKIES`) on a network you
  trust. An HTTPS origin always gets a `Secure` cookie, even with the flag
  on.
- **Why loopback is exempt:** WebKit does not store a `Secure` cookie from
  plain-HTTP loopback, while Chromium and Firefox do. Without the exemption,
  nobody could sign in to a local instance in Safari.
- **API tokens are unaffected by any of this.** A bearer header works over
  plain HTTP, so CI can talk to an internal instance without TLS.

---

## Sending a finished run

Archive the Gatling results directory (the one holding `simulation.log`) as
a `.tgz` and post it as multipart form data: a JSON `metadata` field, then a
`bundle` file part.

```bash
tar -czf results.tgz -C build/reports/gatling <run-directory>

curl -sS -X POST "$PERFPORTAL_URL/v1/runs" \
  -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
  -F 'metadata={"tool":"gatling","environment":"staging","branch":"main"}' \
  -F 'bundle=@results.tgz' \
  -o response.json -w '%{http_code}\n'
```

| `metadata` field | Required | Meaning |
|---|---|---|
| `tool` | yes | `gatling`, the only supported tool today. |
| `environment`, `branch`, `commitSha` | no | Stored on the run, shown on its page, and used to tell comparable runs apart. |
| `test` | no | Which **test** the run belongs to, as a slug (`checkout-soak`). Omit it to group by the simulation class. Set it to run one simulation as two tests, e.g. a smoke on every merge and a soak overnight. An unknown slug creates the test. |
| `idempotencyKey` | no | Makes a retried upload return the run it already created. Also accepted as an `Idempotency-Key` header. |
| `waitMs` | no | How long to wait for a verdict before answering `202` (default 25 s, max 120 s). `0` answers immediately. |

---

## The verdict contract

`POST /v1/runs` and `GET /v1/runs/{id}` return the **same status code for
the same run state**, so a CI poll loop is identical to the first post:

| Code | Run state | Meaning to CI |
|---|---|---|
| `200` | complete, passed | Ingested; every SLA rule held. |
| `200` | complete, not evaluated | Ingested; no SLA rule applied to this run. |
| `200` | incomplete | The run stopped early (a live run closed with no bytes, or its producer went silent). Verdict is `not_evaluated`, so a partial run can never pass a gate by stopping early. |
| `422` | complete, failed | **Ingested successfully; the performance gate failed.** The body lists every breached rule with actual against threshold. |
| `202` | pending, parsing or running | Still working. Poll the `statusUrl` in the body after the `Retry-After` header. |
| `400` | failed | The bundle could not be read. The body names the likely cause and the fix. |
| `401` / `403` | | Missing, invalid, expired or revoked token, or a token without the scope. |
| `413` | | The bundle is over the size limit. |

**`422` is a deliberate choice.** The upload was fine and the *gate* failed.
`422` lets CI fail a build on the exit code alone, with no extra scripting.

Every row is produced by one function, `RunsService.statusFor`, shared by
both routes, so the two can never disagree.

---

## Streaming a run live

A producer that writes `simulation.log` incrementally can stream it instead
of uploading a finished bundle. This is how the
[Gradle plugin](../clients/gatling-gradle/README.md) works. All three routes
need a token with the `stream` scope.

```text
POST /v1/runs/live         open    { tool, environment?, branch?, commitSha?, test?, idempotencyKey? }
                                    → 201 { runId, streamUrl, nextOffset }
POST /v1/runs/{id}/stream  stream  raw bytes, X-Stream-Offset header required
                                    → 202 { nextOffset }   or   409 { …, nextOffset }
POST /v1/runs/{id}/close   close   no body
                                    → the same 200 / 202 / 400 / 413 / 422 table as above
```

- **`open`** puts the run in `running` immediately and returns the byte
  offset to stream from. A retried `open` with the same `idempotencyKey`
  rejoins the same run.
- **`stream`** sends a chunk as raw bytes. Use
  `Content-Type: application/octet-stream`: a JSON or form body is consumed
  by the framework's parsers before the route sees it, and is refused with
  `400 STREAM_BODY_CONSUMED`.
- **`close`** assembles the chunks and sends them through the same pipeline
  as an upload. A run closed with zero bytes finalizes as `incomplete`.

### The offset protocol

Every chunk carries `X-Stream-Offset`, the byte offset its body starts at.
The server holds the run's cursor and judges the header **before writing
anything**:

| Offset | Result |
|---|---|
| equals the cursor | Appended. `202 { nextOffset: <new cursor> }`. |
| **behind** the cursor (a replay) | Nothing written. Still `202 { nextOffset: <cursor> }`, which makes retries always safe. |
| **ahead of** the cursor (a gap), or the run is no longer running | `409` naming the real `nextOffset` to resume from. |

**Exactly one process may stream a given run.** The protocol makes an
agent's own retries safe, and makes two *sequential* writers safe, but two
writers that overlap can corrupt the assembled log. A restarted producer
resumes from `nextOffset`; it does not run beside the old one.

### Limits and timeouts

- A single chunk over `MAX_STREAM_CHUNK_BYTES` (8 MiB by default) answers
  `413`. Re-chunk and resend.
- A chunk that would take the run past `MAX_BUNDLE_BYTES` (the same limit an
  upload has) also answers `413`. Both use the code `BUNDLE_TOO_LARGE`, and
  the message says which limit was hit.
- A run whose producer never calls `close` does not stay open forever. The
  worker finalizes it as `incomplete` once no chunk has been accepted for
  `RUNNING_STALE_AFTER_MS` (10 minutes by default). The clock is the time
  since the last chunk, not the length of the run, so a long soak is safe.
  What the run measured before it stopped is kept.

---

## Endpoint map

A map of the families, not a reference. Use `/v1/docs` for parameters and
response shapes.

| Path | What lives there |
|---|---|
| `/v1/runs` | Upload a run (`POST`); list runs across the org (`GET`). |
| `/v1/runs/live`, `/v1/runs/{id}/stream`, `/v1/runs/{id}/close` | Live streaming. |
| `/v1/runs/{id}/live` | WebSocket: the live page's feed of statistics deltas while a run streams. |
| `/v1/runs/{id}` | A run's status, verdict and identity; `PUT …/note` for its note. |
| `/v1/runs/{id}/stats`, `series`, `errors`, `errors/series`, `distribution`, `users`, `scatter` | The statistics and chart data behind the run page. Most accept a `from`/`to` time window in ms. |
| `/v1/runs/{id}/telemetry`, `trends`, `events` | Load-generator samples, run-over-run trends for the run's test, and the runner's lifecycle log. |
| `/v1/projects` | List and create projects. |
| `/v1/projects/{slug}/runs` | A project's runs (`GET`, token); browser upload (`POST`, session). |
| `/v1/projects/{slug}/tests` | Tests in a project; rename or delete one. |
| `/v1/projects/{slug}/rules` | SLA rules: project-wide or for one test. |
| `/v1/projects/{slug}/tokens` | API tokens (session only). |
| `/v1/projects/{slug}/runner`, `/v1/projects/{slug}/packages` | On-prem runner jobs and reusable packages. |
| `/v1/tests`, `/v1/activity` | The org-wide test catalogue (used by ⌘K search) and the Home page summary. |
| `/v1/telemetry` | Load-generator agent samples (`POST`). |
| `/healthz`, `/readyz` | Liveness and readiness probes. |

---

## Errors

Every `/v1` error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
`application/problem+json` with a machine-readable `code` and a
`remediation` field that says what to do about it:

```json
{
  "type": "https://perfportal.dev/errors/UNAUTHENTICATED",
  "title": "unauthenticated",
  "status": 401,
  "code": "UNAUTHENTICATED",
  "detail": "No valid session cookie.",
  "remediation": "Provide a bearer API token in the Authorization header (for CI/machine callers), or sign in at POST /auth/sign-in/email to obtain a session cookie (for a browser)."
}
```

Branch on `status` and `code`. `detail` and `remediation` are written for
people and may be reworded. A `500` carries a `traceId` to quote when you
report it.

`/auth/*` is Better Auth's own surface and keeps Better Auth's native error
shapes, so an `/auth/*` error has no `remediation` field.
