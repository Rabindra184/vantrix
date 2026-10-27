# GE report parity PR 4: the Gradle-plugin path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gatling run streamed through the Gradle plugin (`clients/gatling-gradle`) carries the agent's file to PerfPortal, so its Report draws Connections, DNS and Load generators exactly as an on-prem runner run's does.

**Architecture:** The plugin carries the agent jar inside its own jar, extracts it under `build/`, and appends `-javaagent` to `gatlingRun`'s `jvmArgs`. Each simulation JVM writes its own agent file (a new `{jvm}` token in the agent's `out=` path). Before the plugin closes each live run it pairs that run's results directory with its agent file (by the header's `startedAt`) and PUTs the file once to a new `PUT /v1/runs/{id}/agent`, which stores `runs/<runId>/agent.ndjson` and records it on the run as the runner does. The worker's existing reader (`openAgentSource`, PR 2) then builds the figures unchanged. The upload fallback puts the file in the bundle beside `simulation.log`, where the worker already looks.

**Tech Stack:** Java 11 agent (Byte Buddy, Gradle), Kotlin Gradle plugin (shadow, gson, commons-compress, TestKit), NestJS API, Prisma, S3/MinIO.

**Spec:** `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md` §7.2, §7.3, §8, §9, §10, plus these calls approved in chat on 2026-10-27:
- live runs send the agent file ONCE, after the simulation's JVM exits and before the run is closed (not a second offset stream);
- a new API route stores it as `runs/<runId>/agent.ndjson` with sha256 and bytes on `run.agent_log_*`; over the cap it is refused and the run carries on without it;
- the upload fallback puts it beside `simulation.log` in the bundle under `AGENT_BUNDLE_FILE`;
- the plugin keeps every `jvmArgs` entry the user set, and adds nothing when one of them is already our agent;
- the plugin setting to switch the agent off; on by default;
- plugin version 0.2.0 → 0.3.0;
- proof: a real `ParitySimulation` run through the plugin, plus a run with the agent off.

## Global Constraints

- The agent never fails or alters the simulation; the plugin never fails the build (every action body stays inside the existing `try/catch(Throwable)` that logs and swallows); an agent file never fails or changes a run (PR 2's rule).
- Agent bytecode level stays Java 11 (spec §7.1); the Gradle path's JVM, Java version and OS are the user's (spec §8).
- `AGENT_BUNDLE_FILE` = `perfportal-agent.ndjson` (`packages/core/src/agent.ts`), used verbatim for the bundle entry.
- Stored key `runs/<runId>/agent.ndjson`, exactly the runner's (`apps/runner/src/live-sink.ts` `storeAgentLog`).
- Agent cap: API default `MAX_AGENT_LOG_BYTES` = 268435456 (256 MiB, the runner's `DEFAULT_MAX_AGENT_LOG_BYTES`); the plugin tells the agent `max = 268435456 - 1024` (the runner's `AGENT_CAP_HEADROOM_BYTES` rule, so a capped file lands under the cap).
- Token: the existing `stream` scope, bearer only — the same credential `RunTailer` streams with.
- Node 22 for every pnpm command; plugin gate `cd clients/gatling-gradle && ./gradlew build --no-daemon`; agent gate `cd clients/gatling-agent && ./gradlew build --no-daemon`.
- Floors before this branch: unit 278 / 4583, integration 257 / 4072, e2e 213. Predict new totals before running.
- No conditional spreads with object literals (eslint rule); no backticks inside SQL comments.

## Review Focus

1. **Several simulations in one `gatlingRun`.** Upstream `GatlingRunTask.gatlingRun()` runs one `javaexec` per simulation with the same `jvmArgs`, and the agent opens its file with `TRUNCATE_EXISTING`. Each live run must get ITS OWN agent file — never the next simulation's, never a truncated one. Pinned in Task 1 (unique path per JVM) and Task 5 (pairing + a two-directory `RunTailer` case).
2. **A stale agent file from an earlier build.** It must never be paired: the plugin empties its agent output directory at `doFirst`, and pairing ignores any header `startedAt` before the task started. Pinned in Task 5.
3. **The user's own `jvmArgs`.** Kept, in order, with ours appended last; a user's unrelated `-javaagent` stays; ours is not added twice when the task runs again in the same build. Pinned in Task 4.
4. **The server refuses or does not know the route** (older API: 404 on `PUT /v1/runs/{id}/agent`; 409 run not running; 413 over cap; network error). The plugin logs one line and still closes the run. Pinned in Task 5.
5. **No agent file at all** (agent switched off, `runInSameProcess`, a JVM that died before the agent started). The run closes normally with nothing uploaded and the Report reads "not collected". (A Gatling version the agent's gate does not admit still writes a file, with its reason in the header.) Pinned in Task 5.

---

### Task 1: The agent writes one file per JVM

**Files:**
- Modify: `clients/gatling-agent/src/main/java/io/perfportal/agent/AgentOptions.java`
- Test: `clients/gatling-agent/src/test/java/io/perfportal/agent/AgentOptionsTest.java`

**Interfaces:**
- Produces: the `out=` value may contain the literal token `{jvm}`, replaced once at parse time by `<pid>-<epochMillis>` (`ProcessHandle.current().pid()`, `System.currentTimeMillis()`). A path without the token is used exactly as given (the runner's path never carries it).

- [ ] **Step 1: Write the failing tests** in `AgentOptionsTest`:
  - `replacesTheJvmTokenWithPidAndStart`: `parse("out=/tmp/x/agent-{jvm}.ndjson")` → `out().getFileName().toString()` matches `agent-\d+-\d+\.ndjson`, contains no `{`, and the pid part equals `ProcessHandle.current().pid()`.
  - `leavesAPathWithoutTheTokenUnchanged`: `parse("out=/tmp/x/agent.ndjson,max=5")` → `out()` equals `Path.of("/tmp/x/agent.ndjson")`, `maxBytes()` 5.
- [ ] **Step 2: Run** `cd clients/gatling-agent && ./gradlew test --tests '*AgentOptionsTest*' --no-daemon`. Expected: the token case FAILS (path still contains `{jvm}`).
- [ ] **Step 3: Implement** the substitution in `AgentOptions.parse`, before `Path.of(out)`; a failure to read the pid falls back to the millis alone (never disables the agent).
- [ ] **Step 4: Run** the agent gate `./gradlew build --no-daemon`. Expected: exit 0, test count +2 (record it).
- [ ] **Step 5: Commit** `git add clients/gatling-agent && git commit -m "Agent: a {jvm} token makes the output file one per JVM"`

### Task 2: `PUT /v1/runs/{id}/agent` stores a live run's agent file

**Files:**
- Modify: `packages/persistence/src/repositories/run.ts` (beside `recordAgentLog`)
- Modify: `apps/api/src/config.ts` (`maxAgentLogBytes`)
- Modify: `apps/api/src/ingest/live.controller.ts` (new handler), `apps/api/src/ingest/live.service.ts` (new method)
- Modify: `apps/api/src/openapi/document.ts` (operation `uploadRunAgentLog`)
- Modify: `apps/api/test/access-routes.integration.test.ts` (the `@BearerOnly` route map and refusal map)
- Test: `apps/api/test/live-agent.integration.test.ts` (new), `apps/api/test/config.test.ts`

**Interfaces:**
- Consumes: `BlobStore.putStream(key, body: Readable, maxBytes) → { sha256, bytes }`; `readRawUpload` / `assertClientStillConnected` (`apps/api/src/runner/raw-upload.ts`); `runNotFound`, `problem`.
- Produces:
  - `RunRepository.recordLiveAgentLog(scope: TenantScope, runId: string, input: { key: string; sha256: string; bytes: number }): Promise<'recorded' | 'not_found' | 'not_running'>` — a conditional write on `status = 'running'` scoped by org and project, so a run closed meanwhile is never written.
  - `ApiConfig.maxAgentLogBytes: number` from `MAX_AGENT_LOG_BYTES`; blank, non-integer or ≤ 1024 reads as 268435456.
  - Route `PUT /v1/runs/{id}/agent`, `@BearerOnly()`, `@Scopes('stream')`, `@HttpCode(204)` (or `res.status(204)` with `@Res`), raw body, `Content-Type: application/x-ndjson`.
  - Responses: **204** stored; **400** `INVALID_ID` (malformed id), `AGENT_LOG_EMPTY` (zero bytes); **404** `runNotFound(id)` (missing or another project's); **409** `RUN_NOT_RUNNING` (closed or never live — the run is already being processed, so the file can no longer join it); **413** `AGENT_LOG_TOO_LARGE` naming `MAX_AGENT_LOG_BYTES`.
- Order inside the handler: `assertClientStillConnected` → `readRawUpload` into a temp file under `os.tmpdir()` with the cap (its 413 and drain behaviour, never a reset) → empty check → `putStream` from the temp file to `runs/<id>/agent.ndjson` → `recordLiveAgentLog` → map the outcome; the temp file is removed in a `finally`. The object is written before the row (the runner's rule); a 404/409 after the upload leaves an unreferenced object, the cheaper inconsistency. A second PUT before close replaces the object and the row.

- [ ] **Step 1: Write the failing integration cases** in `live-agent.integration.test.ts` (open a live run with a `stream` token through the real API, as `live.integration.test.ts` does):
  - stores the fixture `fixtures/gatling-3.15.1.2/agent-run/agent.ndjson`: 204; the row's `agent_log_key` is `runs/<id>/agent.ndjson`, `agent_log_bytes` equals the fixture's size, `agent_log_sha256` equals its sha256; the stored object's bytes equal the fixture.
  - a second PUT replaces it (row and object carry the second body).
  - 409 `RUN_NOT_RUNNING` after close; 404 for another project's run (a second token); 400 `INVALID_ID` for `not-a-uuid`; 400 `AGENT_LOG_EMPTY` for an empty body; 413 `AGENT_LOG_TOO_LARGE` with the app built on `maxAgentLogBytes: 2048` and a 4 KiB body (both a declared Content-Length and a chunked body).
  - end to end: open, stream the fixture's `simulation.log`, PUT the fixture's agent file, close, process the run in-process (as `fixtures.ts`' `parseUploadedRun` / the live integration cases do), then `GET /v1/runs/{id}/agent` answers `available: true` with the fixture's header host.
  - `config.test.ts`: the three fallback cases for `MAX_AGENT_LOG_BYTES` (blank, `abc`, `1024`) and one honoured value.
- [ ] **Step 2: Run** `pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/live-agent.integration.test.ts`. Expected: FAIL, 404 route not found.
- [ ] **Step 3: Implement** `recordLiveAgentLog`, `maxAgentLogBytes`, `LiveService.storeAgentLog(scope, runId, file): Promise<'recorded' | 'not_found' | 'not_running'>` and the handler, in the order above.
- [ ] **Step 4: Document and register the route.** `document.ts` gains `uploadRunAgentLog` (204, 400 with both codes, 401, 403, 404, 409, 413; `SessionRequired` is NOT used — the route is bearer-only); `access-routes.integration.test.ts`' `@BearerOnly` map and refusal map gain `PUT /v1/runs/:id/agent` with the `[status, code]` a session actually receives. The derived guards (`openapi.integration.test.ts` route coverage, declared-2xx-equals-sent, path-param 400 sweep) must pass without exemptions.
- [ ] **Step 5: Run** the new file, `access-routes`, `openapi` and `config` tests. Expected: PASS.
- [ ] **Step 6: Comment fix.** `apps/worker/src/pipeline/agent-source.ts`'s "A live run's source is the raw log alone, so it never has one" now says a live run's file arrives through `agentLogKey` (option 1), from the runner or this route.
- [ ] **Step 7: Commit** `git commit -m "PUT /v1/runs/{id}/agent stores a live run's agent file"`

### Task 3: The plugin jar carries the agent jar

**Files:**
- Modify: `clients/gatling-gradle/settings.gradle.kts` (`includeBuild("../gatling-agent")`), `clients/gatling-gradle/build.gradle.kts`
- Modify: `clients/gatling-agent/build.gradle.kts` only if the included build needs an outgoing configuration for its shadow jar
- Test: the jar-content check already in `clients/gatling-gradle/build.gradle.kts`, extended

**Interfaces:**
- Produces: resource `dev/vantrix/gradle/agent/gatling-agent.jar` inside the published plugin jar, byte-identical to `clients/gatling-agent`'s `shadowJar` output; plugin `version` default `0.3.0-SNAPSHOT`.

- [ ] **Step 1: Extend the jar-content check** to fail unless the plugin jar holds `dev/vantrix/gradle/agent/gatling-agent.jar` whose own manifest names `Premain-Class: io.perfportal.agent.AgentMain`.
- [ ] **Step 2: Run** `./gradlew build --no-daemon` in `clients/gatling-gradle`. Expected: FAIL at that check.
- [ ] **Step 3: Implement** the included build and a `processResources` dependency that copies the agent's `shadowJar` output to that resource path; NOT relocated or shaded into the plugin's classes (it is a file the user's JVM loads, never a class the plugin loads). Bump the default version.
- [ ] **Step 4: Run** the plugin gate and `clients/gatling-gradle/e2e/run-e2e.sh`'s version derivation (`awk '/^version:/{print $2}'` over `./gradlew properties`). Expected: exit 0, version `0.3.0-SNAPSHOT`. CI's `plugin` and `plugin-consume` jobs build from `clients/gatling-gradle` inside the full checkout, so the included build resolves there; confirm in the PR's CI.
- [ ] **Step 5: Commit** `git commit -m "Plugin jar carries the Gatling agent jar"`

### Task 4: `gatlingRun` starts with the agent

**Files:**
- Create: `clients/gatling-gradle/src/main/kotlin/dev/vantrix/gradle/AgentLauncher.kt`
- Modify: `VantrixExtension.kt` (`var agent: Boolean? = null`), `ResolvedConfig.kt` (`PluginConfig.agentEnabled: Boolean`; extension, then `VANTRIX_AGENT` env, then `true`), `VantrixPlugin.kt` (call from the existing `doFirst`, before the tailer is built)
- Test: `ResolvedConfigTest.kt`, `src/test/kotlin/dev/vantrix/gradle/AgentLauncherTest.kt` (new), `VantrixPluginFunctionalTest.kt`

**Interfaces:**
- Produces: `object AgentLauncher { fun prepare(task: Task, buildDir: Path, logger: (String) -> Unit): AgentRun? }` and `data class AgentRun(val outDir: Path, val notBeforeMs: Long)`. `prepare`:
  - reads and writes `jvmArgs` by reflection (`getJvmArgs(): List<String>?` / `setJvmArgs(List<String>)`, the upstream `io.gatling.gradle.GatlingRunTask` 3.15.1.2 API) — the plugin keeps no compile dependency on Gatling's classes; a task without them gets one warning and `null`;
  - extracts the resource jar to `<buildDir>/vantrix/agent/gatling-agent.jar` (overwritten each time) and empties `<buildDir>/vantrix/agent/out/`;
  - appends `-javaagent:<abs jar>=out=<abs outDir>/agent-{jvm}.ndjson,max=268434432` after the existing list; if any existing entry starts with `-javaagent:` and contains `/vantrix/agent/gatling-agent.jar`, adds nothing (a second `gatlingRun` in one build, or the user wired it themselves) but still returns the `AgentRun`;
  - returns `AgentRun(outDir, notBeforeMs = System.currentTimeMillis())`.
- Called only when `ResolvedConfig.Ok` and `config.agentEnabled`; the result is held in `TailerHandle` and passed to `RunTailer` (Task 5).

- [ ] **Step 1: Write the failing tests.** `ResolvedConfigTest`: default `agentEnabled` true; `ext.agent = false` → false; `VANTRIX_AGENT=false` → false; the extension wins over the env. `AgentLauncherTest` against a plain Kotlin fake task class with `jvmArgs` get/set: user list `["-Xmx2g", "-javaagent:/opt/other.jar"]` becomes those two then ours, in that order; a second `prepare` adds nothing; a null list becomes `[ours]`; a task class without the accessors returns null and logs once; the extracted jar exists and is non-empty; a pre-existing file in `out/` is gone after `prepare`. `VantrixPluginFunctionalTest` (TestKit fake `gatlingRun` task exposing `jvmArgs`, printing them in its action): with config present the printed list ends with our `-javaagent`; with `vantrix { agent = false }` it is unchanged; with no Vantrix URL it is unchanged.
- [ ] **Step 2: Run** `./gradlew test --no-daemon` in `clients/gatling-gradle`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** `AgentLauncher`, the config field and the `doFirst` call.
- [ ] **Step 4: Run** the plugin gate. Expected: exit 0.
- [ ] **Step 5: Commit** `git commit -m "Plugin starts gatlingRun with the agent, keeping the user's jvmArgs"`

### Task 5: Each run takes its own agent file to PerfPortal

**Files:**
- Create: `clients/gatling-gradle/src/main/kotlin/dev/vantrix/gradle/AgentFiles.kt`
- Modify: `LiveClient.kt` (interface and impl), `RunTailer.kt`, `BundleUploader.kt`, `VantrixPlugin.kt` (pass `AgentRun?` to the tailer and the uploader)
- Test: `AgentFilesTest.kt` (new), `LiveClientTest.kt`, `RunTailerTest.kt`, `BundleUploaderTest.kt`

**Interfaces:**
- Consumes: `AgentRun` (Task 4); the route (Task 2).
- Produces:
  - `object AgentFiles { fun pairFor(agent: AgentRun, resultsDir: Path): Path? }` — among `agent.outDir`'s `agent-*.ndjson` files whose first line parses as JSON with `t == "header"` and a numeric `startedAt`, the one with the LARGEST `startedAt` that is `>= agent.notBeforeMs` and `<= resultsDir`'s last-modified time plus 1000 ms; null when none. (A simulation JVM starts, writes its header, then Gatling creates the results directory and writes into it until it exits; the next JVM starts after that — so the largest start not after the directory's last write is that directory's JVM.) An empty or malformed file is skipped.
  - `sealed class AgentUpload { object Stored; data class Refused(val status: Int, val code: String?); data class Failed(val message: String) }` and `LiveApi.uploadAgent(run: OpenedRun, file: Path): AgentUpload` — `PUT {baseUrl}/v1/runs/{runId}/agent`, `Authorization: Bearer`, `Content-Type: application/x-ndjson`, body `BodyPublishers.ofFile(file)`; never throws.
  - `RunTailer(..., agent: AgentRun?)` — REQUIRED, no default (a forgotten argument would drop every run's agent file silently; existing tests pass `null` explicitly): at each of its THREE close sites (`maybeSwitchDirectory`, and both in `finish`) it calls one private `closeRun(state)` that, when `agent != null`, pairs `state.logFile.parent`, uploads if a file is found, logs one line for `Refused`/`Failed` (naming the run id and the status or message), and then closes the run whatever happened.
  - `BundleUploader.upload(config, resultsDir, agent: AgentRun?)`, required for the same reason: when a pair is found, the tar carries `run-1/perfportal-agent.ndjson` beside `run-1/simulation.log`.

- [ ] **Step 1: Write the failing tests.**
  - `AgentFilesTest`: two files with `startedAt` 1000 and 5000 and a directory last modified at 4000 → the 1000 file; directory at 9000 → the 5000 file; a file with `startedAt` below `notBeforeMs` → never chosen; a file whose first line is not a header, and an empty file → skipped; no files → null.
  - `LiveClientTest` (existing stub-server style): request method PUT, path, headers and body bytes; 204 → `Stored`; 404, 409, 413 → `Refused` with status and the problem's `code`; connection refused → `Failed`.
  - `RunTailerTest` (existing fake `LiveApi`): two results directories, each paired with its own agent file → two uploads, each with the matching file, and for each run the upload is recorded BEFORE its close; an upload answering `Refused(404, null)` still closes the run; `agent = null` → no upload calls; a directory with no paired file → close, no upload.
  - `BundleUploaderTest`: with a paired file the tar holds both entries, the agent entry's bytes equal the file; without one, only `simulation.log` (unchanged from today).
- [ ] **Step 2: Run** `./gradlew test --no-daemon`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** `AgentFiles`, `uploadAgent`, `closeRun` and the bundle entry; wire `AgentRun?` from `TailerHandle` into both.
- [ ] **Step 4: Run** the plugin gate. Expected: exit 0; record the test count.
- [ ] **Step 5: Commit** `git commit -m "Plugin sends each run's own agent file before closing it"`

### Task 6: Proof on a real run, docs, gates, CLAUDE.md

**Files:**
- Modify: `clients/gatling-gradle/e2e/run-e2e.sh`, `clients/gatling-gradle/README.md` (the `agent` setting and `VANTRIX_AGENT`, what is collected, one JVM per simulation), `DEPLOYMENT.md` (the API's `MAX_AGENT_LOG_BYTES`, and that the token the plugin uses needs `stream` as before), `CLAUDE.md` (the branch entry, at the top of the entries)

- [ ] **Step 1: e2e script.** After its run completes, assert `GET /v1/runs/{id}/agent` answers `available: true` and a non-null header host; a second invocation with `VANTRIX_AGENT=false` asserts `available: false, reason: 'not_collected'`.
- [ ] **Step 2: Real runs** (the `verify-with-real-gatling-runs` recipe, scratch database `perfportal_pr4`, Redis db 13, bucket `perfportal-pr4`, this tree's API and worker from `dist`): `ParitySimulation` through the plugin live → `complete`, `/agent/status` sums to the run's request count, `/agent/connections` opened/closed equal the file's non-warm-up connects and closes, the run `verified`; one run with the agent off → no `-javaagent` in the JVM, `agent_log_key` null, `/agent` answers `available: false, reason: 'not_collected'`; one multi-simulation `gatlingRun` (two simulations) → two runs, each `/agent` header `startedAt` distinct and each status sum equal to its own request count. Open the Report in a browser on the first run and confirm the three sections draw.
- [ ] **Step 3: Full gates**, each by its own exit code, behind the shared-machine check: `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e --workers=2`, the agent gate and the plugin gate. Integration rises by the new file's cases plus `config` and `access-routes` cases; unit by the `config` cases only; e2e unchanged. Predict, then measure.
- [ ] **Step 4: CLAUDE.md entry** (floors, rulings — one upload not a second stream; pairing by header `startedAt`; one JVM per simulation; 409 after close — a red-verify table, what was run, known and left: `runInSameProcess` collects nothing; a JVM killed mid-run leaves its run incomplete without agent data), then push and open ONE PR to `main`. Do not merge.
