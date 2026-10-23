# GE Report Parity, PR 1: the Gatling agent and the runner path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Gatling run the on-prem runner starts carries a Java agent that records DNS, TCP-connect, TLS, socket, HTTP-status, JVM and Linux machine figures into a raw file, and PerfPortal stores that file with the run.

**Architecture:** A new Gradle project, `clients/gatling-agent`, builds a shaded `-javaagent` jar (Byte Buddy relocated) that instruments `gatling-http-client`/`gatling-http` 3.15.1 at points proven by a spike, plus a 1-second sampler. It writes an append-only NDJSON file. The runner adds the agent to `jvmArgs`, stores the file at `runs/<runId>/agent.ndjson` before closing the run, and records its key, hash and size on the run row. Processing, verification, charts and accepting the file inside an uploaded results bundle are PR 2; the Gradle-plugin path and its opt-out are PR 3; the side-by-side proof is PR 4.

**Tech Stack:** Java (release 11), Byte Buddy, Gradle Kotlin DSL + `com.gradleup.shadow` 8.3.6, JUnit 5; TypeScript (runner, persistence, contracts, API, web); Prisma migration; Docker.

**Spec:** `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md` (sections 7.1–7.3, 8, 9). The spike that proved every hook point is summarised in this plan's "Proven hook points" section; its code is at `/private/tmp/claude-501/-Users-rabindrabiswal-Workspace-perf-dashboard/bfcd3ace-bb98-4c26-95a8-0b9996968d4a/scratchpad/agent-spike/` while that scratch directory exists.

## Global Constraints

- Agent bytecode: `--release 11`. The Gradle-plugin path (PR 3) runs it in the user's JVM.
- Supported versions, exact: `gatling-http-client` 3.15.1 and `gatling-http` 3.15.1. Any other version: no HTTP instrumentation, header says why; JVM and machine figures still collected.
- Byte Buddy is relocated to `io.perfportal.agent.shaded.bytebuddy`. The shipped jar contains no `net/bytebuddy/` entry.
- The agent never fails or alters a simulation: every advice `suppress = Throwable.class`; premain catches `Throwable`; any collector error disables collection for the rest of the run and is written to the file once.
- The agent never touches `io.netty.buffer.ByteBufAllocator.DEFAULT` before the first observed connect (Gatling sets `io.netty.allocator.type=pooled` during startup; touching it earlier picks Netty 4.2's adaptive allocator instead).
- The agent writes only its output file; it never opens a network connection (the simulation runs as uid 20001 with no credentials).
- Output file is NDJSON, UTF-8, one object per line, format `perfportal-agent/1` (Task 1 fixes the line shapes).
- Durations are recorded in integer microseconds (`us`); rounding to ms is PR 2's rule.
- Machine figures are Linux only and whole-machine (`/proc/stat`, `/proc/meminfo`, `/proc/net/snmp`); socket states come from `/proc/net/tcp` and `/proc/net/tcp6`, matched to Gatling's own sockets.
- Agent file object key: `runs/<runId>/agent.ndjson`. Default size cap 256 MiB (`RUNNER_MAX_AGENT_LOG_BYTES`).
- Node 22 for every pnpm gate (`nvm use`). Read each gate's own exit code, never a pipeline's.
- Merge with `--merge`; branch `feat/ge-report-parity` (the design is already committed there).

## Proven hook points (from the spike, Gatling 3.15.1 / Netty 4.2.14, every one observed in a real run)

| Event | Advice target | Data |
|---|---|---|
| DNS | `io.gatling.http.client.resolver.InetAddressNameResolver$1.resolveAll(String, Promise, HttpListener) → Future` and `io.gatling.http.client.resolver.InetAddressNameResolverWrapper.resolveAll` (same descriptor) | arg0 hostname; listener on returned Future: `isSuccess`, `cause()`. Skip IP literals. |
| TCP connect | `io.netty.bootstrap.Bootstrap.connect(SocketAddress, SocketAddress) → ChannelFuture`, only while a ThreadLocal set by `io.gatling.http.client.impl.DefaultHttpClient.openNewChannelRec(List, InetSocketAddress, LocalAddresses, int, Promise, Bootstrap, HttpListener, RequestTimeout)` is set | arg0 `InetSocketAddress`: `getHostString()` + `getAddress()` + port; listener on returned future for OK/KO; `future.channel()` exists at exit |
| Bytes / close | at `Bootstrap.connect` EXIT, `channel.pipeline().addFirst("pp-meter", handler)` — never in a listener (Gatling's listener can write the ClientHello first) | `write` / `channelRead` `readableBytes`; `channelInactive` = close |
| TLS | static `io.gatling.http.client.impl.SslHandlers.newSslHandler(SslContext, ByteBufAllocator, String, int, HttpClientConfig) → SslHandler` | arg2 host, arg3 port; listener on `returned.handshakeFuture()` |
| Status | `io.gatling.http.engine.GatlingHttpListener.onHttpResponse(HttpResponseStatus, HttpHeaders)` | `@Advice.FieldValue("tx")` → `fullRequestName()`; `arg0.code()` |
| Warm-up | `io.gatling.http.engine.HttpEngine.warmUp(HttpComponents)` — blocks until the warm-up answers | a global flag set on enter, cleared on exit; events and channels started while set carry `"warmup":true` |

The `-javaagent` jar is on the system class path, which Gatling and the simulation share, so inlined advice reaches the agent's collector directly; no bootstrap injection.

## Review Focus

1. **A fat-jar simulation built against another Gatling version** (the runner runs fat jars as-is): the agent must record `"http":false` with the versions it found and still produce samples. Pinned in Task 1 (`VersionGateTest`).
2. **The agent jar missing or unreadable on the runner host**: `-javaagent` pointing at a missing file stops the JVM before Gatling starts. The runner must check the jar and run without it, with a job-log warning. Pinned in Task 6.
3. **The output file cannot be written** (directory not writable by uid 20001): Gatling must still run to completion. Pinned in Task 3's end-to-end test.
4. **A simulation that bundles an older Byte Buddy**: relocation must hold. Pinned in Task 4 (jar-entry check) and Task 3 (old Byte Buddy first on the classpath).
5. **Storing the agent file fails** (object store down, file over the cap): the run must still close normally with its statistics. Pinned in Task 6.

---

### Task 1: Agent project, file writer, header and version gate

**Files:**
- Create: `clients/gatling-agent/settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradlew`, `gradlew.bat`, `gradle/wrapper/*` (copy the wrapper files from `clients/gatling-gradle`)
- Create: `clients/gatling-agent/src/main/java/io/perfportal/agent/AgentMain.java`, `AgentOptions.java`, `EventWriter.java`, `VersionGate.java`
- Test: `clients/gatling-agent/src/test/java/io/perfportal/agent/EventWriterTest.java`, `AgentOptionsTest.java`, `VersionGateTest.java`

**Interfaces:**
- Produces:
  - `AgentOptions.parse(String agentArgs) → AgentOptions` with `Path out()`, `long maxBytes()` (default `268_435_456`). Args are `key=value` pairs separated by `,`: `out=<path>,max=<bytes>`. Missing `out` → `AgentOptions.disabled()`.
  - `EventWriter` (thread-safe): `static EventWriter open(Path out, long maxBytes) throws IOException`, `void line(String json)`, `void flush()`, `boolean capped()`, `void close()`. On reaching `maxBytes` it writes one `{"t":"capped","at":<epochMs>}` line and drops every later line.
  - `VersionGate.check(ClassLoader cl) → VersionGate.Result` with `boolean http()`, `String reason()` (null when supported), `String gatlingHttpClient()`, `String gatlingHttp()`; reads `META-INF/maven/io.gatling/gatling-http-client/pom.properties` and `META-INF/maven/io.gatling/gatling-http/pom.properties`. `SUPPORTED = Set.of("3.15.1")`.
  - `AgentMain.premain(String args, Instrumentation inst)`: wraps everything in `catch (Throwable)`; writes the header line first.
  - **The file format `perfportal-agent/1`** (one JSON object per line; `at` = epoch ms, `us` = duration µs, `remote` = `"<hostString>/<ip>:<port>"`):
    - `{"t":"header","format":"perfportal-agent/1","agentVersion":"0.1.0","gatlingHttpClient":"3.15.1","gatlingHttp":"3.15.1","java":"<java.version>","os":"<os.name>","startedAt":<ms>,"collects":{"http":true,"machine":true},"reasons":{}}` — `reasons.http` / `reasons.machine` present when the matching flag is false.
    - `{"t":"dns","at","us","host","ok"[, "warmup":true]}`
    - `{"t":"connect","at","us","remote","ok","ch":<number>[, "warmup":true]}` — `ch` is the agent's own channel id, a JSON number unique within the file (final fix wave: it was `asShortText`, a random 32-bit int that collides within a large run)
    - `{"t":"tls","at","us","remote","ok"[, "ch":<number>][, "warmup":true]}`
    - `{"t":"close","at","ch","remote"}`
    - `{"t":"status","at","req":"<fullRequestName>","code":<int>}`
    - `{"t":"s","at",...}` one sample per second (Task 2 fills it)
    - `{"t":"error","at","where","message"}` at most once, after which collection stops
    - `{"t":"capped","at"}`

- [ ] **Step 1: Write the build.** `build.gradle.kts`: plugins `java`, `com.gradleup.shadow` version `8.3.6`; `java { toolchain/release 11 }` via `tasks.withType<JavaCompile> { options.release.set(11) }`; `implementation("net.bytebuddy:byte-buddy:1.17.6")`; `compileOnly` and `testImplementation` on `io.gatling:gatling-http-client:3.15.1` and `io.gatling:gatling-http:3.15.1`; `testImplementation("io.gatling.highcharts:gatling-charts-highcharts:3.15.1")`, JUnit Jupiter 5.11.x; `shadowJar { archiveClassifier.set(""); archiveFileName.set("gatling-agent.jar"); relocate("net.bytebuddy", "io.perfportal.agent.shaded.bytebuddy"); manifest attributes Premain-Class=io.perfportal.agent.AgentMain, Can-Redefine-Classes=true, Can-Retransform-Classes=true, Multi-Release=true }`; `tasks.build { dependsOn(shadowJar) }`; `tasks.test { dependsOn(shadowJar); systemProperty("agentJar", shadowJar.archiveFile.get().asFile.path) }`.

- [ ] **Step 2: Write the failing tests**

```java
// EventWriterTest
@Test void writesOneLinePerCall() { /* open, line("{\"t\":\"a\"}") twice, close → file has exactly those 2 lines */ }
@Test void capsAndSaysSoOnce() { /* maxBytes = 40; write 10 lines of 10 bytes → file ends with exactly one {"t":"capped" line, total size <= 40 + that line, capped() == true */ }
@Test void concurrentWritersNeverInterleaveLines() { /* 8 threads × 1000 lines; every line parses as JSON */ }
// AgentOptionsTest
@Test void parsesOutAndMax() { assertEquals(Path.of("/w/a.ndjson"), AgentOptions.parse("out=/w/a.ndjson,max=1024").out()); }
@Test void missingOutDisablesTheAgent() { assertTrue(AgentOptions.parse("max=5").isDisabled()); }
// VersionGateTest — a ClassLoader over a temp dir holding fake pom.properties
@Test void admits3151() { assertTrue(VersionGate.check(loaderWith("3.15.1", "3.15.1")).http()); }
@Test void refusesAnotherVersionAndSaysWhich() {
  var r = VersionGate.check(loaderWith("3.16.0", "3.16.0"));
  assertFalse(r.http());
  assertEquals("gatling-http-client 3.16.0 is not supported by agent 0.1.0 (supported: 3.15.1)", r.reason());
}
@Test void missingGatlingOnTheClasspathIsNotSupported() { assertFalse(VersionGate.check(emptyLoader()).http()); }
```

- [ ] **Step 3: Run them and see them fail.** Run: `cd clients/gatling-agent && ./gradlew test --no-daemon`. Expected: compilation failure (classes absent).
- [ ] **Step 4: Implement the four classes.** JSON is built by hand with one escaping helper (`EventWriter.quote(String)`) — no JSON library in the agent.
- [ ] **Step 5: Run the tests.** Same command. Expected: all pass.
- [ ] **Step 6: Commit** `git add clients/gatling-agent && git commit -m "Agent: project, NDJSON writer, header and version gate"`.

### Task 2: The one-second sampler (JVM and Linux machine)

**Files:**
- Create: `clients/gatling-agent/src/main/java/io/perfportal/agent/Sampler.java`, `ProcStat.java`, `ProcMeminfo.java`, `ProcSnmp.java`, `ProcTcp.java`, `NettyMemory.java`, `SocketRegistry.java`
- Test: `.../ProcParsersTest.java`, `SocketRegistryTest.java`, `SamplerTest.java`; fixtures under `src/test/resources/proc/` (real `/proc/stat`, `/proc/meminfo`, `/proc/net/snmp`, `/proc/net/tcp`, `/proc/net/tcp6` captured from a Linux container: `docker run --rm debian:trixie-slim cat /proc/...`)

**Interfaces:**
- Consumes: `EventWriter.line`.
- Produces:
  - `ProcStat.parse(String) → long[]` cumulative `cpu` jiffies in kernel order (user, nice, system, idle, iowait, irq, softirq, steal).
  - `ProcMeminfo.parse(String) → long[]` `{MemTotal kB, MemAvailable kB}`.
  - `ProcSnmp.parseTcp(String) → Map<String, Long>` every field of the `Tcp:` line pair, by its header name.
  - `ProcTcp.parse(String) → List<ProcTcp.Row>` with `int localPort`, `String remoteIpPort` (normalised to the Java `InetAddress.getHostAddress()` + `:port` form, IPv4-mapped tcp6 rows as IPv4), `int state` (hex `st` column).
  - `SocketRegistry`: `void opened(String ch, int localPort, String remote)`, `void closed(String ch, long atMs)`, `Map<String, Map<Integer, Integer>> statesByRemote(List<ProcTcp.Row> rows, long nowMs)` — counts rows whose local port belongs to a tracked socket, keeping closed sockets for 120 s so their TIME_WAIT rows are still counted; also `addBytes(String remote, long out, long in)` and `Map<String, long[]> bytesByRemote()` (cumulative `{out, in}`).
  - `NettyMemory.read(ClassLoader) → long[] {usedDirect, usedHeap}` or `null`; reflective, only after `NettyMemory.arm()` is called (first observed connect).
  - `Sampler.start(EventWriter, SocketRegistry, ClassLoader, boolean linux)` — a daemon thread `perfportal-agent-sampler` at a fixed one-second rate aligned to the wall-clock second.
  - The sample line: `{"t":"s","at":<ms>,"gc":{"<collector name>":[<count>,<timeMs>],...},"heap":[used,committed,max],"netty":[direct,heap]|null,"cpu":[8 jiffies]|absent,"mem":[totalKb,availableKb]|absent,"tcp":{<Tcp fields>}|absent,"bytes":{"<remote>":[out,in]},"states":{"<remote>":{"<st hex as int>":n}}|absent}` — every counter CUMULATIVE (PR 2 differences them), gauges as read.

- [ ] **Step 1: Write the failing tests**

```java
@Test void parsesCpuJiffies() { assertArrayEquals(new long[]{/* fixture's 8 values */}, ProcStat.parse(fixture("stat"))); }
@Test void parsesMemTotalAndAvailable() { assertArrayEquals(new long[]{/* MemTotal */, /* MemAvailable */}, ProcMeminfo.parse(fixture("meminfo"))); }
@Test void parsesTcpCounters() { var t = ProcSnmp.parseTcp(fixture("snmp")); assertTrue(t.containsKey("ActiveOpens") && t.containsKey("RetransSegs") && t.containsKey("AttemptFails")); }
@Test void parsesTcp4AndMappedTcp6Rows() { /* a fixture row 0100007F:1F90 and a tcp6 ::ffff:127.0.0.1 row both yield remoteIpPort "127.0.0.1:8080" */ }
@Test void countsOnlyGatlingsOwnSockets() { /* registry tracks local port 50000; rows for 50000 (ESTABLISHED) and 50001 (untracked) → only 50000 counted, under its remote, state 1 */ }
@Test void keepsAClosedSocketsTimeWaitFor120Seconds() { /* closed at t; row for its port in state 6 counted at t+119s, not at t+121s */ }
@Test void nettyIsNotTouchedBeforeArm() { /* NettyMemory.read before arm() returns null and loads no io.netty.buffer class (check via a fresh ClassLoader) */ }
@Test void emitsOneSampleLinePerSecondWithCumulativeGc() { /* run Sampler for ~2.5 s against a temp file; ≥2 "s" lines; gc map non-empty; heap has 3 values; on non-Linux cpu/mem/tcp/states absent */ }
```

- [ ] **Step 2: Run them and see them fail.** `./gradlew test --no-daemon` — fails to compile.
- [ ] **Step 3: Implement the parsers, registry, Netty reader and sampler.** GC from `ManagementFactory.getGarbageCollectorMXBeans()`; heap from `ManagementFactory.getMemoryMXBean().getHeapMemoryUsage()`; Netty via `Class.forName("io.netty.buffer.ByteBufAllocator", false, cl)` → `DEFAULT` → `metric()` → `usedDirectMemory()`/`usedHeapMemory()`. `linux` is `os.name` starting with `Linux` and `/proc/self` existing.
- [ ] **Step 4: Run the tests.** Expected: pass (Linux-only assertions skip via `assumeTrue` on non-Linux).
- [ ] **Step 5: Commit** `git commit -m "Agent: one-second JVM and Linux machine sampler"`.

### Task 3: The instrumentation, proven against a real Gatling run

**Files:**
- Create: `.../agent/Instrumentation.java` (builds the `AgentBuilder`), `Advices.java` (all `@Advice` classes), `Collector.java` (static entry points the advice calls), `MeterHandler.java` (the `ChannelDuplexHandler`), `WarmUp.java` (the global flag)
- Modify: `AgentMain.java` (install instrumentation when `VersionGate` admits; start the sampler always)
- Test: `.../agent/GatlingRunE2ETest.java`; test simulation `src/test/java/probe/ProbeSimulation.java` (Gatling Java DSL); a local HTTP + HTTPS target started by the test (`com.sun.net.httpserver.HttpServer` / `HttpsServer` with a self-signed key generated in the test)

**Interfaces:**
- Consumes: the hook table above; `EventWriter`, `SocketRegistry`, `NettyMemory.arm()`.
- Produces: `Collector.dns(String host, long startNanos, boolean ok)`, `Collector.connect(InetSocketAddress remote, Channel ch, long startNanos, boolean ok)`, `Collector.tls(String host, int port, long startNanos, boolean ok)`, `Collector.close(Channel ch)`, `Collector.bytes(Channel ch, long out, long in)`, `Collector.status(String requestName, int code)`; `WarmUp.active()`. The `AgentBuilder` ignores everything except `io.gatling.http.` and `io.netty.bootstrap.Bootstrap` (`ignore(not(nameStartsWith("io.gatling.http.").or(named("io.netty.bootstrap.Bootstrap"))))`), which the spike measured as the cheaper matcher.

- [ ] **Step 1: Write the failing end-to-end test.** It builds the command the runner builds (`java <runner --add-opens set> -javaagent:<agentJar>=out=<tmp>/agent.ndjson -cp <test runtime classpath> io.gatling.app.Gatling -s probe.ProbeSimulation -rf <tmp>/results --no-reports`), with `ProbeSimulation` sending 30 users × 3 requests: two to `http://localhost:<port>` (200 and 404), one to `https://localhost:<tlsPort>` (200), and `.warmUp("http://localhost:<port>/warm")`. Then:

```java
assertEquals(0, exit);
var lines = readNdjson(tmp.resolve("agent.ndjson"));
assertEquals("perfportal-agent/1", lines.get(0).get("format"));
assertEquals(requestCountFromSimulationLog(tmp.resolve("results")), count(lines, "status"));      // every request has a status line
assertEquals(Map.of(200, 60L, 404, 30L), statusCodes(lines));
assertTrue(count(lines, "connect", nonWarmup()) > 0);
assertEquals(count(lines, "connect", ok()), count(lines, "close"));                               // every opened channel closed
assertTrue(count(lines, "tls", ok(), nonWarmup()) > 0);
assertTrue(count(lines, "connect", warmup()) >= 1);                                               // the warm-up channel is tagged
assertEquals(0, count(lines, "dns", hostIs("127.0.0.1")));                                         // IP literals are not DNS
assertTrue(count(lines, "s") >= 1);
assertEquals(0, count(lines, "error"));
```

Two further cases in the same file:
- `unwritableOutputStillRunsTheSimulation`: `out=` points into a directory made read-only → exit code 0 and `simulation.log` present.
- `relocationSurvivesAnOldByteBuddyOnTheClasspath`: prepend `net.bytebuddy:byte-buddy:1.10.22` (a `testRuntimeOnly` dependency resolved into a separate configuration) to `-cp` → status count still equals the request count, and no `error` line.

- [ ] **Step 2: Run it and see it fail.** `./gradlew test --tests '*GatlingRunE2ETest*' --no-daemon` — fails (no instrumentation, no status lines).
- [ ] **Step 3: Implement** `Advices`, `Collector`, `MeterHandler`, `WarmUp`, `Instrumentation`; every advice `@Advice.OnMethodExit(suppress = Throwable.class)` / `OnMethodEnter(suppress = ...)`; the first exception inside `Collector` writes one `error` line and sets a flag that makes every later call a no-op.
- [ ] **Step 4: Run the whole agent suite.** `./gradlew build --no-daemon`. Expected: BUILD SUCCESSFUL, all tests pass.
- [ ] **Step 5: Red-verify the warm-up tagging and the meter placement**, one mutation at a time, restoring after each: never set `WarmUp` → the warm-up assertion fails; add the meter in a connect listener instead of at exit → the TLS connect's first bytes are missed (bytes for the TLS remote fall below the handshake's size — assert `bytes > 0` for it in the test first). Record which assertion failed.
- [ ] **Step 6: Commit** `git commit -m "Agent: instrument DNS, connect, TLS, bytes, status and warm-up"`.

### Task 4: Build it into the image and CI

**Files:**
- Modify: `infra/Dockerfile` (new JDK stage `gatling-agent`, beside `gatling-method`), `.github/workflows/ci.yml` (new job `gatling-agent`; a smoke step in the `compose` job)
- Create: `infra/test/agent-jar-smoke.sh`

**Interfaces:**
- Produces: the jar at `/opt/perfportal/gatling-agent.jar` (mode `a+r`) in the runtime image, and `ENV RUNNER_AGENT_JAR=/opt/perfportal/gatling-agent.jar`.

- [ ] **Step 1: Write the smoke script** `infra/test/agent-jar-smoke.sh <jar>`: (a) `unzip -l` the jar and fail if any entry starts with `net/bytebuddy/`; (b) run `java -javaagent:<jar>=out=/tmp/a.ndjson -version`, then require line 1 of `/tmp/a.ndjson` to contain `"format":"perfportal-agent/1"` and `"http":false` (no Gatling on that classpath) — so a jar whose premain never ran fails the build.
- [ ] **Step 2: Add the Dockerfile stage** `FROM runtime AS gatling-agent`, install `openjdk-21-jdk-headless`, `COPY clients/gatling-agent /src/gatling-agent`, `RUN ./gradlew shadowJar --no-daemon`, run the smoke script on the built jar; in the final stage `COPY --from=gatling-agent /src/gatling-agent/build/libs/gatling-agent.jar /opt/perfportal/gatling-agent.jar` and set `RUNNER_AGENT_JAR`.
- [ ] **Step 3: Add the CI job** `gatling-agent`, modelled on the `plugin` job (setup-java 21, `working-directory: clients/gatling-agent`, `./gradlew build --no-daemon`), and in the `compose` job run `infra/test/agent-jar-smoke.sh /opt/perfportal/gatling-agent.jar` inside the built image.
- [ ] **Step 4: Verify locally.** `docker build -f infra/Dockerfile -t perfportal-agent-check .` exits 0, and `docker run --rm perfportal-agent-check bash /app/infra/test/agent-jar-smoke.sh /opt/perfportal/gatling-agent.jar` exits 0. Red-verify (a) by building the jar without `relocate(...)`: the script fails naming a `net/bytebuddy/` entry.
- [ ] **Step 5: Commit** `git commit -m "Ship the Gatling agent in the image and build it in CI"`.

### Task 5: Persistence, contract and API: the run's agent file and the job's opt-out

**Files:**
- Create: `packages/persistence/prisma/migrations/20261023120000_run_agent_log/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (`Run`, `RunnerJob`), `packages/persistence/src/repositories/run.ts`, `packages/persistence/src/repositories/runner.ts` (`createQueued`, `retry`, the job SELECTs), `packages/contracts/src/runner.ts`, `apps/api/src/runner/runner.controller.ts`
- Test: `packages/persistence/test/run-agent-log.integration.test.ts` (new), `packages/persistence/test/runner.integration.test.ts`, `packages/contracts/test/runner.test.ts` (or the file holding `RunnerJobRequest` cases), `apps/api/test/runner.integration.test.ts`

**Interfaces:**
- Produces:
  - Columns: `run.agent_log_key text NULL`, `run.agent_log_sha256 text NULL`, `run.agent_log_bytes bigint NULL`; `runner_job.agent_enabled boolean NOT NULL DEFAULT true`.
  - `RunRecord` gains `agentLogKey: string | null`, `agentLogSha256: string | null`, `agentLogBytes: number | null`.
  - `RunRepository.recordAgentLog(runId: string, input: { key: string; sha256: string; bytes: number }): Promise<void>`.
  - `RunnerJobRecord` gains `agentEnabled: boolean`; `createQueued` input job gains `agentEnabled: boolean` (required — no default, so every caller states it).
  - Contract: `RunnerJobRequest` (and the multipart metadata schema beside it) gains `agentEnabled: z.boolean().default(true)`; the job response gains `agentEnabled: z.boolean()`.

- [ ] **Step 1: Write the failing tests.** Persistence: `recordAgentLog` then `findById` returns the three fields; a run never given one returns three nulls. Runner repository: the existing retry case that compares the whole carried field set gains `agentEnabled` and is given a job created with `agentEnabled: false` — the retry must carry `false` (the `test_slug` lesson: retry is an `INSERT..SELECT` and a missing column silently resets). Contract: `agentEnabled` defaults to `true` when absent and keeps `false`. API: `POST /v1/projects/:slug/runner/runs` with `agentEnabled: false` returns a job with `agentEnabled: false`.
- [ ] **Step 2: Run them and see them fail.** `pnpm test:integration -- packages/persistence/test/run-agent-log.integration.test.ts` (scratch database per this file's rules) and `pnpm test:unit -- packages/contracts`. Expected: failures on the missing fields.
- [ ] **Step 3: Write the migration and model changes; implement the repository method and field plumbing.** `prisma generate`, then `pnpm build`.
- [ ] **Step 4: Run the tests.** Expected: pass. Then `pnpm typecheck` exit 0 — `createQueued`'s required `agentEnabled` makes every caller compile-checked.
- [ ] **Step 5: Commit** `git commit -m "Store a run's agent file reference and a job's agent opt-out"`.

### Task 6: The runner adds the agent and stores its file

**Files:**
- Modify: `apps/runner/src/config.ts`, `apps/runner/src/artifact.ts`, `apps/runner/src/executor.ts`, `apps/runner/src/live-sink.ts`
- Test: `apps/runner/test/artifact.test.ts`, `apps/runner/test/executor-events.test.ts` (or the executor test file holding the spawn harness), `apps/runner/test/config.test.ts`

**Interfaces:**
- Consumes: `RunRepository.recordAgentLog`, `RunnerJobRecord.agentEnabled`, `BlobStore.put`.
- Produces:
  - `RunnerConfig.agentJar: string | null` (`RUNNER_AGENT_JAR`, empty → null) and `RunnerConfig.maxAgentLogBytes: number` (`RUNNER_MAX_AGENT_LOG_BYTES`, default `268_435_456`).
  - `prepareGatlingRun(config, job, artifact, shouldStop, agent: { jar: string } | null)` — the new parameter is required. When non-null, `jvmArgs` begins with `-javaagent:<jar>=out=<workDir>/perfportal-agent.ndjson,max=<maxAgentLogBytes>`; `PreparedGatlingRun` gains `agentLogPath: string | null`.
  - `RunnerLiveSink.storeAgentLog(path: string): Promise<'stored' | 'absent' | 'too_large' | 'failed'>` — puts the bytes at `runs/<runId>/agent.ndjson`, then `recordAgentLog`; NEVER throws.
  - Executor rule: the agent is used when `config.agentJar !== null`, the jar is readable (`fs.access(R_OK)`), and `job.agentEnabled`. An unreadable jar → job-log warning `Gatling agent jar not readable at <path>; running without connection, DNS and JVM data.` and `agent: null`. `storeAgentLog` runs after Gatling exits and before both `sink.close()` and `sink.closeAbandoned()`; never on a cancelled run.

- [ ] **Step 1: Write the failing tests.**

```ts
it('puts the agent first in the JVM arguments, pointing at the job\'s own file', async () => {
  const p = await prepareGatlingRun(cfg, job, jarArtifact, never, { jar: '/opt/perfportal/gatling-agent.jar' });
  expect(p.command.args[0]).toBe(`-javaagent:/opt/perfportal/gatling-agent.jar=out=${p.workDir}/perfportal-agent.ndjson,max=268435456`);
  expect(p.agentLogPath).toBe(`${p.workDir}/perfportal-agent.ndjson`);
});
it('adds no agent when given none', async () => { /* agent null → no arg starts with -javaagent, agentLogPath null */ });
it('runs without the agent when its jar cannot be read, and says so', async () => { /* config.agentJar = '/nope.jar' → spawned args carry no -javaagent; job log contains the warning */ });
it('runs without the agent when the job opted out', async () => { /* job.agentEnabled false → no -javaagent */ });
it('stores the agent file before closing the run', async () => { /* call order: blobs.put('runs/<id>/agent.ndjson') then recordAgentLog then close */ });
it('closes the run normally when storing the agent file fails', async () => { /* blobs.put rejects → run closed, job complete, job log warns */ });
it('stores the agent file of a Gatling that died part-way before closing it as abandoned', async () => { /* exit 143 path: put then closeAbandoned */ });
it('does not store an agent file larger than the cap', async () => { /* file of cap+1 bytes → 'too_large', no put, run closed */ });
```

- [ ] **Step 2: Run them and see them fail.** `pnpm test:unit -- apps/runner`. Expected: failures on the missing parameter and behaviour.
- [ ] **Step 3: Implement.** The child must be able to create the file: it lives in `workDir`, which `makeChildWritable()` already opens to uid 20001.
- [ ] **Step 4: Run the runner tests and `pnpm typecheck`.** Expected: pass, exit 0.
- [ ] **Step 5: Commit** `git commit -m "Runner: load the Gatling agent and store its file with the run"`.

### Task 7: Retention and the orphan sweep know the agent file

**Files:**
- Modify: `packages/persistence/src/repositories/verification.ts` (`RetentionPage.runs` gains `agentLogKey: string | null`; the retention SELECT returns `agent_log_key`), `apps/worker/src/sweeper.ts` (`#retainOne` deletes the agent file before `markRawLogDeleted`), `infra/clean-orphaned-objects.mjs` (keep-list includes every non-null `run.agent_log_key`), `infra/test/orphans-fixture.mjs`
- Test: `apps/worker/test/` retention integration case (the file that covers `#retainOne`), the orphans fixture assertions

**Interfaces:**
- Consumes: `run.agent_log_key` (Task 5).

- [ ] **Step 1: Write the failing tests.** Retention: a run past retention with both a bundle and an agent file → both objects gone and `raw_log_deleted_at` set. Orphans fixture: seed a run whose `agent_log_key` object exists → the sweep keeps it; an `runs/<uuid>/agent.ndjson` object with no row → removed.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them** (worker integration file on a scratch database; the orphans fixture as CI's `test-residue` job runs it, replayed locally). Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "Retention and the orphan sweep cover the agent file"`.

### Task 8: The opt-out on the New on-prem run form

**Files:**
- Modify: `apps/web/src/routes/NewRunnerRun.tsx`
- Test: `apps/web/test/NewRunnerRun.test.tsx`

**Interfaces:**
- Consumes: `RunnerJobRequest.agentEnabled`.

- [ ] **Step 1: Write the failing tests.** In the Advanced group, a checkbox labelled `Collect connection, DNS and JVM data`, checked by default; submitting with it unchecked sends `agentEnabled: false` in the serialised payload; checked sends `agentEnabled: true`.
- [ ] **Step 2: Run them and see them fail.** `pnpm test:unit -- apps/web/test/NewRunnerRun.test.tsx`.
- [ ] **Step 3: Implement** — a named key in the payload literal, never a conditional spread (the lint rule refuses one).
- [ ] **Step 4: Run the file and `pnpm lint`.** Expected: pass, exit 0.
- [ ] **Step 5: Commit** `git commit -m "New on-prem run: opt out of the Gatling agent"`.

### Task 9: A real run, the gates, and the record

**Files:**
- Modify: `CLAUDE.md` (a new entry at the top of Verification, and the floors)

- [ ] **Step 1: Run the real path.** On a scratch database and Redis index, start the API, worker and runner from this branch with `RUNNER_AGENT_JAR` set to the built jar and Java 21, and queue `ParitySimulation` through the on-prem runner (the `verify-with-real-gatling-runs` recipe). Then: the run's `agent_log_key` is `runs/<runId>/agent.ndjson`; its object's sha256 equals `agent_log_sha256`; line 1 is the header with `"http":true`; the count of `status` lines equals the run's request count (895 for ParitySimulation); every `connect` with `ok:true` has a `close`; there is at least one sample line per second of the run. Run the same simulation with `agentEnabled: false` → `agent_log_key` null and no `-javaagent` in the job log's command line.
- [ ] **Step 2: Measure overhead.** Gatling process CPU (user+sys) and wall time with and without the agent on that run; record both.
- [ ] **Step 3: Run every gate,** each total predicted first: `pnpm build`, `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e --workers=2`; `cd clients/gatling-agent && ./gradlew build --no-daemon`; the image build plus smoke script.
- [ ] **Step 4: Write the CLAUDE.md entry** (what was built, the proven hook points, what each red-verify showed, the real run's figures and overhead, the new floors) and commit `git commit -m "CLAUDE.md: record PR 1 of GE report parity and its floors"`.
