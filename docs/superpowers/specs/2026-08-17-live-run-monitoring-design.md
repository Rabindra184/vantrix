# Live run monitoring — design

**Status:** proposed
**Date:** 2026-08-17
**Delivers:** PRD **M7 (Live)** — FR-LIVE-1 through FR-LIVE-8, AC-LIVE-1
through AC-LIVE-4. First stage of closing the gap against Gatling Enterprise.

**Goal:** a run is watchable while it injects. Today a run becomes visible only
after it has finished and its bundle has been uploaded, which means the one
question a soak test exists to answer — *is it degrading right now, and should
I stop it?* — cannot be asked here at all (§10 use case, US-23, persona Sam).

**Non-goal, unchanged:** this does not run, schedule, or orchestrate tests
(PRD §5.3). Something else starts the load; this watches it.

---

## 0. Why we tail `simulation.log`, rather than instrument the simulation

Gatling Enterprise instruments its own load generators: they aggregate locally
and push stats to its API, which is how it merges across distributed injectors.
That machinery is proprietary. The route a third party would use is a custom
`DataWriter`, and **Gatling has closed it.**

1. **The current defaults.** `gatling-core/src/main/resources/gatling-defaults.conf`
   on `main` reads `writers = [console, file]`, documented as "currently
   supported : console, file". There is no `graphite` block and no `influxdb`
   block — the two writers that once gave Gatling OSS realtime monitoring have
   been removed. Live monitoring is deliberately an Enterprise feature.
2. **The SPI is internal.** `DataWriter` has never been a documented public
   extension point, and the community record shows it churning across versions
   (`DataWriterClient` replaced, custom-writer loading changed between majors).
   Third-party writers exist and ride that instability.
3. **What that leaves.** `file` is the only stable, documented, supported
   output Gatling OSS still has. Tailing `simulation.log` is not a workaround
   for a better path; it is the only supported surface remaining.

**And it is the whole surface.** `plugin-gatling/src/plugin.ts:29` selects
exactly one file out of an ingested bundle — `simulation.log`. Nothing else in
the tar.gz contributes to a single number this platform reports. So the bytes a
live stream carries are byte-identical to what post-hoc ingest already consumes,
and live and post-hoc collapse into one pipeline with a second entry point
rather than two implementations that can disagree.

### Why raw bytes, and not events decoded at the edge

The agent could decode to canonical events in Go and post JSON. Rejected: it
means a second implementation of the Gatling binary decoder, guarded by its own
parity suite, and any drift between the two shows up as **the live chart
contradicting the final report** — the worst available failure for a monitoring
product's credibility. `parity.e2e.test.ts` guards the TypeScript decoder and
nothing else.

The cost of shipping raw bytes is wire traffic and server CPU.
`engine-async.ts` records the whole log at the 5M-event target as ~150–250 MB;
spread across a run's duration that is a trickle, and the server decodes those
bytes today regardless.

---

## 1. The lifecycle contract

### 1.1 Two new states

`RunStatusSchema` (`packages/contracts/src/run.ts:3`) is today
`['pending','parsing','complete','failed']`.

| State | Meaning | `GET /v1/runs/:id` |
|---|---|---|
| `running` | Opened, accepting batches | `202` + `Retry-After`, exactly as `pending`/`parsing` |
| `incomplete` | Closed by inactivity or abort; all received data retained and marked | `200`, `verdict: not_evaluated` |

`running` deliberately reuses the existing `202` branch so a CI poll loop needs
no change — the verdict contract in `README.md` gains two rows, not a new
shape. Note that `PendingRunSchema` (`run.ts:148`) independently enumerates
`['pending','parsing']` and must gain `running`; the two enums are separate and
a change to one does not typecheck the other.

### 1.2 An `incomplete` run never carries a pass verdict

FR-LIVE-5 requires that an interrupted run is "never silently presented as
complete". A partial run can satisfy every SLA rule purely by having stopped
before the load that would have broken it, so evaluating rules against it
manufactures a pass. `incomplete` therefore finalizes as `not_evaluated` —
which is already a non-failure state, not an error (README, "The verdict
contract").

This keeps the 200/422 CI contract honest: an aborted run cannot green a
pipeline.

### 1.3 Three endpoints

```text
POST   /v1/runs/live           open  → { runId, streamUrl }     → status: running
POST   /v1/runs/:id/stream     feed  → raw simulation.log bytes at a declared offset
POST   /v1/runs/:id/close      close → finalize                 → status: complete | failed
```

`close` is explicit; the sweeper closes runs whose producer vanished (§5).

**`open` takes the same metadata `POST /v1/runs` takes**, and freezes it on the
same terms: `environment`, `branch`, `commitSha`, `engineOptions`, and an
`idempotencyKey`. Those columns are documented as "frozen at accept time …
they describe the run that was submitted, and a later edit must not rewrite
what was true when it ran" (`schema.prisma`, `Run`), and a live run is
submitted at `open`. `simulation`, `description`, `durationMs` and
`toolStartedAt` stay worker-written, arriving with the `meta` record in the
first bytes.

`idempotencyKey` matters more here than for a bundle upload: an agent that
retries `open` after a network timeout must rejoin the run it already created
rather than start a second one, and `(projectId, idempotencyKey)` is already
unique.

### 1.4 A new `stream` token scope

`ApiToken` carries `ingest`, `read`, `telemetry` today. Live ingest gets a
fourth scope rather than reusing `ingest`.

The reason is the one already recorded for `telemetry` in `README.md`: a token
lives on "a shared, often-ephemeral load generator" and should "do exactly one
thing". That host is the least-trusted machine in the deployment. Granting it
`ingest` would grant full bundle upload for the whole project from a box that
is frequently disposable and frequently shared.

`stream` grants open, feed, and close, and nothing else.

**Deferred, deliberately:** the tighter arrangement is CI opening the run with
its own `ingest` token and handing the agent a short-lived, single-run token —
closer to how Gatling separates control plane from generator. It needs a
token-lifetime concept the model does not have, and the scope above is a strict
improvement on the status quo without it.

---

## 2. The resumable engine

### 2.1 The extraction

`runEngine` (`packages/statistics/src/engine.ts:94`) is already a single-pass
fold: it constructs accumulators, folds events into them, and finishes them.
Every accumulator is already incremental with a non-destructive read —
`BucketSeries` coalesces inside `add()` (`buckets.ts:98`) and `buckets()` only
reads; `RollupBuilder.finish()` is pure; `Sketch` has `merge()` and
`serialize()`.

So FR-LIVE-2 ("incremental aggregation updates sketches and buckets without
recomputing from scratch") is an extraction, not new mathematics:

```ts
export class LiveEngine {
  constructor(opts: EngineOptions) { … }   // local state, engine.ts:102–154
  add(event: CanonicalEvent): void { … }   // loop body,   engine.ts:182–311
  snapshot(): EngineResult { … }           // tail,        engine.ts:313–349
}

export function runEngine(events, opts = {}) {
  const engine = new LiveEngine(opts);
  for (const e of events) engine.add(e);
  return engine.snapshot();
}
```

`runEngine`'s signature and behaviour are unchanged, so `parity.e2e.test.ts`
guards the refactor on the exact figures it already pins.

### 2.2 The property that licenses trusting the live fold

`runEngine` is a **deterministic, order-preserving fold.** Given the same event
sequence it produces the same output, including the points at which
`BucketSeries` coalesces — coalescing is a function of how many buckets exist
when `add()` is called, and that is fixed by position in the sequence.
`windowMs` derives from `min(firstMs)` and `max(lastMs)`, which are
order-independent.

A live stream feeds the same bytes in the same file order. Therefore the live
fold and a batch fold over the finished log are identical, and **`close` can
finalize from the live accumulators without re-parsing.**

This is asserted, not assumed — see §6.1. If that test ever fails, this
section is wrong and `close` must re-fold.

### 2.3 One hazard the extraction must fix

`RollupBuilder.finish()` (`rollup.ts:53`) returns live references to `#sketch`,
`#histOk` and `#histKo`. In batch use the accumulator is dead by then and this
is free. In live use it is a bug: a snapshot handed to an async publisher would
watch its own sketches mutate as the next batch folds in, and would serialize
a state that never existed at any instant.

`snapshot({ clone: true })` therefore hands back **copies** of the sketch and
histograms rather than the live accumulators.

**Cloned, not serialized.** Serializing through `Sketch.serialize()` would
change `StatRollup.sketch` from a `Sketch` to a `Uint8Array` and break
`MetricWriter.persist()`, which consumes `EngineResult` directly. Cloning into
a fresh instance preserves the type, so every existing consumer is untouched,
and it is lossless for the same reason coalescing is: DDSketch and Histogram
merges are exact (`buckets.ts:117`).

`clone` defaults to **false**, so `runEngine`'s batch path allocates nothing
new — it finishes once and never touches the builder again. Only the live
caller pays.

---

## 3. Ownership and transport

**Byte order is the entire problem.** `BinaryReader` resolves strings through a
back-referencing cache (`reader.ts:43`: "the SIGN is the discriminator"), so a
gap or a reordering corrupts every record after it. Records are variable-length,
so a chunk boundary routinely lands mid-record. Everything below follows.

### 3.1 The wire contract declares an offset

Each `POST /v1/runs/:id/stream` states the byte offset its payload begins at.
The server holds the expected offset:

| Case | Response |
|---|---|
| Offset matches | `202`, bytes appended |
| Offset is behind (already consumed) | `202`, no-op — makes agent retries idempotent |
| Offset is ahead (a gap) | `409` naming the expected offset, so the agent seeks and resumes |

A trailing partial record is held in the decoder's buffer until the bytes
completing it arrive. The decoder therefore needs a resumable form that reports
how far it consumed — the reader already tracks position; this exposes it.

### 3.2 One Redis Stream per run, one owning worker

Bytes land on `live:{runId}:bytes`, consumed by the single worker holding that
run's Postgres advisory lock — the same `pg_try_advisory_lock` mechanism at
`pipeline.service.ts:56`, taken for the same reason (one processor per run) and
already proven.

A Redis Stream, not a BullMQ queue: a queue with concurrency above one gives no
ordering guarantee, and §3's opening sentence says ordering is the problem.

### 3.3 Snapshots fan out over pub/sub

The owning worker snapshots on a timer (FR-LIVE-3: default 5 s, floor 1 s) and
publishes the delta to `live:{runId}`. Every API pod subscribes and fans out to
its own WebSocket subscribers. That satisfies FR-LIVE-7 with no sticky routing
and no shared state between pods. `ioredis` is already a dependency of both
`apps/api` and `apps/worker`.

### 3.4 Replay is a capped stream

Deltas also append to `live:{runId}:deltas` with `MAXLEN ~200`. A reconnecting
client sends its last sequence number and is replayed from there; a client
beyond the cap gets a full snapshot instead (FR-LIVE-8).

### 3.5 The raw byte log is the checkpoint

Bytes reach blob storage as they arrive. A worker that dies mid-run needs no
serialized engine state: the next lock holder re-folds from offset 0. At the
worst-case 250 MB that is seconds of CPU on a rare path, and it deletes an
entire class of checkpoint-format-versioning bugs.

**As per-chunk objects, because there is no append.** `BlobStore` offers
`putStream`, `get` and `delete` (`packages/storage/src/blob.ts`), and S3 has no
append operation at all. Chunks are written to
`live/{runId}/{offset padded to 16 digits}.bin` and concatenated at close.

The padding is load-bearing: assembly reads chunks in key order, and that is
only the byte order if lexicographic sorting matches numeric sorting.
Unpadded, `1000.bin` sorts before `999.bin`, silently reordering the stream —
and §3's opening sentence is that a reordering corrupts every record after it.

It also means that at `close`, the complete `simulation.log` is already in blob
storage where `bundleKey` expects it — so a live run finalizes into a row
indistinguishable from an uploaded one, and every existing read path works on
it unchanged.

---

## 4. The live dashboard

FR-LIVE-4 asks for active users, requests/s, responses/s, response-time
percentiles, error rate, and a live error table. Those are `UsersChart`,
`RatesChart`, `PercentilesChart` and `ErrorsTable`, all of which exist.

The delta payload is therefore shaped as the same DTOs the existing metrics
endpoints return. A `useLiveRun(runId)` hook writes them into the React Query
cache; the charts learn nothing about liveness and are not modified.

### 4.1 The time domain grows

Every time chart is a **value axis in milliseconds pinned to `[0, durationMs]`**
via `useTimeDomainFromShell`, because a connected `axisPointer` on a category
axis syncs by index and the payloads are sparse (CLAUDE.md, "A CONNECTED
`axisPointer` ON A CATEGORY AXIS SYNCS BY INDEX"). On a live run `durationMs`
is not fixed — the domain must expand with each delta.

That is a change to the shared hook, not a live-only branch: one code path
decides the domain for both cases, or the crosshair means one instant on a
finished run and something else on a live one. `apps/web/test/timeAxis.test.ts`
is the guard.

### 4.2 A phone never opens the socket

§22.6 makes the run page a read-only summary below 768 px, and `DesktopOnly`
takes its children as a **function** specifically so withheld content is never
built. Its `onShow` exists because withheld content usually needs data, and the
caller's queries are `enabled` on the same flag.

The WebSocket connection is gated on that same `useIsCompact()` flag. Otherwise
a phone holds an open socket, receives a delta every 5 s, and draws none of it —
precisely the "degrading badly" the rule exists to prevent.

---

## 5. Failure handling

| Failure | Response |
|---|---|
| Producer stops sending | Sweeper finalizes as `incomplete` (FR-LIVE-5, AC-LIVE-3) |
| Owning worker dies | Lock releases; next worker claims it and re-folds from blob offset 0 (§3.5) |
| Client disconnects briefly | Replayed from the capped delta stream (§3.4) |
| Client disconnects past the cap | Full snapshot resynchronization (FR-LIVE-8) |
| Agent restarts | Offset negotiation on its next chunk (§3.1) |

The sweeper already runs staleness queries with per-state thresholds
(`apps/worker/src/sweeper.ts:37`, `staleAfterMs` and `parsingStaleAfterMs`).
This adds `runningStaleAfterMs` beside them; the query shape is unchanged.

### 5.1 Recorded deviation: NFR-AV-5

NFR-AV-5 states that when Redis is unavailable, "live monitoring degrades to
polling." **It cannot here.** A `running` run writes nothing to Postgres until
`close`, so there is no row to poll. Making polling work would mean flushing
snapshots to Postgres on a timer, which is the write load this design rejected.

**The deviation:** Redis being down means live monitoring is unavailable. The
run is not lost — bytes continue to reach blob storage, and it finalizes
correctly at `close`. Recorded here in the same spirit as the README's
`/auth/*` RFC 9457 exception: a deliberate, scoped departure, not an oversight.

Revisit if the polling fallback is wanted in practice; the change is a timed
`MetricWriter.persist()` against partial state, and it is additive.

---

## 6. Testing

Beyond the standard gate, three new guards.

### 6.1 Chunk invariance — the load-bearing test

Feed the reference `simulation.log` through `LiveEngine` at **randomized chunk
boundaries** and assert deep equality against `runEngine` over the whole
buffer. This is what licenses §2.2, and therefore what licenses `close`
trusting the live fold. Randomized boundaries specifically, because a
fixed split can miss a boundary that lands inside a cached-string
back-reference.

### 6.2 Parity, unchanged

`parity.e2e.test.ts` guards the §2.1 class extraction. It is not modified.

### 6.3 A live run finalizes identically to an uploaded one

Stream the reference bundle's `simulation.log` through open → feed → close, and
assert the same figures the parity suite pins for the uploaded path. This is
the end-to-end statement that live and post-hoc are one pipeline.

### 6.4 Gate reminders

`pnpm test:unit` runs neither the integration nor the e2e suite, and the Go
agent is outside the pnpm workspace entirely:

```bash
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional. The tail-and-ship pump is another sampler/sender pair
over a bounded buffer, which is exactly the defect class those tests exist to
catch.

Adding suites raises the `pnpm test:unit` floor recorded in CLAUDE.md. Update
the two numbers there, or the next reader calibrates against a stale floor and
a silently-skipped Node-20 run looks like a pass.

---

## 7. Out of scope

| Excluded | Why |
|---|---|
| Starting, scheduling, or orchestrating the test | PRD §5.3, unchanged |
| FR-LIVE-6 live SLA early-abort signals | P1, and it needs the notification channels of M5, which do not exist |
| Connections / DNS panels | Not in `simulation.log`; see the telemetry-agent spec's §0 |
| A Logs tab | Different data source; not derivable from what we stream |
| Distributed runs / merging several generators | V2 (PRD §5.2). `Sketch.merge()` exists, so this design does not foreclose it |
| Short-lived per-run tokens | §1.4 |

---

## 8. Requirement coverage

| Requirement | Where |
|---|---|
| FR-LIVE-1 open / batch / close | §1.1, §1.3 |
| FR-LIVE-2 incremental aggregation | §2 |
| FR-LIVE-3 WebSocket deltas, 5 s default / 1 s floor | §3.3 |
| FR-LIVE-4 live dashboard contents | §4 |
| FR-LIVE-5 `incomplete` finalization | §1.2, §5 |
| FR-LIVE-6 early-abort signals | Out of scope (§7) |
| FR-LIVE-7 fan-out across API pods | §3.3 |
| FR-LIVE-8 replay buffer, snapshot resync | §3.4 |
| AC-LIVE-1 ≤5 s cadence, <2 s p95 latency | §3.3 |
| AC-LIVE-2 reconnect without a gap | §3.4 |
| AC-LIVE-3 inactivity → `incomplete`, labelled | §1.2, §5 |
| AC-LIVE-4 50 runs / 2 000 subscribers | §3.2, §3.3 — needs load verification, not just design |

AC-LIVE-4 is the one line above that a design cannot discharge on its own. It
is a measurement, and the implementation plan must schedule it.

---

## 9. Sequencing

The irreversible parts come first, and the transport is replaceable once they
are right.

1. **`LiveEngine` extraction** + chunk-invariance test (§2, §6.1). No
   user-visible change; `parity.e2e.test.ts` proves it.
2. **The contract** — states, three endpoints, `stream` scope, offset
   negotiation, blob append (§1, §3.1, §3.5). Verifiable with polling, no
   WebSocket yet.
3. **Ownership and fan-out** — Redis Stream, owning worker, pub/sub, replay
   (§3.2–3.4).
4. **The dashboard** — `useLiveRun`, growing time domain, compact gating (§4).
5. **Sweeper finalization** and the AC-LIVE-4 load measurement (§5, §8).

Steps 1 and 2 are the design's substance. If the transport in 3 turns out
wrong, it is rewritten against a contract and a fold that are already proven.
