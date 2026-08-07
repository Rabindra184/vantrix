> ## ⚠️ SUPERSEDED IN PART — 2026-08-07
>
> This spec was written against `PerfPortal_PRD.md` v1.0, which has since been superseded by [`PerfPortal_Enterprise_PRD.md`](../../../PerfPortal_Enterprise_PRD.md) v2.0. **The technology choices below no longer apply. The design reasoning does.**
>
> **Superseded — do not implement:**
>
> | This spec | v2.0 PRD | Why |
> |---|---|---|
> | Fastify | NestJS | Stack specified by the v2.0 brief |
> | Raw `pg` throughout | Prisma for CRUD + raw SQL for the metrics read path | See v2.0 §16.8 — Prisma cannot express the analytical queries, so the boundary is mandated rather than left to preference |
> | Postgres `LISTEN/NOTIFY` job queue | BullMQ on Redis | Redis is now a required dependency for cache and WebSocket pub/sub anyway |
> | Local-directory blob store | S3-compatible object storage | Multi-pod deployment makes a shared local volume untenable |
> | Six-package pnpm workspace | NestJS modules (v2.0 §15) | Same boundary discipline, different mechanism |
> | M0 scope = ingest spine only | V1 = full Gatling parity | v2.0 §26 splits this across M0–M6 |
>
> **Still current — these were reasoned conclusions, not framework artifacts, and v2.0 asserts them without re-deriving them:**
>
> - **DDSketch over t-digest** (§2.2) — exact merges, 1% guaranteed relative error → v2.0 §24.2
> - **Lossless bucket coalescing** (§7.1) — valid only because sketch merges are exact → v2.0 §20.2
> - **Adaptive verdict** (§4.2) — bounded sync wait, then `202` + status URL, with POST and GET returning identical codes → v2.0 §17.5
> - **Comparability fingerprint with components stored** for later recomputation (§7.5) → v2.0 §24.1
> - **`not_applicable` assertion outcome** instead of a silent pass (§9.1) → v2.0 FR-SLA-6
> - **Rule snapshots** for auditability (§9.2) → v2.0 FR-SLA-7
> - **Required `remediation` field** on the error type (§10) → v2.0 §17.5, Appendix B.4
> - **Endpoint cardinality cap** (§7.2) → v2.0 FR-ING-10
> - **No aggregate fallback for binary logs** (§2.3) → v2.0 §21.8, Appendix A D-02
>
> Read this file for *why* those decisions hold. Read the v2.0 PRD for *what to build*.

---

# Perf Portal M0 — Ingest Spine

**Design specification**

| | |
|---|---|
| **Status** | **Superseded in part** — see header · originally approved for planning |
| **Date** | 2026-08-07 |
| **Scope** | Milestone M0 of [PerfPortal_PRD.md](../../../PerfPortal_PRD.md) |
| **Exit criterion (from PRD)** | One CI pipeline posts runs; nothing is lost |

---

## Contents

1. [Scope and rationale](#1-scope-and-rationale)
2. [PRD amendments](#2-prd-amendments)
3. [Architecture and module boundaries](#3-architecture-and-module-boundaries)
4. [The ingest contract](#4-the-ingest-contract)
5. [Job lifecycle and durability](#5-job-lifecycle-and-durability)
6. [Canonical event model and adapters](#6-canonical-event-model-and-adapters)
7. [Aggregation engine](#7-aggregation-engine)
8. [Data model](#8-data-model)
9. [SLA evaluation](#9-sla-evaluation)
10. [Failure handling](#10-failure-handling)
11. [Testing strategy](#11-testing-strategy)
12. [Out of scope for M0](#12-out-of-scope-for-m0)
13. [Exit criteria](#13-exit-criteria)
14. [Risks carried into M0](#14-risks-carried-into-m0)

---

## 1. Scope and rationale

The PRD spans six milestones. This spec covers **M0 alone** — the ingest spine — because the PRD's own sequencing argument holds: the ingest contract and data model are the hardest decisions to reverse, and trend history cannot be backfilled, only forward-collected. Every day the spine is not running is history that can never be recovered.

M0 delivers a system where CI posts a Gatling result bundle to an authenticated endpoint, the portal parses it into durable per-endpoint statistics and pre-bucketed time series, evaluates absolute SLA thresholds, and returns a verdict that can fail the build. There is no user interface. Milestones M1–M5 each get their own spec.

**Requirements covered:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-24, FR-32 (ingest half). Principles §5.1, §5.2, §5.3, §5.4 are all enforced from day one.

---

## 2. PRD amendments

Three decisions in this spec depart from the PRD as written. They are recorded here so the documents do not silently disagree.

### 2.1 Postgres is a required dependency (amends §6.2)

The PRD promises "a single command brings up a working instance with **no mandatory external services**," with an embedded default and Postgres as an option. This design uses **Postgres only**, bundled in `docker compose`.

The quickstart therefore becomes `docker compose up` rather than a standalone binary. In exchange, a single SQL dialect buys native range partitioning for `run_timeseries`, JSONB for run metadata and error detail, `bytea` sketches, and `FOR UPDATE SKIP LOCKED` for the job queue — all of which this design uses directly.

§6.2's *swappability* requirement still holds, but its axis changes and this should be stated precisely rather than implied: **in M0 the swappable component is the blob store** (local directory ↔ S3-compatible), behind a `BlobStore` interface. The database is Postgres-only, and the repository layer in `storage` exists to keep query construction in one place — not to support a second dialect.

### 2.2 DDSketch replaces t-digest (amends FR-8 and §7.2)

FR-8 and §7.2 specify t-digest. This design uses **DDSketch**. §5.1's actual requirement is a *mergeable* sketch, which DDSketch satisfies more strictly:

- **Merges are exact.** Two DDSketches sharing a relative-accuracy parameter γ merge with zero added error. t-digest merges are approximate and order-dependent. This system's central operation is re-aggregating at arbitrary zoom, so t-digest error would compound at precisely the operation performed most often.
- **Error is bounded in relative terms** — 1% at every quantile, guaranteed — which is the meaningful guarantee for latency and one that can be stated in documentation as a number.
- **`@datadog/sketches-js`** is a maintained TypeScript implementation with protobuf serialisation. JavaScript t-digest libraries are thinner and would require hand-rolled serialisation on the path every row depends on.

The decision is reversible: `sketch_kind` is stored per row and the aggregation interface is sketch-agnostic.

### 2.3 The aggregate fallback is deferred (defers part of §9)

§9 proposes falling back to the tool's own aggregate output when event-level parsing is impossible (for example, a binary `simulation.log`). M0 **detects and fails loudly instead**.

Aggregates yield summary numbers but no per-bucket sketches and no time series. A run ingested that way would occupy the same schema as every other run while carrying materially weaker guarantees — its percentiles could not be merged, re-aggregated, or zoomed, so §5.1's invariant would hold for some rows and not others. That is exactly the quiet two-tier correctness the PRD's principles exist to prevent.

If the fallback later earns its place, it arrives with an explicit `metrics_source` column and visible UI treatment — as a designed second class of run, not an invisible one.

---

## 3. Architecture and module boundaries

### 3.1 Runtime

- **Node 22 LTS**, TypeScript strict mode, ESM
- **Fastify** for HTTP — streaming request bodies and JSON Schema validation both matter here
- **`pg`** with raw SQL and numbered plain-SQL migrations. No ORM: single dialect, few queries, all performance-sensitive
- **Vitest** for tests, **testcontainers** for Postgres in integration tests
- **pnpm** workspace

### 3.2 Deployment topology

One built image; `argv` selects the role. `docker compose` runs `postgres`, `api`, and one `worker`.

```
┌──────────────────┐        ┌────────────────────────┐
│ api              │        │ worker  × N            │
│ HTTP · auth      │        │ claim · stream-parse   │
│ store bundle     │        │ aggregate · SLA        │
│ enqueue · wait   │        │ persist                │
└────────┬─────────┘        └───────────┬────────────┘
         │                              │
         └───────────┬──────────────────┘
                     ▼
        ┌────────────────────────┐   ┌──────────────┐
        │ Postgres               │   │ Blob store   │
        │ data + ingest_jobs     │   │ raw bundles  │
        └────────────────────────┘   └──────────────┘
```

A four-minute parse cannot affect API latency: separate processes, separate event loops, separate memory. This is what makes §6.1's "ingestion must not block the reporting UI" structurally true in a single-threaded runtime.

**Deployment caveat.** With `api` and `worker` in separate containers, the default local-directory blob store requires a **shared volume**. This is correct under compose and on a single host, and breaks as soon as workers scale onto a second machine — at which point S3-compatible storage stops being optional. This boundary must be documented in the operator guide.

### 3.3 Packages

```
packages/
  core/         canonical event model, run metadata, error taxonomy. No I/O.
  aggregation/  bucketing, sketches, warm-up, stats rollups. Pure functions.
  adapters/     the adapter contract + the Gatling adapter. Pure.
  storage/      repositories, migrations, blob store. The swappable module (§6.2).
  api/          HTTP, auth, ingest route, status and verdict routes.
  worker/       job claim loop, pipeline orchestration.
```

### 3.4 Dependency rules

```
core        ← aggregation, adapters, storage, api, worker
storage     ← api, worker
aggregation ← worker only
adapters    ← worker only
```

Two consequences are the point of the layout and are **enforced by an import-boundary lint rule**, not by convention:

1. **`adapters` and `aggregation` depend on `core` alone** — no database, no HTTP, no configuration. An adapter is a pure function from a byte stream to canonical events. This makes §6.4's promise ("adding a tool is implementing two methods, and nothing else changes") true by construction, and means an adapter test needs a fixture directory and nothing else.
2. **`api` cannot import `adapters` or `aggregation`.** Parsing inside a request handler becomes structurally impossible rather than merely discouraged.

---

## 4. The ingest contract

### 4.1 Request

`POST /api/v1/runs` — `multipart/form-data`, bearer token in `Authorization`.

Multipart carries metadata and bundle in one streamed request and keeps the CI snippet free of `jq`:

```bash
tar czf - target/gatling/checkout-*/ | curl -sS --fail-with-body \
  -H "Authorization: Bearer $PERF_TOKEN" \
  -F project=checkout-api -F build="$BUILD_NUMBER" -F branch="$BRANCH" \
  -F commit="$GIT_SHA" -F environment=staging -F bundle=@- \
  https://perf.example.com/api/v1/runs
```

| Field | Required | Notes |
|---|---|---|
| `project` | yes | Slug. Must match the token's project or the request is rejected `403`. |
| `build` | yes | CI build identifier. |
| `bundle` | yes | The gzipped tar of the tool's whole output directory. |
| `tool` | no | `gatling`. Auto-detected when omitted (FR-2). |
| `branch`, `commit` | no | Stored for FR-27 commit attribution in M3. |
| `environment` | no | Defaults to `default`. Part of the comparability fingerprint. |
| `profile` | no | JSON string describing the injection profile. Part of the fingerprint. The single nesting escape hatch — no other field accepts JSON. |
| `started_at` | no | ISO-8601. Falls back to the log's own start time, then server time. |

`Idempotency-Key` (header, optional): unique per project. A repeat returns the existing run's current state rather than creating a second run. Without the header duplicates are permitted — re-running the same build is legitimate and the system should not guess.

**The bundle is the tool's entire output directory**, not just the raw log. The adapter locates the event log inside and ignores the rest, but the rest is retained (FR-5), which preserves §9's aggregate-fallback option, the material for FR-31 report regeneration, and immunity to the log path moving between tool versions.

### 4.2 Verdict semantics

> **The governing rule:** `POST /api/v1/runs` and `GET /api/v1/runs/{id}/verdict` **return the same status code for the same run state.** The CI poll loop is therefore identical to the initial post.

| Code | Run state | Meaning to CI |
|---|---|---|
| `200` | complete · pass | Ingested; all SLA rules held. |
| `422` | complete · breach | **Ingested successfully — the gate failed.** Body lists every breached rule with actual vs. threshold. |
| `202` | pending / parsing | Still working. `Location` and `Retry-After: 5` returned. |
| `400` | failed | Bundle could not be parsed. Body names likely cause and fix (FR-4). |
| `401` / `403` | — | Invalid or revoked token / token not scoped to this project. |
| `413` / `415` | — | Bundle over size cap / not a recognised archive. |

**On 422.** This is a deliberate abuse of the status code: the run ingested perfectly and the gate failed, whereas 422 semantically means the request could not be processed. It is used because FR-3 requires a non-2xx for CI to gate on an exit code without extra scripting, and 422 is the least-wrong code available. Two obligations follow: the response body must be unambiguous, and the documentation must state plainly that **422 means the performance gate failed, not that the upload was bad.**

### 4.3 Bounded wait

The API waits up to `INGEST_SYNC_WAIT_MS` (default **25 000**) for a terminal run state, then returns `202`. The default sits below the common 30-second and 60-second proxy timeouts.

Waiting uses Postgres `LISTEN`/`NOTIFY` on a per-run channel so latency is milliseconds rather than a poll interval, with a 2-second poll as a fallback for missed notifications. `LISTEN`/`NOTIFY` requires a dedicated non-pooled connection in each role.

### 4.4 Administrative endpoints

Guarded by a single `PERF_ADMIN_TOKEN` from the environment:

- `POST /api/v1/projects` — create a project
- `POST /api/v1/projects/{slug}/tokens` — mint an ingest token (returned once, stored hashed)
- `DELETE /api/v1/tokens/{id}` — revoke
- `PUT /api/v1/projects/{slug}/sla-rules` — replace the project's rule set

This is deliberately thin scaffolding, not a design. §6.3's "no unauthenticated endpoints" holds. M5 replaces the mechanism with SSO and RBAC without touching the ingest path.

---

## 5. Job lifecycle and durability

### 5.1 Ordering — how "nothing is lost" is achieved

1. Authenticate the token; resolve and verify the project.
2. Validate metadata fields.
3. Stream the request body directly to the blob store while computing SHA-256, enforcing the size cap (`INGEST_MAX_BUNDLE_BYTES`, default 1 GiB → `413`). **The bundle is never buffered in memory.**
4. Insert the `runs` row (`status = pending`) and the `ingest_jobs` row (`state = queued`) **in one transaction**.
5. `NOTIFY` to wake a worker.
6. Wait for a terminal state, up to the bounded window.
7. Respond.

The bundle is durable before any row references it. The worst failure mode is an orphaned blob, which a sweeper reclaims — never a run whose data is gone. If the API process dies mid-wait, the job is already queued and a worker processes it regardless; the client loses a connection, not a run.

### 5.2 State machines

```
run:  pending → parsing → complete·pass | complete·breach | failed

job:  queued → claimed (+lease) → done | failed (after max attempts)
```

Run state and job state live in different tables and must not drift: **the worker updates both in the same transaction.**

Job bookkeeping is kept off `runs` deliberately. `runs` is a domain table that trend queries will read for years; `claimed_by`, `attempts`, and `lease_expires_at` on it would be a leak that is painful to unpick later.

### 5.3 Claiming and leases

```sql
UPDATE ingest_jobs SET state = 'claimed', claimed_by = $1,
                       claimed_at = now(), lease_expires_at = now() + interval '2 minutes',
                       attempts = attempts + 1
WHERE id = (SELECT id FROM ingest_jobs WHERE state = 'queued'
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

A claimed job carries a **lease**, heartbeated every 30 seconds by the owning worker to extend `lease_expires_at`. A reaper requeues jobs whose lease has genuinely expired.

The heartbeat is essential, not decorative: a legitimate parse may run for minutes, and without lease extension the reaper would steal live jobs and duplicate work. After `INGEST_MAX_ATTEMPTS` (default 3) a job moves to `failed` and its run to `failed` with the last error.

---

## 6. Canonical event model and adapters

### 6.1 Canonical events (FR-6)

```ts
type CanonicalEvent =
  | { type: 'meta';    simulation: string; toolVersion: string; startedAtMs: number }
  | { type: 'request'; name: string; groups: string[]; userId: string;
                       startMs: number; endMs: number; ok: boolean; message?: string }
  | { type: 'user';    scenario: string; userId: string; kind: 'start' | 'end'; tsMs: number };
```

Streamed as an `AsyncIterable`; nothing is ever materialised.

Two deliberate choices:

- **Requests carry `startMs` and `endMs`, not a duration.** FR-10's requests-in-flight concurrency proxy needs both edges, and a duration alone discards that irrecoverably.
- **`meta` is the first event in the stream** rather than a separate method, so an adapter reads the bundle once, in one pass, in one direction.

### 6.2 Adapter interface (§6.4)

```ts
interface DetectResult {
  matched: boolean;
  version?: string;   // tool version, when the bundle reveals it
  reason: string;     // why it matched, or why it declined — surfaced in errors
}

interface Adapter {
  readonly tool: ToolId;
  detect(bundle: BundleView): Promise<DetectResult>;
  parse(bundle: BundleView): AsyncIterable<CanonicalEvent>;
}
```

`detect` returns a boolean rather than a confidence score. A numeric score would require a tie-breaking threshold that nothing in M0 can calibrate; a single-tool system has no data to tune it against. Ambiguity is defined structurally instead — see §6.3.

`BundleView` is a read-only accessor over the archive: list entries, open a read stream for one entry, read a small file whole. Adapters never touch the filesystem, the tar format, or a path — which is why the local-directory-versus-S3 blob decision is invisible to them.

### 6.3 Tool auto-detection (FR-2)

Every registered adapter's `detect` runs against the bundle. `detect` may only peek at small files; it must never scan the event log.

- Exactly one adapter returns `matched: true` → that adapter is used.
- More than one → `400 TOOL_AMBIGUOUS`, listing the matching tools and their reasons, asking for an explicit `tool` field.
- None → `400 TOOL_UNKNOWN`, quoting every adapter's `reason` for declining. This is what makes the error actionable (FR-4).

When the request supplies `tool` explicitly, detection is skipped and only that adapter runs; if its `detect` declines, the run fails with `TOOL_UNKNOWN` carrying that adapter's reason.

### 6.4 The Gatling adapter

Parsing follows §9's rule: **anchor on stable tokens, never on column positions.**

1. Read the `RUN` record first to obtain the Gatling version.
2. The version selects the record schema for the remainder of the file.
3. Dispatch records by leading token; skip unknown record types rather than failing.
4. A malformed line reports its line number, the record type, and expected-versus-found.

This is the difference between surviving a Gatling upgrade and breaking silently on one.

**Binary or unrecognised logs** produce `LOG_BINARY_FORMAT` naming the detected format, the Gatling version, and the concrete fix. See §2.3 for why there is no fallback in M0.

---

## 7. Aggregation engine

### 7.1 Bucketing by in-place coalescing

A run's duration is unknown until the log ends, so the bucket width cannot be chosen up front. Aggregation starts at **1-second buckets** and coalesces in place whenever the bucket count exceeds the cap, merging adjacent pairs and doubling the width:

```
1s buckets   ████████████████████████   1201 buckets → over cap
                    ↓ merge adjacent pairs
2s buckets   ▉▉▉▉▉▉▉▉▉▉▉▉               601 buckets
```

Single pass, bounded memory, and — because DDSketch merges exactly — **lossless**. This is the concrete payoff of storing sketches rather than numbers, and it is a further reason coalescing with t-digest would be a worse idea (§2.2).

**The run-wide and per-endpoint series have different bucket caps (§7.2) and therefore coalesce independently to different widths.** Both are stored on the run: `bucket_width_ms` for the run-wide series and `endpoint_bucket_width_ms` for per-endpoint series. A single column would misreport one of them.

### 7.2 Memory budget

| Series | Bucket cap | Notes |
|---|---|---|
| Run-wide | 1200 (`TS_MAX_BUCKETS_RUN`) | full resolution, ≈ 2 MB |
| Per-endpoint | 300 (`TS_MAX_BUCKETS_ENDPOINT`) | the dominant term |
| Per-endpoint summary sketch | 1 each | negligible |

Worst case is `endpoints × 300 × ~1.5 KB` — roughly 45 MB at 100 endpoints.

**Endpoint cardinality is capped** at `projects.max_endpoints` (default 2000). Exceeding it fails the run with `ENDPOINT_CARDINALITY_EXCEEDED`, reporting the count, the cap, and sample names, and naming dynamic request names as the likely cause — which is what it always is. Unbounded cardinality is the one failure mode that can exhaust a worker's memory, so it gets a hard limit rather than a warning.

### 7.3 Per-bucket counters

Each bucket records `started_count` and `ended_count` **separately**. FR-12 requires requests/sec and responses/sec plotted apart because their divergence reveals back-pressure, and that is only recoverable if both edges are counted at ingest time.

Buckets also carry `ok_count`, `ko_count`, and `active_users` with its `active_users_source` (`sessions` when the tool emits user records, `in_flight` for the proxy) per FR-10.

### 7.4 Warm-up (§5.3, FR-9)

M0 uses a per-project configured `warmup_ms`, default `0`. **Summary statistics exclude the warm-up window; the time series retains it** — exactly §5.3.

Automatic ramp detection is a heuristic and belongs in M1. A configured window is deterministic and testable, and it honours the principle today rather than letting SLA gating quietly run on ramp-polluted numbers for a milestone.

### 7.5 Comparability fingerprint (§5.2)

Computed and stored on every run in M0 although nothing reads it until M3. It is a stable hash over `tool`, `environment`, `simulation`, and the normalised `profile` — **never** branch, commit, or build.

The **components are stored alongside the hash** in `fingerprint_components` (JSONB) so that a future change to the fingerprint algorithm can be recomputed across all history rather than orphaning it.

### 7.6 Tool isolation (§5.4)

`tool` is recorded on every run and is part of the fingerprint, so runs from different tools can never share a comparison baseline. M0 has no charts to enforce the no-overlay rule on; storing the tool and folding it into the fingerprint is the M0 half of §5.4.

---

## 8. Data model

Nine tables. `run_stats` carries the §5.1 correctness guarantee; `run_timeseries` is the only table that grows with run length.

### 8.1 Identity and access

```
projects        id · slug (uniq) · name · warmup_ms=0 · max_endpoints=2000 · settings jsonb · created_at
ingest_tokens   id · project_id → projects · token_hash (uniq, sha256) · prefix
                · name · created_at · last_used_at · revoked_at
ingest_jobs     id · run_id (uniq) → runs · state · attempts · claimed_by · claimed_at
                · lease_expires_at · last_error jsonb · created_at · updated_at
```

**Tokens are stored as SHA-256, not argon2.** A slow KDF exists to defend low-entropy human passwords; these are 256-bit random values with nothing to brute-force, and ingest authenticates on every CI post, where a deliberately slow hash buys nothing and costs latency on the hot path. `prefix` exists only so a token list can display `pp_a1b2…`.

Index: `ingest_jobs (state, created_at) WHERE state = 'queued'`.

### 8.2 Runs and metrics

```
runs            id · project_id → projects
                tool · tool_version · simulation
                build · branch · commit · environment · profile jsonb
                fingerprint · fingerprint_components jsonb
                started_at · ended_at · duration_ms
                bucket_width_ms · endpoint_bucket_width_ms · warmup_ms
                status · verdict · error_code · error_detail jsonb
                bundle_key · bundle_sha256 · bundle_bytes
                request_count · idempotency_key · created_at · completed_at

run_stats       PK (run_id, scope, name)          scope ∈ {run, request}
                count · ok_count · ko_count · error_rate
                min_ms · max_ms · mean_ms · stddev_ms
                p50_ms · p75_ms · p95_ms · p99_ms
                throughput_rps · sketch bytea · sketch_kind

run_timeseries  PK (run_id, scope, name, bucket_start_ms, month)
                started_count · ended_count · ok_count · ko_count
                active_users · active_users_source · sketch bytea
                PARTITION BY RANGE (month)
                month = date_trunc('month', run.created_at), written by the worker
                active_users populated only for scope='run'

run_errors      PK (run_id, scope, name, msg_hash)
                message · count

sla_rules       id · project_id → projects · scope · name_pattern
                metric · comparator · threshold · enabled · created_at

assertions      id · run_id → runs · rule_id → sla_rules
                rule_snapshot jsonb · status · actual · threshold · scope · name
```

**The `(scope, name)` convention** is shared by `run_stats`, `run_timeseries`, `run_errors`, and `assertions`: `scope = 'run'` always pairs with `name = ''` (the empty string, never `NULL`, so it participates in primary keys and equality joins); `scope = 'request'` pairs with the request name. One convention across four tables, stated once.

**`throughput_rps`** is `count / (duration_ms - warmup_ms) × 1000`, computed over the same warm-up-excluded window as every other column in `run_stats` (§7.4).

Constraints and indexes:

- `runs`: unique `(project_id, idempotency_key)` where `idempotency_key IS NOT NULL`
- `runs (project_id, fingerprint, started_at DESC)` — the trailing-comparable-runs lookup FR-25 and FR-26 will need
- `runs (project_id, created_at DESC)` — latest run per project, backing the M2 fleet view

Both indexes serve unshipped milestones and are cheap now.

### 8.3 The §5.1 guardrail, written into the schema

`run_stats` stores percentile columns **and** the sketch. The percentiles are derived from that row's own full sketch — exact at that scope and safe to read directly for display and for run-granularity trends.

> **Any re-aggregation across buckets, endpoints, or runs merges `sketch` and never reads the percentile columns.** This is recorded as a schema comment on the columns, not left as folklore.

### 8.4 Partitioning — the one thing built ahead of need

`run_timeseries` is declared partitioned by month on `month` from creation. Nothing in M0 requires this. It is built now because converting a large table to partitioned later means a full rewrite with downtime, and the PRD is explicit that this table grows without bound and is aged out on a schedule (FR-34, M5). Retention then becomes `DROP PARTITION` rather than a delete storm.

**The cost, stated plainly:** Postgres requires the partition key inside the primary key, so `month` is carried in the PK. A small helper pre-creates the following month's partition.

This is the only speculative element in the schema; everything else earns its place in M0.

### 8.5 Error rollup bounds

`run_errors` retains the **top 200 distinct messages** per `(run_id, scope, name)` by count; the remainder is rolled into a single `other` row preserving the total count. Failure messages can be unbounded and high-cardinality, so this is a hard limit rather than a heuristic.

### 8.6 Migrations

Numbered plain-SQL files applied by a small runner at startup, holding a Postgres advisory lock so concurrent API replicas cannot race. No migration framework.

---

## 9. SLA evaluation

Absolute rules only (FR-24). Relative-to-history (FR-25) and noise-aware detection (FR-26) require accumulated history to mean anything and belong in M3.

Evaluation runs in the worker after aggregation and before the run is marked complete.

| Field | Values |
|---|---|
| `scope` | `run` or `request` |
| `name_pattern` | exact request name, or `*` for all requests |
| `metric` | `p50` `p75` `p95` `p99` `mean` `max` `min` `error_rate` `throughput_rps` `count` |
| `comparator` | `lte` `gte` |
| `threshold` | number |

**Every enabled rule is evaluated — no short-circuit** — so a breaching response lists all failures rather than only the first.

Metrics are read from `run_stats`, which excludes the warm-up window (§7.4). The run's verdict is `breach` if any assertion is `breached`, otherwise `pass`.

### 9.1 Rules that match nothing

An assertion has three outcomes: `passed`, `breached`, `not_applicable`.

A rule whose `name_pattern` matches no endpoint in the run records `not_applicable`, and the response surfaces the count. Silent passing is the dangerous option — a typo'd endpoint name would mean the gate never fires and nobody ever learns. Failing the build is too aggressive, since endpoints legitimately appear and disappear. Reporting makes a misconfigured gate visible without breaking anyone's build.

### 9.2 Auditability

`assertions.rule_snapshot` stores the evaluated rule inline. Rules get edited; without a snapshot a run's recorded pass/fail becomes unexplainable the moment someone changes a threshold — the record would read "breached" with no way to recover what it was measured against. A few hundred bytes per run keeps history meaningful.

---

## 10. Failure handling

FR-4 gets a **structural guarantee rather than a convention**: the error type requires a `remediation` field alongside `code` and `message`. An error that does not name a fix will not compile.

```ts
interface IngestError {
  code: IngestErrorCode;
  message: string;       // what happened
  remediation: string;   // what to do about it — required
  detail?: Record<string, unknown>;
}
```

| Code | Detail carried |
|---|---|
| `BUNDLE_TOO_LARGE` | size, cap |
| `BUNDLE_NOT_ARCHIVE` | detected magic bytes |
| `BUNDLE_EMPTY` | — |
| `TOOL_AMBIGUOUS` | candidate tools with confidences |
| `TOOL_UNKNOWN` | each adapter's decline reason |
| `LOG_NOT_FOUND` | archive entries that were present |
| `LOG_BINARY_FORMAT` | detected format, tool version |
| `LOG_MALFORMED` | line number, record type, expected vs. found |
| `ENDPOINT_CARDINALITY_EXCEEDED` | count, cap, sample names |
| `NO_REQUESTS` | parsed record counts by type |
| `PROJECT_MISMATCH` | token's project, requested project |
| `TOKEN_REVOKED` | revoked_at |

Errors detected before the run row exists return synchronously. Errors detected during parsing set `runs.status = failed` with `error_code` and `error_detail`, surfaced as `400` from both the POST (if within the wait window) and the verdict endpoint.

---

## 11. Testing strategy

Implementation is test-driven. Two layers are load-bearing enough to specify here.

### 11.1 The §5.1 property test

Generate synthetic latency distributions, compute the exact percentile from the fully sorted array, and assert the merged-sketch answer falls within 1%.

Paired with a **lossless-coalescing invariant**: a sketch built at 1-second buckets and then coalesced to 4 seconds must equal one built directly at 4 seconds.

That invariant is the executable form of the entire percentile argument. If it ever breaks, the product is lying to its users.

### 11.2 Throughput benchmark as a test

This is the explicit mitigation for choosing TypeScript against §6.1's ingestion-throughput requirement.

A generated multi-million-event log, with assertions on wall-clock duration and peak RSS. It begins as a reported metric in CI and becomes a gate once a real baseline exists, so §6.1 is checked continuously rather than discovered at M4.

### 11.3 Remaining layers

| Layer | Content |
|---|---|
| Adapter | Golden-file tests over real Gatling fixtures from several versions |
| API contract | The §4.2 status-code matrix, including POST/GET symmetry |
| Worker concurrency | Two workers never claim one job; a heartbeated long parse is never stolen; a killed worker's job is requeued; max attempts lands in `failed` |
| End-to-end | Real Postgres via testcontainers: bundle in, verdict out, rows asserted |

### 11.4 Synthetic data generator

The PRD lists this under M4 (§6.4). Both the property test and the benchmark require it, so a minimal version lands in M0. It is a prerequisite, not scope creep.

---

## 12. Out of scope for M0

Any user interface or charts · read API beyond run status and verdict (FR-30 belongs with M2) · relative-to-history and noise-aware detection (FR-25, FR-26) · commit attribution (FR-27) · alerting (FR-29) · k6 and JMeter adapters (M4) · SSO, teams, users, RBAC (FR-32 human half, FR-33 — M5) · retention jobs (FR-34) · run annotations (FR-35) · report regeneration (FR-31) · distributed-run merging · the aggregate fallback (§2.3) · a CLI binary.

**On the CLI:** FR-1 asks for a three-line snippet, and `curl` plus a short poll loop delivers exactly that. A distributed binary carries packaging, versioning, and release scope for something a documented snippet already does.

---

## 13. Exit criteria

M0 is complete when all of the following hold:

1. A CI pipeline posts a Gatling bundle and receives a verdict; the run appears with complete per-endpoint statistics, time series, and error rollups.
2. A configured absolute threshold breach returns `422` and fails that build.
3. A worker killed mid-parse yields a complete run after restart — **nothing is lost**.
4. A bundle exceeding the bounded wait returns `202`, and the documented poll loop resolves it to the correct terminal code.
5. An unparseable bundle returns `400` with a code, a message, and a remediation.
6. The throughput benchmark meets its wall-clock and peak-RSS budget on a generated multi-million-event log.
7. The sketch property test and the lossless-coalescing invariant pass.

---

## 14. Risks carried into M0

| Risk | Mitigation in this design |
|---|---|
| **TypeScript parsing throughput** against §6.1 | Streaming line-by-line parse with backpressure, never buffering a log; parsing isolated in a separate worker process; §11.2 benchmark as a continuously-run test rather than a late discovery |
| **Gatling log format changes between versions** | Version read from the `RUN` record drives the record schema; parsing anchored on leading tokens, not columns; raw bundle retained for reprocessing (FR-5); `LOG_MALFORMED` fails loudly with line and record type |
| **Binary log formats** | Detected and reported with `LOG_BINARY_FORMAT`; no silent degradation (§2.3) |
| **Endpoint cardinality explosion exhausting a worker** | Hard cap per project with an actionable error naming dynamic request names (§7.2) |
| **Reaper stealing a live long-running parse** | Lease heartbeated every 30 s by the owning worker; only genuinely expired leases are requeued (§5.3) |
| **Run state and job state drifting apart** | Both updated in one transaction (§5.2) |
| **422 misread as an upload failure** | Response body distinguishes it explicitly; documentation states it plainly (§4.2) |

---

*This specification covers M0 only. M1 (single-run visual parity) is the next spec.*
