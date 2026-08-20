# Streaming a Gatling run live from Gradle — design

**Status:** design, approved 2026-08-20
**Builds on:** live run monitoring parts 1, 2a, 2b; live SLA signals; the
five-tab live page (all merged).
**Requirement:** FR-LIVE-1 (P0) — "A run may be opened in `running` state,
receive incremental batches, and be closed explicitly or by inactivity
timeout." The server half of that has shipped. This is the client.

A Gradle plugin, applied beside `io.gatling.gradle`, that opens a live run
when `gatlingRun` starts, streams `simulation.log` to PerfPortal as Gatling
writes it, and closes the run when the task finishes. The reader watches the
run on the five-tab live page while it happens, and reads the finished report
on the same page when it ends.

---

## 0. What this is not

**It does not run tests.** Gradle runs the test, exactly as it does today; this
plugin only ships bytes. That distinction is the whole reason this design is
permissible: PRD §5.3 names "executing, scheduling, or orchestrating load
tests" as the single most important non-goal, and R-9's tripwire is "any story
assuming the platform runs a test". Nothing here asks the platform to run
anything.

R-9 also says the ingest contract "keeps it a separable future product". This
plugin is a client OF that contract, which is the shape §5.3 leaves open.

**It does not launch the telemetry agent.** Deferred, §8.

**It reads no Gatling internals.** It watches a directory and drives our own
HTTP contract. An `io.gatling.gradle` upgrade cannot break it.

---

## 1. Liveness is bounded by Gatling's buffer, not by us — MEASURED

Gatling writes through `io.gatling.core.stats.writer.BufferedFileChannelWriter`.
It flushes in **8 KiB blocks**, not per record. Sampling `simulation.log` every
5s through a real ~95s run of `example.BasicSimulation` at ~18 req/s:

```
t+20s        0 bytes          <- nothing at all for the first 20 seconds
t+25s     8191
t+40s    16383                <- +8 KiB
t+50s    24574
t+60s    32764
t+75s    49146
t+95s    65529                <- steady 8 KiB steps
t+115s   66826                <- final partial block, only at close
```

Two consequences the design must own rather than hide:

**A low-throughput test updates rarely.** Update cadence tracks how fast the
run fills 8 KiB, not our tick. A 5 req/s smoke test may show nothing for a
minute. That is Gatling's behaviour, not a defect in this plugin, and the
plugin must not pretend otherwise.

**The last block arrives only at close.** The tail of every run appears in one
step when Gatling closes the file.

The plugin therefore **ships whatever bytes exist on a timer**, including a
partial block. That costs nothing on our side: `StreamingLogDecoder` already
retains a partial record at a chunk boundary and `consumedBytes` already tracks
the last whole-record boundary, so a partial flush is a case the fold path
solved before this plugin existed.

Rejected: hooking Gatling's `DataWriter` SPI for true per-record liveness. It
buys real fidelity and costs a plugin written against a Gatling-internal
interface that can change between versions — trading this design's central
property (no coupling to Gatling internals) for a smoother chart.

---

## 2. The lifecycle

Attached to the existing `gatlingRun` task; never replacing it.

```
doFirst      POST /v1/runs/live { tool: "gatling", environment, branch,
                                  commitSha, idempotencyKey }
                                 -> 201 { runId, streamUrl, nextOffset }
             log the run URL so the operator can click through
             start a daemon thread

thread       wait for a results directory created after t0
   loop      read from `nextOffset`, capped at 4 MiB
             POST /v1/runs/:id/stream  (X-Stream-Offset: nextOffset)
               202 -> advance to the returned nextOffset
               409 -> resume from the nextOffset it names
             sleep tickSeconds

completion   final read + POST, then POST /v1/runs/:id/close
             on task FAILURE too
```

**Offset negotiation is what makes a dropped tick harmless.** A 409 carries the
exact resume point, so the client never guesses and a gap can never reach the
decoder — whose string-cache back-references mean one misplaced byte corrupts
every record after it.

**4 MiB, half the server's 8 MiB `MAX_STREAM_CHUNK_BYTES`.** The API buffers a
chunk in memory before it can judge the offset, so the cap is a memory bound on
the server, not a size limit on the run. Staying well under it means a 413 is a
bug rather than a routine condition.

**No shutdown hook.** If the build is killed, `close` never runs and the run
ages out through the sweeper's `running` branch, finalizing as `incomplete` —
which is exactly what that branch exists for (`stream_updated_at`, not
`created_at`, so a long soak is not finalized merely for being long). A hook
racing JVM teardown is a worse failure than letting the designed path run.

---

## 3. One PerfPortal run per simulation

`gatlingRun` with no `--simulation` runs every simulation, producing several
results directories in sequence. Each gets its own open/stream/close cycle.

This matches how the platform already models a run — one tool execution, one
simulation identity, one verdict, one assertion set — and keeps trends
comparable, since a run's comparability fingerprint includes its simulation.
Streaming only the first would be arbitrary from the reader's point of view.

The watcher therefore looks for each new directory in turn, not once.

---

## 4. Configuration, and where the token is not

```kotlin
perfportal {
    url = "https://perf.example"     // or PERFPORTAL_URL
    environment = "staging"           // optional
    branch = "main"                   // optional
    commitSha = "a1b2c3d"             // optional
    tickSeconds = 5                   // optional, default 5
    uploadIfLiveUnavailable = false   // optional, default false — §5
}
```

Every value falls back to an env var of the same name, so CI configures the
build file not at all.

**The token is `PERFPORTAL_TOKEN`, and nothing else.** Not a config value —
`build.gradle.kts` is committed to git. Not a CLI flag — flags land in the
process list, which is why the agent's `main.go` deliberately has no `--token`
and carries a comment saying so. One token bearing the `stream` scope is the
whole requirement.

**Metadata is passed, never inferred.** No shelling out to `git`: a detached
HEAD in CI makes branch detection confidently wrong, and all three fields are
optional in `OpenLiveRunRequestSchema` — absent is better than wrong.

`idempotencyKey` is one UUID per task execution, reused across retries of that
same open call. That is the case the contract names: a generator that opened,
lost the response, and asked again must resume its run rather than open a
second.

---

## 5. Failure behaviour

**The build never fails because of this plugin.** Streaming is best-effort
observability; the test is the valuable thing, and losing telemetry must never
cost someone a 40-minute soak or block a deploy.

Each failure gets its own response, not one blanket catch:

| Situation | Response |
|---|---|
| Open fails (unreachable, 401, 403) | Warn with the API's own `remediation`; skip streaming; build proceeds |
| Stream POST fails (network) | Bounded retry with backoff; give up quietly; still attempt `close` |
| `409 STREAM_OFFSET_REJECTED` | Not an error — resume from the `nextOffset` it names |
| `413` | Should not occur; reads are capped at 4 MiB. Treat as a bug, log loudly |
| `401`/`403` mid-stream | Stop immediately, no retry — a bad token will not fix itself |
| Build killed | `close` never runs; sweeper finalizes `incomplete` (§2) |

**`uploadIfLiveUnavailable`, default false.** When the live run could not be
opened, the plugin can POST the completed bundle to `/v1/runs` after the task,
so evidence is captured even when live was impossible. Off by default because
it is a second code path with a second failure mode, and because a run
appearing minutes after the test is a different thing from the one the plugin
announced at the start. Teams who need guaranteed capture opt in.

---

## 6. The toolchain, which is the real cost

This adds a **third toolchain**: TypeScript workspace, the Go agent, now a
JVM/Kotlin artifact. All new: a JVM job in CI, a gate command, and a publishing
target.

**The agent is the cautionary precedent, and it is exact.** Its own design §9
named "a distribution story — the agent is useless if it cannot be installed on
the box" as required, and §9b said to sequence the toolchain FIRST because
"discovering the toolchain story at the end of a sub-project is how the last one
lost an afternoon". Today `agent/dist` is git-ignored, no workflow publishes it,
and the binaries exist only on whichever laptop built them. The debt was named
and then incurred anyway.

So the plan sequences: **an empty plugin that builds, tests and PUBLISHES in CI,
before it streams a single byte.** A plugin nobody can `plugins { id(...) }` is
exactly as useless as a binary nobody can install.

Lives at `clients/gatling-gradle/`, outside the pnpm workspace, so `pnpm lint`,
`pnpm typecheck` and every `pnpm test:*` are blind to it — the same split the
agent already has, and the same reason its gate is a separate command.

---

## 7. Testing

Three layers, because they fail differently:

**Streaming logic against a fake HTTP server.** Offset advance, 409 resume,
retry and backoff, the 4 MiB cap, close-on-failure. No Gradle, no Gatling,
no network — fast and deterministic.

**Task wiring via Gradle TestKit.** That `doFirst` opens; that completion
closes *including when the task fails*; that config and env fallbacks resolve
in the documented order; that a multi-simulation run opens one run per
simulation.

**One end-to-end against the real stack.** The `gatling-gradle-plugin-demo`
project streaming into a running PerfPortal, asserting the run reaches
`complete` and that its re-evaluated assertion actuals equal what Gatling
itself printed. That comparison was performed by hand during this design —
`11494`, `85.8457997698504` and `179`, matching to the last decimal — and this
test is what turns it into a gate.

---

## 8. Out of scope

- **Launching the telemetry agent.** The Load generators tab needs it, and the
  plugin was intended to start it — but the agent has no release story to fetch
  it from (§6), and inventing one is a prerequisite sub-project, not a detail of
  this one. The config block leaves room; that tab keeps its honest "appears
  once the run finishes" notice meanwhile.
- **Non-Gatling tools**, and Maven or any other build system.
- **Hooking Gatling's `DataWriter` SPI** (§1).
- **Executing tests from PerfPortal** (§0, PRD §5.3).
