# Gatling Enterprise report parity: Connections, DNS, Load generators

Sub-project 2 of the enterprise parity programme, as revised on 2026-10-22.
It replaces the "load-generator aggregate pipeline" framing: PerfPortal runs
one load generator per run, so there is nothing to aggregate across
generators. What is missing is the data Gatling Enterprise (GE) collects from
INSIDE the running Gatling process.

## 1. Intent

The user compares PerfPortal against GE page by page and wants every GE report
chart that makes sense for PerfPortal's deployment, with correct data, and the
charts named, shaped and filtered as GE has them.

PerfPortal is deployed on an on-prem VM with Docker. A run has exactly one
load generator, which is one of:

- **the PerfPortal VM itself**: a run started from the web UI, executed by the
  on-prem runner (`apps/runner`);
- **a remote VM**: someone runs Gatling there through the Gradle plugin
  (`clients/gatling-gradle`), which streams the results to PerfPortal.

### Why this needs new machinery

GE's Connections, DNS and Load generators sections are built from data that
`simulation.log` does not contain. Open-source Gatling 3.15.1 performs DNS
resolution, TCP connects and TLS handshakes inside `gatling-http-client`
(`DefaultHttpClient.resolveChannelRemoteAddresses`, `installSslHandler`, the
channel pool), but its public `HttpListener` reports only request and response
events. GE collects these from its own closed-source runtime; that is why
`CLAUDE.md` and `RunReport.tsx` record the DNS, TCP-connect, TLS and GC charts
as deliberately omitted ("nothing here collects them"). This sub-project makes
something collect them.

## 2. What GE shows, measured

Measured on the user's GE account (org `demo-perf`, test
`perfportal-parity-basic`, Run 1, Gatling 3.15.1, one generator in
Europe - Paris) on 2026-10-22, by recording the JSON behind every report chart
over a debug Chrome's DevTools port. The raw responses are committed in
`docs/superpowers/research/2026-10-22-ge-report-captures/` (account and user
records removed); they are the reference for every shape below.

All GE series are **per second** (`timeSeries.resolution: 1`) over the run's
offset window, with whole-run sums beside them (`sumSeries`).

**Connections** (`GET /series/connections`, filter **Remote** from
`GET /remotes`, values like `api-ecomm.gatling.io/13.36.32.156:443`):

| Chart | Data |
|---|---|
| Connection Open and Close Rate | counts `tcp.c.conn.+` / `tcp.c.conn.-` per second; legend Opened, Closed |
| TCP Connection By State | grouped `tcp.gc.conn.tcpState`, a per-second GAUGE for 11 states: synSent, established, bound, idle, finWait1, finWait2, closeWait, closing, lastAck, timeWait, close |
| TCP Connect Duration Percentiles | `distributionsOverTime.tcpConnectDuration`, OK / KO / all, 13 rows per second |
| TCP Connect Duration Distribution | `distributions.tcpConnectDuration`: offset, step (3 ms here), OK and KO counts, mean |
| TCP Connection Percentiles Distribution | `percentileDistributions.tcpConnectDuration`: (percent, ms) pairs, OK / KO / all |
| TLS Handshake Duration Percentiles / Distribution / Percentiles Distribution | the same three shapes for `tlsHandshakeDuration` |
| Bandwidth Usage per second | `bw.c.bit.out` / `bw.c.bit.in` in bits, drawn in Mbps; legend Sent, Received |

**DNS** (`GET /series/dns`, filter **Hostname** from `GET /hostnames`):

| Chart | Data |
|---|---|
| DNS Resolution per Second | `dns.c.req`, `dns.c.ok`, `dns.c.ko` |
| DNS Resolution Duration Distribution / Percentiles Distribution / Percentiles | `dnsResolutionDuration`, the same three shapes as above |

**Load Generators** (`GET /series/injectors`, picker **Load generator** from
`GET /injectors`, "Europe - Paris: 51.44.10.141"):

| Chart | Data |
|---|---|
| GC Counts per Second | grouped `inj.gc.gc.count`, one series per collector ("ZGC Major Cycles", "ZGC Minor Pauses", ...) |
| GC Time per Second | grouped `inj.gc.gc.time`, same labels |
| CPU usage in percent | `inj.c.cpu.user`, `inj.c.cpu.sys`; legend User, Sys |
| Memory Usage in MB | `inj.c.ram.max`, `inj.c.ram.current`, `inj.c.heap.max`, `inj.c.heap.com`, `inj.c.heap.used`, `inj.c.netty.direct`, `inj.c.netty.heap`; legend RAM total, RAM used, Heap max, Heap committed, Heap used, Netty direct, Netty heap |
| TCP Connections Events per Second | grouped `inj.gc.tcp.evt`: active openings, failed attempts, established, received resets, sent resets |
| TCP Segment Events per Second | grouped `inj.gc.tcp.seg`: received, sent, retransmitted, received bad |

**Requests** has one chart PerfPortal lacks: **Responses per Second by
Status**, from grouped `req.gc.cd` (one series per HTTP status code: 200, 401,
403, 404 on that run).

**What the filters narrow, measured.** Re-recorded with the report opened at
`?remote=api-ecomm.gatling.io%2F13.36.32.156%3A443` (one of the run's three
remotes): connections opened and closed went from 480 to 149, TCP-connect and
TLS samples from 480 to 149, bits sent from 9,611,856 to 2,985,120, and the
TCP-state gauges (time-wait summed over the run 16,644 to 5,364, established
376 to 119). So **Remote scopes every Connections chart**, TCP-by-state
included: GE counts the states of Gatling's own sockets to that remote, not
the machine's whole socket table. With no remote chosen GE shows all remotes
together (its wildcard, drawn as `*`). Hostname works the same way for DNS
(this run had one hostname, so its narrowing could not be observed and is
inferred). The Load generator picker scopes the Load Generators section, whose
CPU, RAM and TCP event and segment figures are machine-wide (495 active
openings against Gatling's 480 connections).

**The 13 percentile rows** are GE's fixed set, read out of its front-end
bundle: Min, 25%, 50%, 75%, 80%, 85%, 90%, 95%, 99%, 99.9%, 99.99%, Max, and
the mean. The same set serves the response-time, TCP-connect, TLS and DNS
percentile charts.

**Not applicable to PerfPortal:** GE's stats aggregator, multi-generator
deployment, location weights and the per-location picker beyond a single entry.
One generator per run makes them moot.

## 3. Goals

1. Every chart in section 2 exists in PerfPortal's run Report, under the same
   section, with GE's title, legend, units and filters (Remote, Hostname, Load
   generator), on both run paths (on-prem runner and Gradle plugin).
2. Every number is correct for the run that produced it, to PerfPortal's
   accuracy standard D: exact counts, exact 1 ms durations, nearest-rank
   percentiles, and an independent re-check from the raw data.
3. The extra data costs the run under test as little as possible, and can
   never fail a simulation that would otherwise have succeeded.

## 4. Non-goals

- Several load generators per run, location weighting, or a stats aggregator.
- GE's other test settings (injection override, load generator parameters,
  SLOs, time window, stop criteria). They are separate parity items.
- Live drawing of the new charts while a run streams. They appear once the
  run has finished, as five of the existing Requests charts already do
  (`LiveNotice kind="withheld"`). *(The design's call; GE's live behaviour for
  these sections was not measured.)*
- Identical numbers to a GE run. Two runs never produce the same numbers, and
  GE's generator sits in Paris; see section 9 for what "exact" is held to.

## 5. Anti-goals

- **A chart that draws empty or zero where nothing was measured.** No data
  must say why (an older Gatling, a non-Linux generator, a run that predates
  this), never read as "measured and found idle". This is the rule the
  telemetry slots already follow (`RunTelemetry`'s three states).
- **An agent that can break or skew the test.** An exception in collection
  disables collection for the rest of the run and is recorded; it never
  propagates into Gatling. Overhead must be measured, not assumed.
- **Numbers that cannot be re-checked.** Every new figure is recomputable
  from a raw file stored with the run, the way `packages/verify` re-checks
  statistics against `simulation.log`.

## 6. Decided with the user

- **A Java agent is loaded into every Gatling JVM PerfPortal starts or
  streams from**, on both paths, and instruments Gatling's HTTP client
  internals. The user accepted that it is tied to Gatling versions and must be
  re-verified on every Gatling upgrade. This supersedes the 2026-10-15 parity
  matrix's recommendation of a maintained Gatling fork: a fork cannot reach the
  Gradle path, where the user's own build supplies Gatling.
- **GE's 13 percentile rows apply to the new charts only.** TCP-connect, TLS
  and DNS percentile charts draw Min, 25%, 50%, 75%, 80%, 85%, 90%, 95%, 99%,
  99.9%, 99.99%, Max and Mean from the start. The existing response-time
  charts keep today's set (`BUCKET_PERCENTILES`); moving them to GE's set is a
  separate follow-up, because it touches every stored run, the live delta and
  the verifier.
- **Machine figures are whole-machine, as GE's are.** On a run started from
  the web UI the generator is the PerfPortal VM, shared with the database, API
  and worker, so its CPU, RAM and TCP event and segment charts include
  PerfPortal's own load. That is accepted: it is what the generator machine
  experienced, and it is what can starve a test. The Load generators section
  says the machine is shared when the run came from the on-prem runner.
- **"Exact" means three things** (section 9): the same chart set as GE;
  numbers correct for our own run against its raw data; and a side-by-side
  comparison of one simulation run on GE and through PerfPortal.

## 7. Design

### 7.1 The agent

A Java agent jar, built in this repository beside `tools/gatling-method` and
following its precedent (a JDK build stage in `infra/Dockerfile`, smoke-run at
image build).

- **Bytecode level: Java 11.** Gatling 3.15 runs on Java 11+, and on the
  Gradle path the JVM is the user's, not PerfPortal's image's Java 21.
- **Instrumentation** of `io.gatling.http.client` (3.15.1 first) for: DNS
  resolution start, end, outcome and hostname; TCP connect start, end, outcome
  and remote (hostname/IP:port); TLS handshake start, end and outcome; channel
  open and close; bytes written and read per channel; HTTP response status
  code.
- **Version gate.** The agent instruments only the exact
  `gatling-http-client` versions it has been verified against. On any other
  version it skips HTTP-client instrumentation, still collects the JVM and
  operating-system figures below, and records why in its output so the Report
  can say "not collected for Gatling X.Y.Z".
- **JVM figures, once per second:** per-collector GC count and time
  (`GarbageCollectorMXBean`), heap used, committed and max
  (`MemoryMXBean`), Netty direct and heap memory (Netty's own allocator
  metrics, read reflectively from the simulation's Netty).
- **Socket figures, per remote:** connections opened and closed, bytes sent
  and received, and TCP state per second, for Gatling's own sockets only (the
  sockets the instrumented client opened), keyed by remote, so the Remote
  filter can narrow every Connections chart as GE's does. A remote is
  `hostname/IP:port`; DNS figures are keyed by hostname.
- **Machine figures, once per second, Linux only:** CPU user and system % (as
  GE labels them), RAM total and used, and TCP connection events and segment
  events (the `/proc/net/snmp` counters GE's labels name). On another OS
  these are absent and the Report says so; the CPU/RAM fallback to
  `OperatingSystemMXBean` is the builder's call.
- **Output:** one append-only file in the run's results directory beside
  `simulation.log`, with a versioned header (agent version, Gatling version,
  what is and is not collected and why). It records each DNS, connect and TLS
  event individually (timestamp, duration in ms, outcome, hostname or
  remote) and the per-second samples. Raw events, not pre-aggregated
  histograms, so the verifier has an independent source.

### 7.2 Getting the agent into the JVM

- **On-prem runner:** `jvmArgs()` in `apps/runner/src/artifact.ts` adds
  `-javaagent:<path>=<file>`. The jar ships in the image at
  `/opt/perfportal/`, readable by the simulation's uid 20001. The run id is
  already known before Gatling starts (`executor.ts`).
- **Gradle plugin:** the plugin adds the `-javaagent` to the `gatlingRun`
  task's `jvmArgs` (the upstream `io.gatling.gradle` 3.15.1.2 exposes
  `jvmArgs` on `GatlingRunTask` and on the `gatling {}` extension), and carries
  the agent jar inside its own jar, extracting it under the build directory.
  It must not overwrite `jvmArgs` the user already set.
- **Opt-out:** each path can switch the agent off (a runner job option and a
  plugin setting) for a user who suspects it.

### 7.3 Getting the file to PerfPortal

The agent file travels the way `simulation.log` does, with its own offsets:

- the runner's `SimulationLogTailer` pattern tails it into object storage;
- the Gradle plugin's `RunTailer` pumps it to the API with the same `stream`
  token;
- an uploaded results bundle includes it when present.

The wire shape (a second stream per run, or one stream carrying a file key)
is the builder's call. A run without the file (older plugin, upload without
it, agent off) is normal and reads as "not collected".

### 7.4 Processing and storage

The worker parses the agent file at finalize, in the same pipeline and lock
as `simulation.log`, into per-run, per-second rows following the existing
conventions:

- **Durations** (DNS resolution, TCP connect, TLS handshake) go into
  `run_series_bucket`-style rows with new families, scoped by hostname or
  remote, with `sparse-ms-v2` histograms split OK/KO, so percentiles,
  distributions and windows reuse the existing exact machinery.
- **Counts and gauges** (connection open/close, bandwidth, DNS
  request/OK/KO, TCP states, GC, CPU, memory, TCP events and segments, status
  codes) go into a counter/gauge table keyed by run, metric, label and second.
  Socket figures carry a remote dimension and DNS figures a hostname
  dimension (section 2's measurement), with an all-remotes / all-hostnames
  total available without summing on read. The exact table design is the
  builder's call; partitioning and the partition-day binding follow
  `run_series_bucket` and `partitionDay`.
- **Resolution: the existing bucket machinery, not a new one.** *(The
  design's call.)* The new rows start at 1 second and coalesce on long runs
  exactly as `run_series_bucket` does today (`maxBucketsRun`), so the time
  brush, `bucketWidthMs` and windowed reads work unchanged. A short run shows
  GE's 1-second resolution; a multi-hour soak shows the same coarser width
  every other chart on its Report already uses.
- **Verification:** `packages/verify` gains a check that recomputes these
  figures from the stored agent file, independently of the code that wrote
  them, as it does for `simulation.log` today. *(The design's call:)* it is
  part of the run's one verification status, not a second one. A mismatch in
  an agent figure makes the run read "mismatch" like any other; a run with no
  agent file is verified on its `simulation.log` alone, as before.
  `VERIFIER_VERSION` is bumped, so the scan re-checks stored runs; those have
  no agent file, so their answers do not change.

### 7.5 The Report

`apps/web/src/routes/RunReport.tsx`:

- **Connections**, **DNS** (new) and **Load generators** carry GE's charts
  from section 2, with GE's titles, legends, units (ms, Mbps, MB, %, per
  second) and filters. Load generators has a single-entry picker naming the
  generator (the runner's host, or the Gradle VM's hostname).
- **Requests** gains "Responses per Second by Status".
- The new percentile-over-time charts draw GE's 13 rows (section 6). Which rows are shown by
  default follows GE (its bundle hides 25%, 80%, 85%, 99.9% and 99.99% when
  more than seven are present).
- Distribution bucket width: GE's captured run used 3 ms for TCP and TLS and
  42 ms for response time, so it adapts the width to the range. PerfPortal
  derives its own adaptive width from the exact histogram; matching GE's
  choice exactly is not required.
- **The existing host-level telemetry charts** from the Go agent
  (`RunTelemetry`, `TelemetryCharts`) stay for runs that have them and no
  agent file; when both exist, the Java agent's per-run data is what the
  sections draw. The Go agent remains supported and unchanged.
- `CLAUDE.md`'s "OMITTED" sentence and `RunReport.tsx`'s DNS comment are
  updated in the same change that ships the charts.

## 8. Constraints

- Gatling 3.15.1 / `gatling-http-client` 3.15.1 first; every later version
  needs its own verification before the gate admits it.
- The simulation runs as uid 20001 with a stripped environment and no
  credentials (`runnerChildEnv`); the agent writes a local file and never
  talks to the network itself.
- The Gradle plugin's JVM, Java version and OS are the user's.
- Node 22 for every gate; the floors in `CLAUDE.md` move with new suites.
- New partitioned tables need partitions through the same horizon as the
  existing ones, and must join `fk-free-tables.sql`'s list if they carry
  `org_id` without a foreign key.

## 9. How it is proven

1. **Same set.** A checklist built from section 2 and the committed captures:
   every chart, series, legend label, unit and filter, checked on a real
   PerfPortal run.
2. **Correct numbers.** The verifier re-checks every new figure against the
   raw agent file, figure by figure, at exact equality for counts, extremes
   and percentiles. Agent overhead is measured on a real run (CPU, heap,
   throughput) with the agent on and off.
3. **Side-by-side.** The same simulation (`example.BasicSimulation`, which
   targets `api-ecomm.gatling.io`) runs once on GE (about 2 of the account's
   remaining 28 credits) and once through PerfPortal on each path (on-prem
   runner and Gradle plugin). Both reports are recorded chart by chart over the
   DevTools port (the method used for section 2) and compared. They should
   agree in which series exist and in kind and magnitude, not to the digit.

*(The design's call:)* the GE leg of check 3 needs the user: their GE login,
their credits, and their go-ahead at the time. The builder prepares both
PerfPortal legs and the recording, the user starts the GE run in the session,
and the sub-project is not finished until the comparison has been made and
written up. The on-prem leg needs outbound access from the PerfPortal VM to
`api-ecomm.gatling.io`.

REA's passive page inspector works against the debug Chrome; its scenario
recorder failed in this environment (`rea doctor`: Node version and stale
registration), so section 2's recording used a small CDP script. Either is
acceptable for check 3.

## 10. Left to the builder

- Instrumentation library (for example a shaded Byte Buddy) and the exact
  advice points in `gatling-http-client` 3.15.1.
- The agent file's encoding, as long as it is versioned, append-only and
  holds raw events.
- The stream wire shape (section 7.3) and the counter/gauge table design
  (section 7.4).
- How PR boundaries fall. A natural order: agent plus runner path; storage,
  verifier and Report sections; Gradle plugin path; side-by-side proof.
- Whether non-Linux generators fall back to `OperatingSystemMXBean` for CPU
  and RAM.
