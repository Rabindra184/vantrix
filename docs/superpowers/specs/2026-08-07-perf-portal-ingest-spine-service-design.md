# Ingest Spine Service — Design

**Status:** approved · **Date:** 2026-08-07
**Supersedes:** the infrastructure decisions in [`2026-08-07-perf-portal-m0-ingest-spine-design.md`](2026-08-07-perf-portal-m0-ingest-spine-design.md), which that document's own header already marks as superseded in part.
**Authority:** [`PerfPortal_Enterprise_PRD.md`](../../../PerfPortal_Enterprise_PRD.md) — §16 architecture, §17 API, §18 database, §20 performance, §21 plugins, §26 milestones. Where this design departs from the PRD, §12 below says so and why.

---

## 1. What this builds

One vertical slice through the platform: a Gatling results bundle is posted over HTTP, parsed, aggregated, evaluated against SLA rules, persisted, and read back — with a verdict returned to the caller.

It is the service layer around the three packages already shipped and verified (`@perfportal/core`, `@perfportal/plugin-gatling`, `@perfportal/statistics`). Those packages are consumed unchanged except for one additive contract described in §4.

**Done means:** `docker compose up`, POST the checked-in Gatling fixture bundle, and a `GET` returns statistics that reproduce the parity figures the packages already prove — with the adaptive verdict working end to end. An integration test drives exactly that path.

### 1.1 Why this slice, and not PRD M0 verbatim

PRD §26 defines M0 as foundation (repo, CI, K8s, schema core, auth skeleton, observability) and M1 as the ingest spine. Building M0 literally would deliver a deployable system that does nothing, and would put routine deployment work ahead of the contracts that cannot be changed later.

The ingest contract, the canonical model, and the schema are the hardest-to-reverse decisions in the product, because **history cannot be backfilled, only forward-collected** (§26 sequencing rationale). This slice front-loads exactly those, and every deferred piece — auth, RBAC, K8s, live ingest — bolts onto it without reshaping it.

### 1.2 Out of scope

Named explicitly so implementation cannot drift into them:

- Users, sessions, SSO, RBAC roles, admin UI
- Kubernetes manifests, HPA, production deployment
- WebSockets, live/streaming ingest, incremental aggregation
- Baselines, regression detection, trends, comparison, heatmaps
- Notifications (Slack, webhook, email), digests
- The React UI and any report generation
- Decoding Gatling's assertion protobuf records (stored raw; required for M3 parity, not for this slice)
- Non-Gatling plugins
- The §20.2 throughput budget — see §5.2

---

## 2. Topology and repo layout

Two deployables from one pnpm workspace, matching PRD §16.3 with only the components this slice needs.

```
apps/
  api/                NestJS HTTP. Token auth · POST bundle · read endpoints · bounded verdict wait
  worker/             Plain Node entry point (not a NestJS application — see §12). BullMQ consumer · plugin runtime · engine · SLA · persistence · sweeper
packages/
  core/               SHIPPED — canonical model; gains the plugin contract types (§4)
  statistics/         SHIPPED — unchanged
  plugin-gatling/     SHIPPED — gains a PerfPlugin implementation wrapping parseSimulationLog
  persistence/        NEW — Prisma schema, migrations, repositories, raw-SQL metric writers/readers
  contracts/          NEW — request/response DTOs and Zod schemas, shared by api and (later) the UI
infra/
  docker-compose.yml  Postgres 16 · Redis 7 · MinIO
```

`pnpm-workspace.yaml` gains `apps/*`.

**The ESLint purity rule keeps its current three-package glob.** `core`, `statistics`, and `plugin-gatling` still may not import `node:fs`, `node:http`, `pg`, Prisma, or `@nestjs/*`. This is what allows the plugin to declare an asynchronous contract without acquiring an I/O dependency: the plugin receives an already-opened source and never opens one itself.

`persistence` and `contracts` are new packages rather than folders inside `apps/api`, because the worker and the API both need them and neither should import from the other.

### 2.1 Runtime components

| Component | Count | State |
|---|---|---|
| `api` | ≥1 | Stateless; verdict waiters held in memory per pod, backed by Redis pub/sub |
| `worker` | ≥1 | Stateless; job state in Redis, run state in Postgres |
| Postgres 16 | 1 | All relational and metric data |
| Redis 7 | 1 | BullMQ queue + `run:{id}` pub/sub |
| MinIO | 1 | S3-compatible bundle storage |

There is no separate `scheduler` deployable in this slice. Its one responsibility that matters here — re-claiming orphaned runs — lives in the worker (§6.4).

---

## 3. Pre-flight verification — **executed, passed**

The risk: this workspace is strict ESM with `moduleResolution: bundler`; NestJS is decorator-based with CJS-first tooling, and Prisma and `reflect-metadata` sit between them. If NestJS 11 could not boot cleanly under ESM here, §2's layout would be wrong and the fix structural. Same reason the binary-log and DDSketch spikes existed: this project's expensive mistakes have all been unchecked assumptions.

**Run on 2026-08-07** — NestJS 11.1.6, Prisma 6.19.3, Node 22.19.0. A Nest application with a decorator-injected `PrismaService extends PrismaClient`, a cross-workspace import of `@perfportal/statistics`, `tsc` compilation, and a real boot.

**Result: passes.** No CJS fallback is needed. The apps compile with `module`/`moduleResolution: NodeNext`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, and run as native ESM. DDSketch answered p95 of 1..1000 as 944.05 against a nearest-rank truth of 950 — 0.63%, inside the 1% guarantee, across the package boundary.

Four findings the plan must carry:

**F-1 — the shipped packages cannot be imported at runtime, and this is a blocker.** All three declare `"exports": { ".": "./src/index.ts" }` — raw TypeScript. Node 22.19 strips the types off `index.ts` and then fails on its relative `./sketch.js` import, which does not exist unless the package is built:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/packages/statistics/src/sketch.js'
    imported from …/packages/statistics/src/index.ts
```

This has been invisible because nothing has ever imported these packages from a running process — only vitest and `tsc -b`, both of which read source. The fix, verified working in the spike, is a conditional exports map per package:

```json
"exports": {
  ".": {
    "perfportal-source": "./src/index.ts",
    "types": "./dist/src/index.d.ts",
    "default": "./dist/src/index.js"
  }
}
```

with `resolve.conditions: ['perfportal-source']` in `vitest.config.ts`, so tests keep reading source and need no build, while runtime resolves to `dist`. Consequence: **`tsc -b` must run before either app starts**, in dev and in CI.

**F-2 — a tsconfig mistake fails silently, not loudly.** With `emitDecoratorMetadata: false`, Nest still reports a *successful boot* and injects `undefined`; the failure surfaces only at first use, arbitrarily far away. The plan therefore includes a boot-time assertion that every injected dependency is present, rather than trusting a clean startup log.

**F-3 — never assert injection with `instanceof`.** `new PrismaClient() instanceof PrismaClient` is `false` under Prisma 6 — the client is a Proxy — with no Nest involved. The spike's first assertion was wrong for this reason and reported a failure that did not exist. Injection is asserted by presence and API shape (`typeof prisma.$connect === 'function'`).

**F-4 — the local Node default is below the repo's own floor.** `package.json` declares `engines.node >= 22` and CI pins 22, but the machine's default `node` is v20.20.2; the spike ran on 22.19.0 via nvm. Nothing enforces this locally. The plan adds an `.nvmrc` and a preinstall engine check, since the two runtimes differ in exactly the ESM behavior this design depends on.

The spike was falsified before being trusted — breaking `emitDecoratorMetadata` made it fail — then deleted. The tree is unchanged: lint, `tsc -b`, and 48/48 tests pass on a `--frozen-lockfile` install.

---

## 4. The plugin contract

Added to `@perfportal/core`. It is additive: no existing exported type changes.

```ts
export interface BundleIndex {
  /** Bundle-relative paths, POSIX separators. */
  files: readonly string[];
  /** First N bytes of a named file, for signature sniffing. Never the whole file. */
  head(path: string, bytes: number): Promise<Uint8Array>;
}

export interface BundleSource {
  index: BundleIndex;
  read(path: string): Promise<Uint8Array>;
}

export interface DetectResult {
  matched: boolean;
  /** Tool version as reported by the bundle, when the format carries one. */
  toolVersion?: string;
  /** Populated when matched is false, to explain what was expected. */
  reason?: string;
}

export interface PerfPlugin {
  id: ToolId;
  detect(index: BundleIndex): Promise<DetectResult>;
  parse(source: BundleSource): AsyncIterable<CanonicalEvent>;
  capabilities(): CapabilityDescriptor;
}
```

`BundleSource` is an **interface the worker implements**. The plugin never touches the filesystem or object storage, which keeps the purity rule intact and makes plugins testable from an in-memory bundle.

`parse` returns an `AsyncIterable` even though Gatling's implementation is a synchronous generator wrapped in one. That is deliberate: it is the seam at which a streaming reader can later be substituted without changing the contract, the engine, or any consumer.

`@perfportal/statistics` gains `runEngineAsync(events: AsyncIterable<CanonicalEvent>, opts)` alongside the existing `runEngine`. The synchronous version remains, because every parity test uses it and those tests must not be perturbed.

### 4.1 Gatling detection

`detect` matches when the bundle contains a `simulation.log` whose first byte is the `Run` record type (`0x00`) and whose length-prefixed version string parses as a supported Gatling version. Version support is an explicit allowlist — the format carries **no compatibility guarantee** (PRD §28 R-3), so an unrecognized major is a structured rejection, never a best-effort parse.

---

## 5. Parsing strategy

### 5.1 Decision: in-memory parse behind an async contract

PRD §20.2 mandates a "streaming line-by-line parse with backpressure, never materializing the log." The shipped, parity-verified decoder does the opposite.

That mandate was checked rather than obeyed. The reference fixture is 37,769 bytes for 1,790 records (≈ 21 B/record), and repeated request names cost 4 bytes each after the first because of cached-string back-references. Extrapolated to 5,000,000 request events, the whole log is **roughly 150–250 MB** in memory. Engine state is ~91 MB (§20.2). Events are consumed lazily from the generator and never accumulate. Peak is therefore ≈ 250–350 MB in an 8 GiB worker.

**The memory problem streaming would solve does not exist at the stated scale.** Rewriting the component whose correctness was hardest to establish, to solve it, is a poor trade.

So: the parse stays in memory, behind the async contract of §4, with a **hard bundle-size cap** enforced at upload (§6.1) that rejects with a structured `remediation` rather than exhausting a worker. If measurement later contradicts the extrapolation, the fix is internal to the plugin.

This figure is an extrapolation from one 895-request fixture, not a measurement of a large run. It is recorded as such, and §11 lists it as a tracked risk.

### 5.2 Consequence for §20.2

PRD §20.2 is amended by this design from *"never materializing the log"* to: **bounded, cap-enforced memory; streaming introduced if and when measurement demands it.** The 5M-event throughput target itself is unchanged and remains a later measurement task — the synthetic generator and throughput benchmark already exist in `packages/statistics`.

---

## 6. The ingest path

### 6.1 API side — `POST /v1/runs`

`multipart/form-data`: a `bundle` part (gzipped tar of the Gatling results directory) and a `metadata` JSON part. The project is resolved **from the token, never from the URL** — a credential cannot be pointed at a project it does not belong to.

1. Authenticate the token → `(org_id, project_id, scopes)`; require the `ingest` scope.
2. Validate `metadata` against its Zod schema.
3. If `metadata.idempotency_key` matches an existing run in this project, return that run's current state and stop.
4. Stream the bundle body to object storage, computing SHA-256 inline. **Never buffered in the API process.** Exceeding the size cap aborts with `413 BUNDLE_TOO_LARGE` — Payload Too Large is the accurate code for this specific rejection; see §12.
5. `INSERT run(status='pending', bundle_key, bundle_sha256, bundle_bytes, engine_options)`.
6. Enqueue the BullMQ job.
7. `SUBSCRIBE run:{id}`; wait for a terminal state, bounded (default 25 s, project-configurable).
8. Respond per §7.

**Step order is load-bearing.** The bundle is durable before any row references it, and the run row is committed before the job is enqueued. The database insert and the queue enqueue span two systems and cannot share a transaction, so one inconsistency is reachable: a run with no job. That is recoverable by the sweeper (§6.4). The reverse order yields a job referencing a nonexistent run, which is not recoverable.

`engine_options` is resolved from project settings at step 5 and **frozen onto the run**, not read at parse time. See §8.2.

### 6.2 Worker side

1. Claim the job.
2. Fetch the bundle from object storage; verify SHA-256; read the gzipped tar into memory and present it as a `BundleSource` (§5.1 — no temp directory; see §12).
3. `plugin.detect` over the registry → select a plugin, or reject with `UNSUPPORTED_BUNDLE`.
4. `plugin.parse` → `AsyncIterable<CanonicalEvent>`.
5. `runEngineAsync(events, run.engine_options)`.
6. In one transaction: `COPY` `run_stat`, `run_series_bucket`, `run_error`.
7. Evaluate SLA rules → `run_assertion` rows → run verdict (§8).
8. `UPDATE run(status='complete', verdict)` in the same transaction as 6–7.
9. `PUBLISH run:{id}`.
10. The in-memory bundle buffer is released with the job (nothing to delete — there was never a temp directory). The bundle in object storage is retained.

Steps 6–8 commit together. A run is never observable with statistics but no verdict, or a verdict but no statistics.

### 6.3 Failure

Any failure in steps 2–8 writes the structured `IngestError` to `run.error`, sets `status='failed'`, and publishes. The waiting API client receives the same structured error, with the same status code, that the synchronous path would have produced.

BullMQ retries are limited to failures classified as transient (object storage unavailable, database connection lost). A parse failure, an unsupported bundle, or a cardinality violation is **deterministic and is not retried** — retrying it burns a worker slot to reach the identical conclusion.

### 6.4 Sweeper

A periodic task in the worker claims runs in `pending` older than 60 seconds using `SELECT … FOR UPDATE SKIP LOCKED` and re-enqueues them. `SKIP LOCKED` makes this safe with multiple worker replicas and requires no leader election, which is why no separate scheduler deployable exists in this slice.

---

## 7. The verdict contract

Four status codes. `GET /v1/runs/{id}` returns **the same code for the same state** as `POST` would.

| Code | State | Body |
|---|---|---|
| `200` | Ingested; verdict `passed` or `not_evaluated` | Run header, verdict, assertions |
| `422` | Ingested; verdict `failed` | Run header, verdict, assertions, with failures listed first |
| `400` | Bundle rejected | `IngestError` with required `remediation` |
| `413` | Bundle rejected for exceeding the decompressed-size cap (`BUNDLE_TOO_LARGE`) | `IngestError` with required `remediation` |
| `202` | Still processing | `status_url`, `Retry-After` |

`400` is the general "bundle rejected" bucket — every deterministic ingest failure that is not the size cap (`BUNDLE_NOT_ARCHIVE`, `BUNDLE_EMPTY`, `UNSUPPORTED_BUNDLE`, `ENDPOINT_CARDINALITY_EXCEEDED`, and so on) uses it. `413` is carved out of that bucket specifically for `BUNDLE_TOO_LARGE`, per §12.

That the two paths return identical codes is the contract, not an implementation detail: it is what lets a CI script handle the fast and slow paths with one branch instead of two.

**`202` is a timing outcome, never an error.** The client polls `status_url` and eventually receives the same `200` or `422` the fast path would have returned. A client that treats `202` as failure is misusing the API, and the OpenAPI description says so.

---

## 8. SLA rules and evaluation

### 8.1 Rule model

Absolute thresholds only.

```
sla_rule(scope, target_name, family, metric, comparator, threshold, enabled)

scope        run | request | group | scenario
target_name  NULL for run scope; the request or group name otherwise
family       response_time | latency | group_cumulated | group_duration
metric       p50 | p75 | p90 | p95 | p99 | p99.9 | mean | max | error_rate | throughput_rps | count
comparator   lte | gte
threshold    numeric
```

Relative and noise-aware rules are PRD M5 and are deliberately absent.

### 8.2 Evaluation

Each enabled rule is matched against the `run_stat` row for its `(scope, target_name, family)`.

- **Match found** → compare and record `passed` or `failed`.
- **No match** → record `not_applicable`. Never a silent pass. The distinction between "we checked and it was fine" and "we did not check" is the difference between a gate and a decoration.

Percentile metrics are evaluated **from a summary sketch**, not from the frozen `percentiles` JSONB. A rule may therefore ask for `p99.9` even when the project's stored percentile set is `[50, 75, 95, 99]`. This is the storage decision of §9.1 earning its place on day one rather than in a later milestone.

In this slice, evaluation reads the sketch still held in memory from `runEngineAsync` (§6.2 step 5), not a row re-read from `run_stat` — evaluation happens inside the same transaction that persists it (§12), so the two are the same values by construction. The sketch is persisted regardless, and that persisted copy is what later re-evaluation reads: a rule added or edited after ingestion, or a project asking for `p99.9` a year from now, is evaluated by reloading the stored `bytea` and deserializing it (`MetricReader.sketch`), not by re-parsing the bundle.

Every `run_assertion` stores a **snapshot of the rule as it read at evaluation time**. Editing a threshold must never rewrite the history of what passed.

### 8.3 Run verdict

- Any assertion `failed` → `failed`
- Otherwise, at least one `passed` or `failed` → `passed`
- No rules, or all `not_applicable` → `not_evaluated`

`not_evaluated` returns `200`. A project with no rules is not failing; it is not gating.

### 8.4 Why platform rules, not Gatling's assertions

The verdict is decided by platform-owned rules. Gatling's own assertion records are stored raw and undecoded.

The platform must be tool-neutral: the same rule model has to work for k6 and JMeter in M9, and a verdict derived from one tool's assertion syntax cannot generalize. Decoding Gatling's assertion protobuf is genuinely required for M3 report parity — it is deferred to M3, where it belongs, not pulled into the ingest contract.

---

## 9. Data model

Nine tables. Every one carries `org_id` and `project_id`, and every repository method takes a tenancy scope it cannot omit — tenancy is a parameter, not a convention.

| Table | Holds |
|---|---|
| `org` | id, slug, name, created_at |
| `project` | org_id, slug, name, **settings** jsonb, created_at |
| `api_token` | project_id, name, prefix, token_hash, scopes[], created_at, last_used_at, revoked_at |
| `run` | org_id, project_id, status, verdict, tool, tool_version, bundle_key, bundle_sha256, bundle_bytes, idempotency_key, started_at, ingested_at, **engine_options** jsonb, error jsonb |
| `run_stat` | run_id, scope, name, family, count, ok_count, ko_count, error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles jsonb, **sketch bytea**, sketch_kind |
| `run_series_bucket` | **run_started_on** date, run_id, scope, name, start_offset_ms, started_count, ended_count, ok_count, ko_count, min_ms, max_ms, mean_ms, percentiles jsonb |
| `run_error` | run_id, message, count |
| `sla_rule` | project_id, scope, target_name, family, metric, comparator, threshold, enabled |
| `run_assertion` | run_id, rule_id, **rule_snapshot** jsonb, outcome, actual_value, message |

`project.settings` carries warm-up ms, indicator bounds, the percentile set, and the endpoint cardinality cap — the `EngineOptions` the shipped engine already accepts. `api_token.token_hash` is Argon2id; `prefix` is the indexed lookup key, so verification is one indexed row read plus one hash.

Unique keys: `(org_id, slug)` on project · `(project_id, idempotency_key)` on run · `(run_id, scope, name, family)` on `run_stat` · `(run_started_on, run_id, scope, name, start_offset_ms)` on `run_series_bucket` — a unique key on a partitioned table must contain the partition key, which is why `run_started_on` leads it.

Indexes: `run(project_id, started_at DESC)` for the list · `run(status, ingested_at)` for the sweeper · `run_stat(run_id)` and `run_series_bucket(run_id, scope, name)` for reads.

### 9.1 Only summary sketches are persisted

The engine returns a DDSketch on every rollup **and** every time-series bucket. Only the rollup sketches are stored.

At 100 endpoints × 300 buckets and a measured 2.1 KB sketch, persisting every bucket sketch costs ~65 MB per run — approximately 33 TB at the §7.3 target of 500,000 runs — and forces every time-series read to deserialize sketches, which will not fit the 250 ms budget of §20.1. Summary sketches alone cost ~0.2 MB per run.

What that buys is the merging that actually matters: baselines, trends, and configurable percentile columns all merge summary sketches across runs, exactly and losslessly. Time-series buckets persist as scalars plus their configured percentiles, which is everything the percentiles-over-time chart renders.

What it forfeits: recomputing an arbitrary percentile at an arbitrary zoom level on a time series. That is a feature no requirement asks for, at roughly twenty times the storage.

### 9.2 `engine_options` is stored per run

Statistics are meaningful only relative to the warm-up window and percentile set that produced them. A project changing its warm-up must not silently reinterpret its own history, and comparing two runs computed under different options is precisely the error the comparability fingerprint exists to catch (PRD FR-META-9). Freezing the options onto the run makes that detectable rather than invisible.

### 9.3 `run_series_bucket` is partitioned from the first migration

Declared `PARTITION BY RANGE (run_started_on)` with monthly partitions, several months pre-created; automatic rollover is deferred to the scheduler in a later milestone. Converting a large table to partitioned afterwards is a migration planned around an outage — the same reasoning that puts tenancy columns in now. Partitioning by run start date is what makes retention a partition drop rather than a delete storm (NFR-SC-7).

`run_started_on` is denormalized onto the table because a partition key must live in the partitioned table itself. It carries a consequence the read path must honor: **a query filtering only on `run_id` cannot prune partitions and will scan every one.** Every series read therefore resolves the run first and passes `run_started_on` alongside `run_id`. This is a correctness-of-performance requirement, not an optimization, and it is asserted by a test that fails if the predicate is dropped.

Prisma cannot express partitioning, so this migration's generated SQL is hand-edited. That is a supported Prisma workflow, stated here so it is not rediscovered as a surprise.

### 9.4 Prisma owns CRUD; metrics use raw SQL

Per PRD §16: **Prisma owns the schema, migrations, and CRUD** for `org`, `project`, `api_token`, `run`, `sla_rule`, and `run_assertion`. **`run_stat`, `run_series_bucket`, and `run_error` are written with `COPY` and read with raw parameterized SQL.**

Prisma is weak at `bytea` payloads, 30,000-row inserts, and analytical aggregation. Left unstated, this boundary is where query performance would quietly degrade.

---

## 10. API surface

```
POST /v1/runs                                  ingest (multipart)
GET  /v1/runs/{id}                             header, verdict, assertions   ← the status URL
GET  /v1/runs/{id}/stats?scope=&family=        statistics table
GET  /v1/runs/{id}/series?scope=&name=         time-series buckets
GET  /v1/runs/{id}/errors                      error table
GET  /v1/projects/{slug}/runs                  cursor-paginated list
GET  /healthz · /readyz · /v1/openapi.json
```

Authentication is a bearer `api_token`. `POST /v1/runs` requires the `ingest` scope; every `GET` requires `read`. Splitting the scopes is not RBAC and does not pretend to be — it is the smallest mechanism that stops a CI credential from also being a read credential.

Pagination is cursor-based (PRD §17). OpenAPI is served by the API at `/v1/openapi.json`. As shipped this is OpenAPI 3.0, produced by `@nestjs/swagger`'s `DocumentBuilder`/`SwaggerModule`, and is not generated from the `contracts` Zod schemas — see §12. Fixing the document itself (3.1, Zod-derived) is a separate, later task.

### 10.1 Errors

Every error response is RFC 9457 `application/problem+json`:

```json
{
  "type": "https://perfportal.dev/errors/ENDPOINT_CARDINALITY_EXCEEDED",
  "title": "Run exceeds the endpoint cardinality cap",
  "status": 400,
  "code": "ENDPOINT_CARDINALITY_EXCEEDED",
  "detail": "More than 2000 distinct request names.",
  "remediation": "Request names appear to contain dynamic values such as IDs. Parameterize them in the simulation, or raise the limit in project settings.",
  "traceId": "..."
}
```

The `IngestError` type the packages already produce maps to this one-to-one, which is why `remediation` was made a compile-time-required field. Stack traces are never returned.

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ~~NestJS 11 will not boot cleanly under strict ESM on Node 22~~ | — | **Retired.** The §3 spike ran and passed; no CJS fallback needed |
| Apps run against a stale `dist` because packages must now be built before they start (§3 F-1) | Silent use of outdated code | `tsc -b` wired into the dev and CI entry points; the app's start script depends on the build |
| The 150–250 MB memory extrapolation (§5.1) is wrong for a real 5M-event run | Worker OOM under load | Hard bundle-size cap; the existing throughput benchmark measures it before the budget is claimed met |
| Prisma + hand-edited partition SQL diverges from the Prisma schema | Migration drift, silent failures | A migration test that applies every migration to an empty database and diffs against the expected schema |
| Verdict wait ties up an API worker for up to 25 s | Reduced API concurrency | The wait is event-driven on Redis pub/sub, not polling; the window is project-configurable and can be set to 0 |
| Gatling changes its binary format in a future release | Ingest breaks for that version | Explicit version allowlist in `detect`; unknown majors rejected with remediation, never best-effort parsed |

---

## 12. Departures from the PRD

| PRD | This design | Why |
|---|---|---|
| §20.2 "never materializing the log" | Bounded, cap-enforced in-memory parse; streaming if measurement demands it | §5.1 — the arithmetic says the problem does not exist at the stated scale, and the alternative is rewriting the least-safe-to-touch component |
| §16.3 separate `scheduler` deployable | Sweeper runs in the worker via `FOR UPDATE SKIP LOCKED` | Its only responsibility in this slice is orphan recovery, which needs no leader election |
| §26 M0 before M1 | Vertical slice cutting through both | §1.1 — hard-to-reverse contracts before routine deployment work |
| §18 full identity model | Orgs, projects, and tokens only; no users, roles, or RBAC | Tenancy columns are cheap now and expensive to retrofit; roles are not |
| §6.1 step 4 "aborts with 400 BUNDLE_TOO_LARGE" | Aborts with **413** `BUNDLE_TOO_LARGE` | 413 Payload Too Large is the accurate code for this specific rejection; folding it into the general 400 "bundle rejected" bucket would lose a distinction a client can usefully act on |
| §2 worker is "NestJS standalone" | The worker is a plain Node entry point (`apps/worker/src/main.ts`) that constructs `PipelineService` by hand; nothing in it ever boots a Nest application. `@Injectable()` on `PipelineService` is decorative — kept only because `@nestjs/common`'s decorator implementation needs `reflect-metadata` loaded to not throw at import time | `@nestjs/core` and `rxjs` were declared in `apps/worker/package.json` but never imported by the app, so they were removed; `@nestjs/common` and `reflect-metadata` stay, since the decorator that is still on the class actually requires them to load without crashing |
| §6.2 steps 2 and 10 "expand to a temp directory" / "delete the temp directory" | The bundle is read into memory and never touches disk (`openTarGzBundle`) | Consistent with the §5.1 in-memory decision; §6.2's own text just hadn't been updated to match it |
| §10 "OpenAPI 3.1 ... generated from ... the `contracts` Zod schemas" | OpenAPI 3.0, produced by `@nestjs/swagger`'s `DocumentBuilder`, not derived from the Zod schemas in `@perfportal/contracts` | Known gap, not a decision — fixing the document (3.1, Zod-derived) is separate follow-up work |
| §8.2 "evaluated from the persisted summary sketch" | Evaluated from the sketch still held in memory from `runEngineAsync`, inside the same transaction that persists it | The values are identical either way, so no behaviour differs; the persisted `bytea` copy exists for *later* re-evaluation (a rule added after ingestion, or a `p99.9` ask a year on), not for evaluation at ingest time — `MetricReader.sketch` is what that later path reads |

Each is a scoping or evidence-based departure, not a disagreement with the PRD's eventual target state. §20.2 is the only one that changes a stated requirement, and it should be amended in the PRD when this design is implemented. The five rows below the identity-model row are departures of this design's own text from what shipped, not from the PRD — recorded here rather than invented a second table, since the shape (stated intent vs. shipped behavior vs. why) is the same.

---

## 13. Testing

Integration tests run against **real Postgres, Redis, and MinIO**. Infrastructure is not mocked, because every defect this slice can have lives in the seams between those systems.

**The keystone test** posts the checked-in fixture bundle (`fixtures/gatling-3.15.1.2/`) through the live HTTP endpoint and asserts the response reproduces figures the packages already prove independently:

| | |
|---|---|
| Total requests | 895 |
| OK / KO | 871 / 24 |
| Indicator bands | 848 / 0 / 23 |
| Max · mean · stddev | 2503 · 228 · 370 |
| Errors | 15 × `500`, 9 × `503` |

If ingest, persistence, or serialization corrupts anything, those numbers move. It is a full-stack test whose ground truth predates the stack.

Around it:

- **Verdict paths** — rule passes → `200`; rule fails → `422`; rule targets a name absent from the run → `not_applicable` → `200`; no rules → `not_evaluated` → `200`
- **The 202 path** — forced by a zero-length wait window, asserting the status URL later returns the identical code the fast path would have
- **Idempotency** — the same key posted twice yields one run
- **Sweeper recovery** — a job killed before completion is re-claimed and completes
- **Determinism** — a deterministic failure is not retried; a transient one is
- **Tenancy** — a token scoped to project A cannot read project B's runs
- **Sketch round-trip** — a persisted sketch reloaded from `bytea` answers percentiles identically and merges exactly
- **Migrations** — every migration applies to an empty database and produces the expected schema

**Every test is falsified before it is trusted** — shown to fail against deliberately broken code. That discipline caught four defects in the previous plan, including a bucket cap enforced at 1000 against a limit of 4.

CI runs the suite with Postgres, Redis, and MinIO as service containers, on a clean `--frozen-lockfile` install. Clean-install verification is not optional: the one CI failure in this project's history was a dependency removal validated against a stale `node_modules`.
