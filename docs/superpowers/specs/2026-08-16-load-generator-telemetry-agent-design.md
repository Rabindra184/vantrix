# Load-generator telemetry agent — design

**Status:** proposed
**Date:** 2026-08-16
**Supersedes:** the "three telemetry families (connections, DNS, generator
health)" line carried as backlog since
`2026-08-15-cross-run-analysis-and-report-completeness-design.md` § *Out of
scope*.

**Goal:** answer "was the load generator itself the bottleneck?" — the question
that most often invalidates a run, and the one this platform currently cannot
answer at all.

---

## 0. Why an agent, rather than more parsing

Three independent sources agree that this data does not exist in what we
ingest. Recorded because this is the second capability to die on the same
finding, and it should not be rediscovered a third time.

1. **Our parser.** `plugin-gatling/src/records.ts` decodes five record types —
   `RUN, REQUEST, USER, GROUP, ERROR` — and a grep for
   `connect|dns|tls|bandwidth|cpu` across the whole package returns nothing.
2. **Gatling's own OSS report.** `fixtures/.../reference-report/index.html` is
   generated from `simulation.log`, and contains **zero** occurrences of
   `dns`, `tcp`, `tls`, `handshake`, `bandwidth` or `connection`.
3. **Gatling's source.** `LogFileDataWriter.scala` serialises Run, User,
   Response, Group and Error, and none of them carries TCP connect time, TLS
   handshake time, DNS resolution time, bandwidth, or host CPU/memory.

Gatling Enterprise collects this from an **agent on the load generators**, out
of band from the log entirely. Matching it means running something there too.

---

## 1. What is actually achievable, chart by chart

This is the section to argue with. It was built by walking Gatling's own
Load Generators section and mapping each chart onto a specific gopsutil call,
rather than by assuming a system-metrics library covers "telemetry".

| Gatling's chart | Kind | Source |
|---|---|---|
| CPU usage in percent — Total / User / Sys | cumulative | `cpu.Times()` → `User`, `System`, `Idle`, `Iowait` … |
| Memory Usage in MB | gauge | `mem.VirtualMemory()` → `Used`, `Total` |
| TCP Connections Events per Second | cumulative | `net.ProtoCounters(["tcp"])` → `ActiveOpens`, `PassiveOpens` |
| TCP Segment Events per Second — Received / Sent / Retransmitted / Received bad | cumulative | `net.ProtoCounters(["tcp"])` → `InSegs` / `OutSegs` / `RetransSegs` / `InErrs` |
| Bandwidth per second (Sent/Received) | cumulative | `net.IOCounters(false)` → `BytesSent`, `BytesRecv` |
| TCP Connection By State | gauge | `net.Connections("tcp")` → `Status` per connection, counted |
| GC Counts / GC Time per second | JVM-internal | **Not available** — and Gatling's own report rendered both as *"No data to display."* on the run walked, so this is not a gap against a working feature |

**The TCP Segment mapping is exact, not approximate.** Gatling's four series
are the MIB-II TCP counters, and `ProtoCounters` returns them under those
names. This is the part that turns "a CPU chart" into parity with a section.

### What an agent CANNOT deliver, at any effort

**Connect, TLS-handshake and DNS-resolution DURATIONS.** These are
per-operation timings known only to the HTTP client that performed them. A
host-level agent can count connections and segments; it cannot see how long one
handshake took. Reaching them needs instrumentation *inside* the load
generator — a Gatling plugin — or eBPF, or packet capture. All three are
different projects with different risks.

So this design delivers **the Load Generators family whole**, plus bandwidth and
connection-state from the Connections family, and **nothing from DNS**. §11 says
what the ledger should therefore say.

> A note on the recon: the captured section listing shows the TCP Connections /
> Segment Events charts under both **DNS** and **Load Generators**. That is
> almost certainly a section-boundary error in the notes rather than Gatling
> drawing them twice. It does not change the mapping above — those counters are
> host-level either way — but a second walk should confirm which section owns
> them before the ledger rows are written.

---

## 2. How a sample finds its run

The architectural decision, and everything else follows from it.

**The agent never knows about runs.** It cannot: a run does not exist in
PerfPortal until the bundle is POSTed, which happens *after* the test finishes.
Any design where the agent is handed a run id needs a handshake, an ordering
guarantee between test and upload, and a failure mode for when the upload never
comes.

Instead the agent is a daemon reporting `(host, wall-clock timestamp,
metrics)`, and **a run selects whatever overlaps its own window**:

```text
telemetry for run R = samples where
  sampled_at ∈ [R.toolStartedAt, R.toolStartedAt + R.durationMs]
```

`toolStartedAt` is the load test's own start from the tool header, and
`durationMs` its own span — both already stored, both already meaning exactly
this. The agent and the pipeline never have to meet.

**THE AGENT DOES NOT SEND `org_id` OR `project_id`.** They are columns on the
row, but they come from the TOKEN — never from the payload. An agent runs on a
load generator, which is a machine an attacker is far likelier to reach than
the API; a payload-supplied tenant would let a token for one project write
telemetry into another, and the read path would serve it without a murmur. The
same rule the ingest endpoint already follows, stated here because the schema
below lists both columns and would otherwise read as an invitation.

### Three consequences, stated rather than discovered

**`toolStartedAt` is nullable.** It is null until the worker parses, and null
forever for a run that never reached `complete`. Such a run has no window, so it
has no telemetry — the UI must say that rather than showing an empty chart,
which would read as "the generator was idle".

**Clock skew is now a correctness input.** If the generator's clock is thirty
seconds fast, its samples land thirty seconds off the run's axis, and nothing
about the chart looks wrong. The agent's timestamp cannot be trusted blindly, so
every row stores **both** `sampled_at` (agent clock) and `received_at` (server
clock). A persistent gap is visible, reportable, and the UI warns rather than
quietly misaligning. This is not solvable without a handshake; it is
*detectable* without one, which is the honest middle.

**Telemetry accrues whether or not a test is running.** That is a cost — a
daemon writing a sample a second forever — and also the feature: seeing that a
generator was already at 80% CPU *before* the test started is exactly the
finding that invalidates a run.

---

## 3. Schema

```sql
CREATE TABLE "telemetry_sample" (
    "sampled_on"    DATE        NOT NULL,   -- partition key, from sampled_at
    "org_id"        UUID        NOT NULL,
    "project_id"    UUID        NOT NULL,
    "host"          TEXT        NOT NULL,
    "sampled_at"    TIMESTAMPTZ NOT NULL,   -- the AGENT's clock
    "received_at"   TIMESTAMPTZ NOT NULL,   -- the SERVER's clock; see §2
    -- Cumulative counters, stored RAW. See §4.
    "cpu_user_ms"   BIGINT      NOT NULL,
    "cpu_system_ms" BIGINT      NOT NULL,
    "cpu_idle_ms"   BIGINT      NOT NULL,
    "cpu_iowait_ms" BIGINT      NOT NULL,
    "net_rx_bytes"  BIGINT      NOT NULL,
    "net_tx_bytes"  BIGINT      NOT NULL,
    "tcp_in_segs"       BIGINT  NOT NULL,
    "tcp_out_segs"      BIGINT  NOT NULL,
    "tcp_retrans_segs"  BIGINT  NOT NULL,
    "tcp_in_errs"       BIGINT  NOT NULL,
    "tcp_active_opens"  BIGINT  NOT NULL,
    "tcp_passive_opens" BIGINT  NOT NULL,
    -- Gauges, stored as read.
    "mem_used_bytes"  BIGINT NOT NULL,
    "mem_total_bytes" BIGINT NOT NULL,
    -- Connection counts by TCP state. JSONB because the state set is the
    -- kernel's, not ours: ESTABLISHED, TIME_WAIT, CLOSE_WAIT, SYN_SENT and
    -- more, and a column per state would need a migration every time an OS
    -- reports one we had not enumerated.
    -- `{"ESTABLISHED": 412, "TIME_WAIT": 88, "CLOSE_WAIT": 3}` — the states the
    -- kernel actually reported at that instant, absent when zero.
    "tcp_states" JSONB NOT NULL,
    CONSTRAINT "telemetry_sample_pkey"
      PRIMARY KEY ("sampled_on", "org_id", "project_id", "host", "sampled_at")
) PARTITION BY RANGE ("sampled_on");
```

Partitioned by date and dropped by partition, exactly like `run_series_bucket`,
`run_user_bucket` and `run_error_bucket` — retention here matters more than for
those, because this table grows on wall-clock time rather than on runs.

**The partition key is the agent's date, not the server's.** It has to be, so a
sample lands in the partition its `sampled_at` implies and a window query can
prune. A clock skewed across midnight puts a sample in the neighbouring
partition; the pruning predicate covers both edges, and §2's stored `received_at`
is what makes such a case diagnosable.

---

## 4. Counters are stored raw, and the server does the arithmetic

Every cumulative source is sent **as the counter**, never as a rate the agent
computed. Three reasons, and the third is the one that matters:

- The sampling interval is the agent's, and it drifts. A rate computed against
  an assumed interval is wrong by exactly that drift.
- Re-bucketing at read time (§6) needs the underlying counts.
- **A counter reset must be detectable.** A process restart or an interface
  flap sends the counter back to zero. Given raw values the server sees
  `current < previous` and skips that interval; given a pre-computed rate it
  sees a plausible enormous spike and draws it. That spike is
  indistinguishable from a real traffic burst, and it would be the first thing
  a reader believed.

CPU percentages are derived the same way: `Δbusy / Δtotal` across a pair of
samples, never `cpu.Percent()`, which blocks for its interval and would make
the agent's sampling loop pause inside the measurement it is taking.

---

## 5. The agent

A single static Go binary using `gopsutil/v4`. It samples on a fixed interval
(default 1 s, configurable), batches, and POSTs.

**Batching:** whichever comes first — 30 samples or 10 seconds. Small enough
that a crash loses at most ten seconds of history, large enough that a 1 s
sampler is not one request per second per generator. The endpoint takes an
array so the boundary is a tuning constant, not a protocol change.

### It must never perturb the run

The one thing a measurement tool may not do is change what it measures, so
these are requirements rather than niceties:

- **Bounded buffer, drop-oldest.** If the network to PerfPortal fails, the
  agent keeps a fixed number of batches and discards the oldest. It never grows
  memory, and it never blocks the sampler on the sender.
- **Non-blocking sampling.** No call that sleeps for an interval — see §4 on
  `cpu.Percent`.
- **Failure is silent and cheap.** A rejected POST is logged at most once per
  interval and otherwise dropped. An agent that retried aggressively during an
  outage would add load to a machine whose load is the thing being measured.
- **A stated footprint budget**, measured rather than assumed, in the same
  spirit as the windowed re-aggregation benchmark: **under 1% of one core and
  under 50 MB RSS at a 1 s interval.** The plan must measure it; if it misses,
  the interval is the first lever.

### Identity

`--host-label`, defaulting to the OS hostname. Hostnames collide and change on
ephemeral generators, so the label is configurable and is the dimension every
chart is grouped by. It is not a foreign key to anything.

---

## 6. Ingest and read

### Ingest

`POST /v1/telemetry`, a batch of samples, authenticated with a **new
`telemetry` scope** — not `ingest`.

That distinction is the point. An agent token lives on a load generator, which
is often shared, often ephemeral, and often less carefully managed than CI. It
must not be able to upload bundles or read results. The scope set today is
`ingest` and `read`; this adds a third that can do exactly one thing.

### Read

`GET /v1/runs/:id/telemetry`, and it does one thing that makes everything else
free: **it converts each sample's wall-clock time into an elapsed offset from
`toolStartedAt`, then buckets into the run's own `bucketWidthMs`.**

Once the series is offset-based and bucketed like every other series in the
system, it inherits — with no further work — the shared crosshair, the same
x-axis as every other chart, and **the `?from=&to=` window**, because that
window is expressed in the same offsets.

Response carries one series per host plus the same `window` object every other
time-axis endpoint now returns, and `available: false` for a run whose
`toolStartedAt` is null or which has no overlapping samples — distinguishing
"no telemetry recorded" from "the generator was idle", the same way
`ErrorSeriesResponse.available` does.

---

## 7. Web

A **Load generators** tab beside Charts, Statistics, Errors and Trends, with a
host filter mirroring Gatling's own — because a run across six generators where
one is saturated is exactly the case this exists for, and an aggregate would
hide it.

Charts, in Gatling's own decomposition: CPU (Total/User/Sys), Memory,
Bandwidth, TCP Connections Events/s, TCP Segment Events/s
(Received/Sent/Retransmitted/Received bad), and connections by state.

Every one is a `Chart` on the shared `run-time` crosshair group, so hovering a
response-time chart moves the pointer on generator CPU at the same instant —
which is the whole reason to have this on the same page rather than in Grafana.

> **Correction, 2026-08-16.** The claim above was tested and found false.
> `RunChartsTab` and `RunTelemetry` are siblings under one `<Outlet/>` in
> `RunShell` (final-review fix wave) — navigating between them unmounts one
> and mounts the other, so they are never on screen together, and a
> response-time chart's crosshair cannot move a generator-CPU chart's
> pointer. What the shared `run-time` group actually delivers is sync among
> the six TELEMETRY charts WITH EACH OTHER: hovering any one of them moves
> the pointer on the other five at the same instant, which is still the
> reason this tab exists rather than a link out to Grafana — see
> `apps/web/src/charts/TelemetryCharts.tsx`, which states it correctly.

---

## 8. Testing

| Layer | What it proves |
|---|---|
| Agent (Go) | Counter deltas across a reset produce a skipped interval, not a spike. CPU percentages derive from `Δbusy/Δtotal`. The buffer drops oldest and never grows. |
| Agent bench | The §5 footprint budget. |
| `packages/statistics` | Re-bucketing wall-clock samples into run-relative offsets, including a sample outside the run's window being excluded at the edge. |
| `persistence` integration | Round trip; partition pruning on the windowed telemetry query, asserted against the exported SQL constant. |
| `api` integration | The `telemetry` scope cannot upload a bundle and `ingest` cannot post telemetry — asserted both ways, since a scope that is not enforced is decoration. `available: false` for a run with a null `toolStartedAt`. The window narrows telemetry exactly as it narrows `/series`. |
| `web` e2e | The tab draws per host; the brush narrows it with the other charts. |

Expectations derived from the payload throughout.

---

## 9. The cost that is not code

This adds **Go to a pure pnpm/TypeScript monorepo**. Today the only non-TS
artifact in the repository is one `decode.mjs` spike, and CI is a single Node
job with Postgres, Redis and MinIO services.

That means, all new: a Go toolchain in CI (`actions/setup-go`), a second test
command in the gate, cross-compiled binaries for the platforms generators
actually run on (linux/amd64 and linux/arm64 at minimum), checksums, and a
distribution story — the agent is useless if it cannot be installed on the box.

This is more novel process than the agent's logic, and the plan should sequence
it first: an empty Go module that builds and tests in CI, before any metric is
collected. Discovering the toolchain story at the end of a sub-project is how
the last one lost an afternoon to a stacked-PR trap.

---

## 9b. A note on sequencing

One feature, four layers, strictly ordered — the plan should draw its task
boundaries here rather than by file:

1. **The Go toolchain.** An empty module that builds and tests in CI, before
   any metric is collected. §9 explains why this is first and not last.
2. **The agent**, tested against its own counter and buffer behaviour with no
   server at all.
3. **Ingest and storage** — the scope, the endpoint, the migration.
4. **Read and UI** — the offset re-bucketing, then the tab.

Each is independently testable: the agent can be proven correct before an
endpoint exists to receive it, and the endpoint before a chart exists to draw
it.

---

## 10. Out of scope

- **Connect / TLS / DNS duration distributions** — §1. They need client-side
  instrumentation, not a host agent.
- **GC counts and time** — JVM-internal, and blank in Gatling's own report.
- **Alerting on generator saturation.** Showing it is this project; acting on
  it is another.
- **Agent auto-update.** A binary that rewrites itself on a load generator
  mid-test is a way to invalidate a run.
- **Non-Linux generators.** `ProtoCounters` is richest on Linux, which is what
  load generators run. macOS support is a convenience for developers, not a
  target.

---

## 11. What the ledger should say

Not "the three telemetry families are done". Precisely:

- **Load generators — CPU, memory, TCP segment and connection events** →
  becomes **Have** when this ships. It is the whole of Gatling's section bar
  GC, which is blank in theirs.
- **Connections — bandwidth, connections by state** → **Have**.
- **Connections — TCP connect and TLS handshake duration distributions** →
  stays **Missing**, and should be split out as its own row for the reason the
  time-window row was split: a bundled row scored Partial hides which half is
  done.
- **DNS — resolution duration** → stays **Missing**.

Three new rows and one split, so the ledger reports a capability gained without
implying a family finished.
