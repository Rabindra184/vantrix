# Live run monitoring, part 2a — the fold owner

**Status:** proposed
**Date:** 2026-08-17
**Delivers:** the producer half of PRD **M7** — FR-LIVE-2 (incremental
aggregation) and the production side of FR-LIVE-3 (deltas at a configurable
cadence). Part 2b consumes what this publishes.

**Supersedes** §3.2 of `2026-08-17-live-run-monitoring-design.md`, whose premise
no longer holds. See §0.

**Goal:** a run that is currently streaming has a live, incrementally-maintained
set of statistics, published on a timer, without ever re-parsing from scratch.

**Non-goal:** anything a user can see. No WebSocket, no HTTP surface, no UI.
This sub-project ends with deltas on a Redis channel and a test subscriber
proving their shape.

---

## 0. Why this supersedes §3.2

The original design said bytes land on a Redis Stream (`live:{runId}:bytes`)
consumed by the owning worker. **Part 1 built a different data path.**
`LiveService.stream` writes each chunk straight to blob storage as
`live/{runId}/{offset padded to 16}.bin` and advances a Postgres cursor
(`run.stream_offset`). Nothing publishes bytes to Redis at all.

Three ways to close that gap were considered:

| Option | Rejected because |
|---|---|
| Add the Redis Stream as specced — API dual-writes bytes | Every byte stored twice. At the design's 250 MB worst case against NFR-SC-4's 50 concurrent runs, Redis would hold up to ~12.5 GB of bytes that already exist, durably, in object storage. |
| Fold in the API process | The API is stateless and multi-replica; the fold state needs exactly one home per run. Solving that means sticky routing or an in-process owner map — which is precisely what a worker plus an advisory lock already solves. |
| **Read from blob storage, woken by a ping** | **Chosen.** |

**The chosen shape:** the owner reads the chunk objects that already exist,
and the API publishes a *notification* — a run id, not the bytes — so the owner
wakes immediately instead of polling. That buys the Redis-Stream design's
latency without duplicating a single byte, and it means Redis carries only
notifications and deltas, never the byte stream.

§3.5's checkpoint property is what makes this work: the bytes are already
durable and already ordered, so "where the fold got to" needs no persistence.

---

## 1. Ownership

### 1.1 One owner per run, on the lock that already exists

`LiveFoldOwner` lives in `apps/worker/src/live/`, is constructed in
`apps/worker/src/main.ts` beside `Sweeper`, and is closed in the same
`shutdown()`. It holds a `Map<runId, FoldState>`.

It claims a run with **`pg_try_advisory_lock(RUN_INGEST_LOCK_NAMESPACE,
hashtext(runId))`** — the same namespace constant
(`8_531_001`, `pipeline.service.ts:67`) and the same mechanism
`PipelineService.process` already uses.

Reusing that lock rather than minting a second namespace is deliberate and buys
a property neither would have alone: a run cannot be folded by two workers, AND
it cannot be folded while the pipeline is parsing it. `close()` moves a run to
`parsing` and enqueues the pipeline; if the fold owner still held a separate
lock it could be folding the same run while `PipelineService` re-parses it into
the terminal statistics.

**The lock must be held on one connection and released on it** — the pattern at
`pipeline.service.ts:56-78`, which is careful about this for the reason its own
comment gives. The owner holds a dedicated `pg.PoolClient` per owned run for the
lock's lifetime, which bounds concurrent owned runs by the pool size. That bound
is real and is the reason `maxOwnedRuns` exists (§1.3).

### 1.2 Discovery is pub/sub AND a poll, deliberately

Two paths find runs to own:

- **`live:opened`** — the API publishes a run id when `POST /v1/runs/live`
  succeeds. Gives latency.
- **A poll** of `SELECT id FROM run WHERE status = 'running'` on the tick,
  skipping ids already owned. Gives correctness.

The poll is not redundant. A run opened while every worker was down, or during
a deploy, produces a pub/sub message nobody receives — Redis pub/sub is
fire-and-forget with no persistence. Without the poll those runs are silently
never folded, and the symptom is a live dashboard that stays empty for one run
and works for the next, which is close to undiagnosable from the outside.

### 1.3 A bound on owned runs

`maxOwnedRuns` (default 25, config in the `apps/worker/src/config.ts` style)
caps the map. Each owned run costs one pooled connection (§1.1) plus its fold
state, and NFR-SC-4's target is 50 concurrent live runs across the deployment —
so two workers at 25 meets it, and one worker cannot exhaust its pool trying to
own everything.

At the cap the owner logs and skips. It does **not** drop an owned run to make
room: releasing a run mid-stream throws away a fold that would have to restart
from byte 0.

---

## 2. Folding

### 2.1 State per run

```ts
interface FoldState {
  decoder: StreamingLogDecoder;   // packages/plugin-gatling
  engine: LiveEngine;             // packages/statistics
  client: pg.PoolClient;          // holds the advisory lock
  fetchedBytes: number;           // absolute offset of the FETCH FRONTIER (§2.2.1)
  lastSeq: number;                // monotonic, per run
  lastPublishedOffsetMs: number;  // series high-water mark (§3.2)
  lastBucketWidthMs: number;      // coalesce detector (§3.3)
}
```

`fetchedBytes` is **not persisted and starts at 0 on claim.** The owner re-folds
the run's existing chunks from the beginning. That is §3.5's checkpoint property
doing its job: no serialized engine state, no checkpoint format to version, and
a worker dying mid-run costs seconds of CPU rather than correctness.

The cost is honest and worth stating: claiming a run that has already streamed
200 MB means folding 200 MB before its first delta. That is a rare path (worker
restart, or a run opened before this worker started) and it is bounded by the
same 250 MB the design sizes everything else against.

### 2.2 Reading the bytes

On a `live:advance` ping or on the tick, the owner reads chunk objects at or
past `fetchedBytes`, in ascending offset order, feeds them to
`decoder.push(bytes)`, and folds every emitted event into `engine.add(event)`.
`fetchedBytes` then advances by the **length of the bytes it just received**.

### 2.2.1 The cursor is the fetch frontier, NOT the decode position

An earlier draft of this section advanced the cursor to `decoder.consumedBytes`.
**That is wrong, and it corrupts the fold.**

`consumedBytes` is the last **whole record** boundary, which routinely sits
*before* the last byte fetched — a record straddling a chunk boundary leaves a
partial tail the decoder buffers. Feeding that value back to `readFrom`, whose
filter selects every chunk whose START is at or past it, re-selects chunks
already delivered. The decoder then receives those bytes a second time, splices
them after the tail it correctly retained, and every absolute position from
there on is wrong — silently, for the rest of the run.

The trigger is ordinary, not exotic: `POST /v1/runs/:id/stream` caps a chunk's
size but sets **no minimum** (`live.controller.ts`), so a client may send chunks
smaller than a single Gatling record, and then `consumedBytes` sits behind
several delivered chunks' start offsets at once.

**So the owner tracks two independent positions:**

| Position | Owned by | Meaning |
|---|---|---|
| `fetchedBytes` | `FoldState` | the highest byte fetched from storage — what `readFrom` is given |
| `consumedBytes` | the decoder | the last whole-record boundary — what the decoder retains from |

`fetchedBytes += bytes.length` is exact, and does not need per-chunk lengths:
offset negotiation only accepts a chunk when `offset === cursor` (Part 1's
`LiveService.stream`), so a run's chunks tile `[0, stream_offset)` with no gap
and no overlap. The first chunk `readFrom` returns therefore starts exactly at
`fetchedBytes`.

The decoder needs no help with the remainder: `push` calls
`append(chunk, this.#consumed)`, which retains everything from its own consumed
position. The two cursors do not need to agree — they need to not be confused
for each other.

**`LiveChunkStore` needs one new method.** It has `assemble()` (everything) and
`finalize()`. This needs *"chunks at or past offset N"*, built on the
`BlobStore.list(prefix)` Part 1 added (`blobs.ts:175`). Key names encode the
offset zero-padded to 16 digits, so the filter is a comparison on the parsed
offset and the ordering is the existing lexicographic sort.

### 2.3 The ping carries no bytes

`LiveService.stream` publishes the run id to `live:advance` after a chunk is
accepted. Fire-and-forget: it must never block the 202, and a dropped ping is
harmless because the tick's poll picks the run up within one interval. This is
the one place Part 2a modifies `apps/api`.

---

## 3. The tick and the delta

### 3.1 Cadence

One timer on the owner, not one per run. `liveTickMs` defaults to **5000** with
a floor of **1000** — FR-LIVE-3's numbers. Each tick, for every owned run:
snapshot, build a delta, publish.

Snapshots use `engine.snapshot({ clone: true })`. The `clone` flag exists for
exactly this: without it the returned rollups alias accumulators the next fold
mutates, and a delta serialized across an await would describe a state that
existed at no instant.

### 3.2 What a delta contains

**Summary — a snapshot, bounded by nothing about run size:**
total / ok / ko counts, error rate, the run-scope percentiles, max concurrent
users, elapsed duration.

**Series — append-only:** run-scope response-time buckets, user buckets, and
error buckets whose `startOffsetMs` exceeds `lastPublishedOffsetMs`.

**`seq`** — monotonic per run, so a consumer can detect a gap.

Per-endpoint statistics are **not** in the delta. FR-LIVE-4's list is what a
live dashboard shows, and it is bounded; a run at the 2000-endpoint cap would
otherwise publish thousands of rows every 5 s per subscriber. Full detail stays
on the existing REST endpoints for on-demand drill-down.

### 3.3 Coalescing breaks append-only, and the delta must say so

`BucketSeries` halves its resolution **in place** when a run exceeds
`maxBucketsRun` (`buckets.ts`, and the coalesce is why merges must be exact).
Every bucket's `startOffsetMs` is rewritten. So "buckets past offset N" is not
stable across a coalesce: every bucket a consumer already holds silently
changes identity, and its accumulated series is wrong from that point on with
nothing thrown and nothing logged.

**The fix uses a signal that already exists.** `BucketSeries` exposes
`widthMs` (`buckets.ts:58`). Every delta carries the width it was built at.
When the width differs from `lastBucketWidthMs`, the message is flagged a
**full replacement** — it carries the entire series and the consumer discards
what it held.

Coalescing halves at most a bounded number of times over a run (each halving
doubles the window the same cap covers), so replacements are rare. §5.3 is the
guard, and it is not optional: this failure is silent in exactly the way this
codebase's worst bugs have been.

### 3.4 Where deltas go

Published to `live:{runId}` (pub/sub, for Part 2b's fan-out) **and** appended to
`live:{runId}:deltas` with `MAXLEN ~200` (the replay buffer, FR-LIVE-8).

Part 2a writes the capped stream even though nothing reads it until Part 2b.
Splitting a stream's writer from its reader across two sub-projects would leave
2b unable to test replay against anything real.

---

## 4. Release

The owner drops a run when its status leaves `running` — `close()` claims it to
`parsing`, or the sweeper finalizes it `incomplete`. Detected on the tick, which
is already re-reading status to discover new runs.

On release: delete the fold state, release the advisory lock, return the pooled
client.

**No terminal delta is published.** A run's real terminal state comes from
`GET /v1/runs/:id`, and a second source of truth for "this run is done" is how
the two drift apart.

---

## 5. Testing

### 5.1 The owner reaches the batch numbers

`chunk-invariance` already proves `LiveEngine` + `StreamingLogDecoder` agree
with `runEngine`. This proves the **wiring**: an owner reading real chunk
objects out of blob storage reaches the same statistics as a batch parse of the
same log. If 5.1 fails while chunk-invariance passes, the defect is in this
sub-project, not in the fold.

### 5.2 Deltas have the right shape

Open a run, stream the reference log in chunks, subscribe to `live:{runId}`
with a plain `ioredis` client, and assert: summary scalars present and
non-zero, series strictly append-only across consecutive deltas, `seq`
monotonic with no gaps.

### 5.3 A coalesce produces a replacement, not a silent append

Force a run past `maxBucketsRun` and assert the delta's width changes AND the
message is flagged a replacement. §3.3's hazard gets its own guard.

### 5.4 Two owners race, one wins

Two `LiveFoldOwner` instances against one run: exactly one claims it, and the
loser folds nothing and publishes nothing.

### 5.5 Gate reminders

`pnpm test:unit` runs neither integration nor e2e. Full gate, integration
**before** e2e:

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

`agent/` is untouched by this sub-project, but its gate is separate and stays
green by not being touched.

Adding suites raises the `pnpm test:unit` floor in `CLAUDE.md` (currently
**92 files / 1029 tests**). Update it and name what moved it.

---

## 6. Out of scope

| Excluded | Why |
|---|---|
| WebSocket endpoint, replay *reads*, the dashboard | Part 2b |
| FR-LIVE-6 live SLA early-abort signals | P1, and it needs M5's notification channels |
| Per-endpoint statistics in the delta | §3.2 — unbounded by run size; REST already serves them |
| A lifecycle rule on the `live/` prefix | Real and still open, but it is `infra/`, not this |

---

## 7. Requirement coverage

| Requirement | Where |
|---|---|
| FR-LIVE-2 incremental aggregation | §2 |
| FR-LIVE-3 delta cadence (producer side) | §3.1 |
| FR-LIVE-7 fan-out across pods (producer side) | §3.4 — pub/sub, no sticky routing |
| FR-LIVE-8 replay buffer (writer) | §3.4 |
| NFR-SC-4 50 concurrent live runs | §1.3 — two workers at the default cap |
| AC-LIVE-1 <2 s p95 delta latency | §2.3's ping is what makes this reachable; **measured in Part 2b**, where there is an end-to-end path to measure |

---

## 8. Sequencing

1. `LiveChunkStore.readFrom(runId, offset)` (§2.2) — small, independently testable.
2. `LiveFoldOwner`: claim, fold, release — no publishing yet. §5.1 and §5.4 pass here.
3. The tick, the delta shape, and the coalesce flag (§3). §5.2 and §5.3 pass here.
4. The API's `live:advance` ping (§2.3) — one call in `LiveService.stream`.

Step 2 is the substance. Steps 3 and 4 are replaceable against a fold that is
already proven — the same shape that worked for Part 1.
