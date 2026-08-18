# Live run monitoring, part 2b — the fan-out and the live dashboard

**Status:** design, approved 2026-08-18
**Supersedes:** part 1 §3.3, §3.4 and §4 (transport and dashboard), which were
written before the fold owner existed and describe a delta shape that did not
ship.
**Builds on:** `2026-08-17-live-run-monitoring-design.md` (part 1),
`2026-08-17-live-run-monitoring-part-2a-design.md` (part 2a).

Part 2a ends with deltas on `live:{runId}` and a capped replay stream. Nothing
consumes them. This part carries a delta from that channel to a chart in a
browser, and it is the first part of M7 a user can see.

---

## 0. What part 1 promised that part 2a did not deliver

Part 1 §4 says:

> The delta payload is therefore shaped as the same DTOs the existing metrics
> endpoints return. A `useLiveRun(runId)` hook writes them into the React Query
> cache; the charts learn nothing about liveness and are not modified.

The second sentence is the design this part keeps. The first is false as
shipped, and the gap is not cosmetic — it makes two of FR-LIVE-4's six P0 items
unbuildable.

**Per-bucket latency is absent.** `LiveSeriesBucketSchema`
(`packages/contracts/src/live-delta.ts`) carries `startOffsetMs`,
`startedCount`, `endedCount`, `okCount`, `koCount` — and stops.
`SeriesBucketSchema` (`metrics.ts`) additionally carries `startedOkCount`,
`startedKoCount`, `minMs`, `maxMs`, `meanMs`, `percentiles`, `percentilesOk`
and `percentilesKo`. `PercentilesChart` takes a `SeriesResponse` and calls
`toPercentiles(series, …)`, which reads the per-bucket bands. A delta cannot
drive it. The delta's only latency figures are `summary.percentiles`, which are
whole-run scalars, not a series.

**Error rows are absent entirely.** `ErrorsTable` is fed by `errorsQuery(runId)`
against `GET /v1/runs/:id/errors`. The delta has `summary.koCount` and
`summary.errorRate` and nothing else about failures.

**And REST cannot cover the gap while the run is live.** Part 2a §3.2 closes
with "Full detail stays on the existing REST endpoints for on-demand
drill-down." That is true of a *finished* run. Persisted metrics are written by
`new MetricWriter().persist(…)` at `apps/worker/src/pipeline/pipeline.service.ts:336`,
inside the parse pipeline, which runs only after `close()`. For a run at status
`running`, `RunStat`, `RunSeriesBucket`, `RunError`, `RunUserBucket` and
`RunErrorBucket` hold no rows for that run at all. **Anything not in the delta
cannot be displayed during the run, by any path.**

So the delta widens. §1.

### 0.1 Why the widening is small

Both missing pieces are already computed by the fold owner on every tick; only
the serialization drops them.

- Every `Bucket` carries `sketch`, `sketchOk`, `sketchKo`
  (`packages/statistics/src/buckets.ts`). The batch path derives its stored
  bands from exactly those.
- `EngineResult.errors` is already assembled by `Engine.snapshot()` and already
  capped, at `rollup.top(200)` per key.

Part 2a §3.2's exclusion argument is about **per-endpoint** statistics, whose
row count tracks the run's endpoint cardinality (2000 at the cap). It does not
reach run-scope bands on a bucket series already capped at `maxBucketsRun`, nor
a run-scope error list already capped at 200. Those exclusions stand; these two
additions do not contradict them.

---

## 1. The delta widens

### 1.1 The response-time bucket gains the batch path's fields

`LiveSeriesBucketSchema` gains `startedOkCount`, `startedKoCount`, `minMs`,
`maxMs`, `meanMs`, `percentiles`, `percentilesOk`, `percentilesKo` — the same
names, types and nullability `SeriesBucketSchema` uses, so a live bucket and a
persisted bucket are the same shape and the chart transform cannot tell them
apart.

### 1.2 ONE derivation, shared — not a second copy

`percentilesOf` is a **private function** at
`packages/persistence/src/metrics/write.ts:184`:

```ts
function percentilesOf(sketch: { count: number; quantile(q: number): number }): Record<string, number> {
  if (sketch.count === 0) return {};
  const out: Record<string, number> = {};
  for (const p of BUCKET_PERCENTILES) out[`p${p}`] = sketch.quantile(p / 100);
  return out;
}
```

and the surrounding write derives min/max/mean as `b.sketch.count === 0 ? 0 :
b.sketch.min` (and `.max`, and `.sum / .count`).

**A live publisher that reimplements this is the two-decoder mistake again.**
Part 2a's CLAUDE.md entry states the rule for the record decoder — "drift
between two decoders surfaces as the live chart contradicting the final report,
which is the worst failure this product can produce" — and this is the same
hazard on the same product surface. The empty-bucket guards are exactly where a
reimplementation drifts: `percentilesOf` returns `{}` for an empty sketch while
min/max/mean return `0`, an asymmetry nobody reproduces from memory.

`percentilesOf` and the min/max/mean derivation move to
`@perfportal/statistics` as one exported helper — `bucketLatency(bucket)`
returning `{ minMs, maxMs, meanMs, percentiles, percentilesOk, percentilesKo }`.
`BUCKET_PERCENTILES` already lives there (`engine.ts:26`), so the constant and
its only consumer stop being in different packages. `MetricWriter` and the fold
owner both call it. Neither has its own copy.

`BUCKET_PERCENTILES` is a **fixed** `[25, 50, 75, 80, 85, 90, 95, 99]`, not the
project's configured `percentiles` — `write.ts:171` says so, and
`apps/web/src/charts/transforms/percentiles.ts` is built against those eight
bands. The live path inherits that fixedness and needs no project settings to
publish a bucket.

### 1.3 A run-scope `errors` envelope

```
errors: { rows: [{ message: string | null, count: number }] }
```

Run scope only, from `EngineResult.errors` filtered to `scope === 'run'`.
`message: null` is `ErrorTally`'s folded remainder and is carried through
rather than dropped — the table renders it as the "other" row, and omitting it
would make the counts fail to sum.

**Per-endpoint error rows stay excluded**, on part 2a §3.2's argument
unchanged. A run at the endpoint cap would publish thousands of rows per tick
per subscriber; the Errors tab's per-request drill-down is a REST read on a
finished run.

**No `errorSeries` envelope is added, and the original reason given here was
wrong.** This section first claimed the "Errors per second" figure is driven by
the response-time series' per-bucket `koCount`. It is not: `RunDetail.tsx`
binds that chart to `errorSeriesQuery` — a **separate endpoint** — and a
comment beside it says so outright ("the flat totals and the time series are
different endpoints"). So the delta genuinely cannot feed that chart, and no
argument about avoiding two sources applies.

The envelope is still excluded, on scope rather than on that reasoning:
errors-over-time is **not** one of FR-LIVE-4's six items, and
`EngineResult.errorSeries` already exists, so a follow-up can carry it
whenever the chart is wanted live. What this part does instead is refuse to
let the chart vanish silently — §4.3 gives it a withheld notice like the
other three.

### 1.4 What this costs on the wire

Per bucket, the addition is 8 bands x 3 variants + `minMs`/`maxMs`/`meanMs` +
two started splits = **29 numbers**, against the 5 a live bucket carries today.

**Per tick this is nearly free**, because the response envelope emits only the
lookback window (part 2a §3.2) — `ceil(maxMs / widthMs)` buckets plus the
frontier, single digits for an ordinary run. A few kilobytes.

**Per snapshot it is not**, and that is §2's subject: a full 1200-bucket series
at ~34 numbers per bucket with JSON keys is on the order of **0.8-1.2 MB**.

This interacts with a cap part 2a already set. `REPLAY_BUDGET_BYTES` is 4 MiB
per run and the retained entry count is recomputed per publish from the current
body size, so **fatter deltas shrink the replay window**. Since the widening
touches only the lookback window, the shift is small — but it is the reason
§2's snapshot is a separate key rather than a periodic keyframe inside the
stream, where it would compete with the replay depth it exists to compensate
for.

---

## 2. A snapshot key beside the delta stream

### 2.1 The problem neither prior design states

A client that connects mid-run cannot reconstruct the run from the stream.

Each delta's response envelope is a **window**, not the series. Replaying
`live:{runId}:deltas` from its oldest entry does rebuild the whole series —
every bucket appears in some delta's lookback window — but only while the
stream still reaches back to the run's start. It does not for long:
`REPLAY_MAX_ENTRIES` is 200, so at the 5 s default the stream spans **about 17
minutes**, and less whenever `REPLAY_BUDGET_BYTES` bites first.

Open the run page 20 minutes into a soak test and the first 3 minutes are gone,
with no path to recover them until the run finishes. Soak runs are the case
live monitoring exists for, and a dashboard that silently begins at minute 20
is close to the failure FR-LIVE-4 is meant to prevent.

The same arithmetic covers reconnects: a laptop asleep longer than the window
rejoins with holes.

### 2.2 The shape

On every `SNAPSHOT_EVERY_N_TICKS`th tick, `LiveFoldOwner#publish` additionally
writes its **whole** current state — the complete response-time series, not the
lookback window, plus the users envelope and summary it already builds — to

```
SET live:{runId}:snapshot <json> EX <ttl>
```

carrying the `seq` it corresponds to.

**The GATEWAY performs the seed, not the client.** A browser cannot read a
Redis key, so the three steps below are server-side work the gateway does on
connect, before the socket carries anything else:

1. `GET live:{runId}:snapshot` — read the seed,
2. `XRANGE live:{runId}:deltas ({snapshot.seq} +` — read the catch-up,
3. `SUBSCRIBE` (via `LiveHub`, §3.3) for everything after.

The socket therefore carries two frame types: one `snapshot` frame first,
then `delta` frames. The client's protocol is "connect, seed from frame one,
apply the rest" — it never addresses Redis and never assembles the seed
itself.

On reconnect the client passes its cursor as a **query parameter**,
`?lastSeq=N`, and the **server** decides: replay from the stream when it still
reaches back that far, or send a fresh `snapshot` frame when it does not. A
`seq` gap detected mid-stream is the same decision, so the client has exactly
one recovery path and the server owns the judgement about what is recoverable.

**A query parameter rather than a first frame.** As a frame, the server cannot
know whether a given connection intends to send one, so it must wait before
seeding EVERY connection — and fresh connects, which send nothing, are the
common case. The cursor is known before the socket opens, so paying a round
trip for it buys nothing.

**The snapshot frame carries its own `lastSeq`, and that field is
load-bearing.** The producer stamps the snapshot key with the seq of the delta
it does NOT yet contain (`fold-owner.ts` writes `next.seq` against the
`EngineResult` the previous delta was built from). A client that echoed the
frame's `delta.seq` back as `?lastSeq=` would therefore ask the server to skip
precisely the delta its seed is missing — the same silent hole, one layer up.
Two states make the resume point unknowable from any other signal: a seed built
from a snapshot alone, and a seed sent when neither key exists yet. So the
server states the resume point outright:

```
{ type: 'snapshot', delta: LiveDelta, partial: boolean, lastSeq: number }
{ type: 'delta', delta: LiveDelta }
```

`lastSeq` is deliberately absent from delta frames, where `delta.seq` is
already unambiguous.

**A missing snapshot is degraded, not broken.** If the key has expired under a
stalled producer (§2.4), the gateway sends whatever the stream still holds and
marks the frame as partial; the client draws it and says so. That is strictly
better than refusing the connection for a run that is genuinely still
streaming.

### 2.3 The interval and the replay cap are ONE decision

The stream must always retain back to the last snapshot, or the seam drops
buckets — and it drops them *silently*, because a client cannot tell a bucket
that was never sent from one that had no traffic.

`REPLAY_MAX_ENTRIES` is 200 and `REPLAY_BUDGET_BYTES` can lower the retained
count below that at any moment. So the snapshot interval is chosen against the
**byte-derived** floor, not the entry cap: `SNAPSHOT_EVERY_N_TICKS` is 60 (5
minutes at the default tick), and the connect path treats "the stream's oldest
entry is newer than the snapshot's seq" as a recoverable state — re-`GET` the
snapshot, which by then has advanced — rather than as an error. That check is
cheap and it is the only thing standing between a shrinking replay window and a
silently holed chart.

### 2.4 Memory, stated

A snapshot is up to ~1.2 MB for the response series; the users envelope can add
~1 MB more for a 20-scenario soak (part 2a's own worst case: 1200 buckets *per
scenario*). Call it ~2 MB per live run, ~100 MB at NFR-SC-4's 50 concurrent
runs, beside the ~200 MB the replay budget already allows.

`infra/docker-compose.yml` sets no `maxmemory` and no eviction policy —
deliberately, since this Redis also carries BullMQ job data and every fitting
policy would start dropping jobs. **The TTL is therefore load-bearing, not
hygiene**: it is the only thing that reclaims a snapshot whose run died without
`close()`. It is set to **one hour**, refreshed on every write.
`runningStaleAfterMs` defaults to 10 minutes, so the sweeper finalizes an
abandoned run six times over inside that window, and the TTL is twelve times
the 5-minute write interval — comfortable margin against a producer that is
merely slow rather than dead. A run whose ticks stall long enough to outlive it
loses only the seed, which §2.2's last paragraph handles.

---

## 3. The gateway

### 3.1 `ws`, not socket.io

`@nestjs/websockets` + `@nestjs/platform-ws`. The browser is the only client,
the traffic is one-directional apart from a resume cursor, and socket.io's
fallbacks and framing buy nothing here.

Endpoint: `/v1/runs/:id/live`.

### 3.2 Nest's HTTP guards DO NOT run on an upgrade

`AuthGuard`, `SessionOnlyGuard` and `@Scopes(...)`
(`apps/api/src/auth/`) are HTTP guards bound to the request pipeline. A
WebSocket upgrade does not traverse it. **A gateway that declares
`@UseGuards(AuthGuard)` and stops there is unauthenticated while reading as
guarded** — the decorator is accepted and never consulted.

The gateway validates explicitly in its connection handler, before any
subscription:

1. Parse the Better Auth session cookie off the upgrade request and resolve a
   session. The web client is same-origin (`credentials: 'same-origin'`
   throughout `apps/web/src/api/`), so the cookie is present on the upgrade
   without any client change.
2. Resolve the run and confirm the session's user is a member of the run's org
   — the same authorization the REST run reads apply, not a weaker one.
3. Reject anything else by closing with a policy code, never by accepting the
   socket and sending an error frame: an accepted socket is one an unauthorized
   caller can hold open.

An integration test asserts a cookieless upgrade and a wrong-org upgrade are
both closed, because this is the one failure in this part that is invisible
from the UI.

### 3.3 `LiveHub` — one subscriber per pod, not per socket

A single injectable owns:

- one `ioredis` subscriber connection for the pod,
- `Map<runId, Set<WebSocket>>`.

`SUBSCRIBE live:{runId}` on the first socket for a run; `UNSUBSCRIBE` on the
last one to close. Fan-out is a loop over the run's set.

This is what makes FR-LIVE-7's "no sticky routing" true rather than
aspirational: every pod receives every delta for the runs it has viewers for,
and no viewer needs to reach a particular pod. It is also why the subscriber is
per pod — a connection per socket would put a Redis connection count on the
viewer count.

### 3.4 A slow socket is closed, not buffered

A client that stops reading while deltas keep arriving grows `bufferedAmount`
without bound, and the pod pays for it. Above **8 MiB** the socket is closed
with a code the client treats as "reconnect and resume from §2.2".

The threshold has to clear one `snapshot` frame with room to spare — §2.4 sizes
that at up to ~2 MB — or the seed itself would trip the guard on a slow link
and the connection could never establish. 8 MiB is four such frames: a client
that far behind is not reading. Dropping a slow viewer is recoverable; an
unbounded per-socket buffer on a shared pod is not.

---

## 4. The client

### 4.1 `useLiveRun(runId)`

Opens the socket when `run.status === 'running'` **and** `!useIsCompact()`.

The second condition is part 1 §4.2 and CLAUDE.md's §22.6 rule: below 768 px
the run page is a read-only summary, `DesktopOnly` takes its children as a
function so withheld content is never built, and the caller's queries are
`enabled` on the same flag. A phone holding an open socket to receive a delta
every 5 s and draw none of it is precisely the "degrading badly" that rule
exists to prevent.

The hook writes deltas into the React Query cache under the keys the REST
queries already use. The charts are not modified and learn nothing about
liveness — part 1 §4's design, now actually reachable because §1 made the
payload the right shape.

### 4.2 The time domain grows, in ONE code path

`useTimeDomainFromShell` (`apps/web/src/routes/useRunWindow.ts:83`) returns
`[0, durationMs]` from the shell's run object, or the window when one is set.
On a live run `durationMs` is not fixed; it comes from the latest delta's
`summary.durationMs`.

This is a change to the shared hook, not a live-only branch. Part 1 §4.1 is
explicit about why, and CLAUDE.md's axis rule is the underlying reason: every
time chart is a value axis pinned to one domain so a connected `axisPointer`
means one instant across the page. Two ways of deciding that domain is two
answers to "what instant is the crosshair on". `apps/web/test/timeAxis.test.ts`
is the guard.

### 4.3 Three sections say what they are waiting for

The statistics table (Overview), the distribution chart and the scatter chart
cannot be live: the first needs per-endpoint rows §1.3 excludes, the other two
need per-request or full-sketch data no delta carries.

They render an explicit "available when the run finishes" state — not a
spinner, which claims something is arriving, and not an empty chart, which
claims there is nothing to draw.

Live: the summary's headline numbers, users, request and response rates,
response-time percentiles, and the Errors **table**. **Errors-over-time is
NOT** — its endpoint is not on the live wire (§1.3), so it takes a withheld
notice rather than disappearing.

**What shipped is a standalone live page, not the five-tab run page this
section originally described.** That was a design error, not an implementation
shortcut: `RunsService.statusFor` answers **202** for every status short of
`complete`, and a 202's body is `RunProcessing { id, status, statusUrl }` — no
project, no tool, no verdict. `RunShell` renders its header and tabs from a
full `RunResponse`, so it cannot render for a running run at all. Delivering
the five-tab version means widening the 202 body to carry a running run's
identity, which is a contracts and API change and its own sub-project.

The consequence to know: a run ending is a **layout** change, not just a data
swap — the standalone page is replaced by the tabbed one. Trends and Load
generators are unreachable while a run is live, though neither needs this part
(telemetry already reaches `TelemetrySample` through the agent's own path
during the run, not through the parse pipeline).

### 4.4 The run ends: freeze, do not blank

`running` -> `parsing` -> `complete` (or `incomplete`). During `parsing` the
socket is gone — the fold owner released the run — and REST still has nothing,
because `MetricWriter` has not run.

The page keeps the last delta on screen as a static snapshot under a banner
saying the run has finished and results are being finalized, and polls run
status. When status reaches a terminal state the same components re-render from
REST with the full detail, including the three sections of §4.3.

Falling back to the existing `Processing` screen was rejected: it takes a
populated dashboard away and replaces it with a spinner, which reads as
something having gone wrong at the exact moment nothing has.

### 4.5 Reconnect

Exponential backoff with a cap and jitter. On reconnect the client passes
`?lastSeq=N` and takes whatever the server sends back — a replay or a fresh
snapshot frame, per §2.2. **The value it passes is the `lastSeq` the server
gave it**, never a seq it derived from a delta's own contents. It never
assumes it can resume from the channel alone, and it never decides for itself
whether its own seq is still recoverable.

---

## 5. Testing

### 5.1 Live and batch agree, bucket for bucket

The load-bearing test of this part. For one fixture run, the fields §1.1 adds
to a live bucket must equal what `MetricWriter` persists for the same bucket —
same bands, same min/max/mean, same empty-bucket answers (`{}` for percentiles,
`0` for min/max/mean). This is what §1.2's shared helper exists to guarantee,
and the test is what stops the two drifting later.

### 5.2 A late joiner reconstructs the run

Fold a run past the point where the replay stream no longer reaches its start,
then connect a fresh subscriber and assert its reconstructed series equals the
owner's. Without §2 this fails with holes at the front, which is the defect the
section exists for.

### 5.3 The gateway rejects what it should

A cookieless upgrade and a valid-session-wrong-org upgrade are both closed, and
neither receives a delta. §3.2's failure is silent from the UI, so it is only
ever caught here.

### 5.4 Two pods, one publish

Two `LiveHub` instances against one Redis, two sockets on different instances,
one publish: both sockets receive it. FR-LIVE-7's actual claim.

### 5.5 The client's states

Unit: the hook writes cache entries the charts already read; the frozen state
survives the socket closing; the compact flag prevents the socket opening at
all. E2E: a seeded `running` run draws live charts and shows the three withheld
sections in their waiting state.

### 5.6 AC-LIVE-1

Part 2a deferred "<2 s p95 delta latency" here, as the first point at which
there is an end-to-end path to measure. Measured from the fold owner's publish
to the client's receipt across a real socket.

**Measured (Task 8, `apps/web/e2e/run-live.spec.ts`): 107ms**, publishing
directly to `live:{runId}` (the same channel `LiveFoldOwner#publish` writes
to) and timing to the browser's own `WebSocket` `framereceived` event for
that delta — a real gateway, a real Redis round trip, a real socket, with
the fold owner's own tick stood in for by the test's publish, which is the
one piece a browser-only harness cannot run for itself. A single clean
sample on a local stack, not a fleet-wide p95, but two orders of magnitude
under the 2s target, so the target holds with margin to spare against
render time, GC pauses and a slower network this measurement did not
exercise.

### 5.7 Gate reminders

Node 22 (`nvm use`) — on 20 roughly two thirds of the unit suite silently does
not load, including every component test a UI change needs.

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

integration BEFORE e2e, and the Go agent's gate is separate:

```
cd agent && go vet ./... && go test ./... -race
```

Two CLAUDE.md traps this part is positioned to hit: a new `<caption>` must
share no distinctive word with an existing table's (the Errors table is already
queried by name in the e2e suite), and `getByRole(role, { name })` is exact in
Testing Library and a case-insensitive substring in Playwright.

---

## 6. Carried from part 2a

Three residuals were recorded against PR #38 as known-and-unfixed. This part is
already in those files:

| Residual | Why it belongs here |
|---|---|
| `assemble()` has no contiguity check, though it produces the final `simulation.log` | `readFrom` gained one; the terminal path did not. Safe today only because `claimForClose` is a CAS, which nothing in the code states. |
| The replay byte-bound is optimistic by up to one oversized delta | §1.4 makes deltas bigger; the bound should be honest before that lands. |
| `LiveChunkGapError` reports an interior gap position as the caller's argument | Reads as a caller bug rather than a `finalize` race; §2's connect path is a new caller. |

---

## 7. Out of scope

| Excluded | Why |
|---|---|
| Per-endpoint statistics and per-endpoint error rows in the delta | Part 2a §3.2, unchanged — unbounded by run size |
| Distribution and scatter, live | Need per-request or full-sketch data; §4.3 |
| FR-LIVE-6 live SLA early-abort signals | P1, and it needs M5's notification channels |
| A lifecycle rule on the `live/` prefix | Still open, still `infra/` |
| Live view on a phone | §22.6 and part 1 §4.2 — deliberately not built |

---

## 8. Requirement coverage

| Requirement | Where |
|---|---|
| FR-LIVE-4 live dashboard, all six items | §1 (percentiles, errors), §4.3 (the rest) |
| FR-LIVE-7 WebSocket fan-out across pods | §3.3, proven by §5.4 |
| FR-LIVE-8 replay buffer (reader) | §2.2, §4.5 |
| FR-LIVE-3 delta cadence (consumer side) | §4.1 |
| AC-LIVE-1 <2 s p95 delta latency | §5.6 |
| NFR-SC-4 50 concurrent live runs | §2.4's memory budget |

---

## 9. Sequencing

1. **Extract `bucketLatency` to `@perfportal/statistics`** and switch
   `MetricWriter` to it. Pure refactor, no behaviour change, provable by the
   existing batch tests.
2. **Widen the delta** (§1) and publish the new fields. §5.1 passes here.
3. **The snapshot key** (§2). §5.2 passes here.
4. **`LiveHub` and the gateway** (§3). §5.3 and §5.4 pass here.
5. **The client** (§4). §5.5 and §5.6 pass here.
6. **The part 2a residuals** (§6).

Step 1 is deliberately first and deliberately boring: it is the step that makes
the live and batch numbers the same by construction rather than by review, and
everything after it depends on that being settled.
