# Gatling Gradle live-streaming plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gradle plugin that opens a PerfPortal live run when `gatlingRun` starts, streams `simulation.log` as Gatling writes it, and closes the run when the task ends — so the five-tab live page shows the run while it happens and the finished report when it ends.

**Architecture:** A new JVM/Kotlin artifact at `clients/gatling-gradle/`, outside the pnpm workspace (the same split `agent/` has). The plugin attaches to any task named `gatlingRun` via `tasks.matching {}` — it never touches `io.gatling.gradle` internals — starts a daemon tailer thread in `doFirst`, and closes through a finalizer task, which Gradle runs **even when the finalized task fails**. All HTTP is `java.net.http.HttpClient` against the three live endpoints; JSON via Gson.

**Tech Stack:** Kotlin 2.0.21, `java-gradle-plugin` + `maven-publish`, Gradle wrapper 8.14, JVM toolchain 21 (Gatling 3.15's own floor), Gson 2.11.0 (sole runtime dep), JUnit 5 + Gradle TestKit, `com.sun.net.httpserver` for fake-server tests.

**Spec:** `docs/superpowers/specs/2026-08-20-gatling-gradle-live-streaming-design.md`

## Global Constraints

- **Never fail the build.** Every plugin error path ends in a logged warning (carrying the API's own `remediation` where one exists) and an untouched `gatlingRun`. A throw that escapes to Gradle is a Critical defect.
- **The token is `PERFPORTAL_TOKEN` and nothing else.** Never a DSL property, never a flag. Sent as `Authorization: Bearer <token>`.
- **Reads are capped at 4 MiB per tick** (`4 * 1024 * 1024`) — half the server's 8 MiB `MAX_STREAM_CHUNK_BYTES`, so 413 is a bug, not a routine condition.
- **Wire contract, verbatim from the server:** `POST /v1/runs/live` → 201 `{runId, streamUrl, nextOffset}` where `streamUrl` is RELATIVE (`/v1/runs/{id}/stream`); `POST {streamUrl}` with raw bytes + `X-Stream-Offset` header → 202 `{nextOffset}` (advance), 409 problem+json with top-level `nextOffset` (resume from it — a replay also answers 202, never an error); `POST /v1/runs/{id}/close` → 2xx (done) or 409 `RUN_NOT_RUNNING` (already closed — treat as done).
- **Metadata is passed, never inferred.** No shelling out to `git`. Absent is better than wrong.
- **No coupling to Gatling internals:** the plugin watches `build/reports/gatling/` and drives our HTTP contract; it must keep working if `io.gatling.gradle` is upgraded — or absent (TestKit fakes `gatlingRun` with a plain task).
- **One PerfPortal run per simulation.** A new results directory appearing while one is being tailed means the previous simulation ended: final-flush + close it, open the next.
- **Ship partial blocks.** Gatling flushes in 8 KiB blocks (measured, spec §1); the tailer POSTs whatever bytes exist each tick. `StreamingLogDecoder` server-side already retains partial records.
- **This directory is invisible to every `pnpm` gate.** Its gate is `cd clients/gatling-gradle && ./gradlew build` (build runs test). CLAUDE.md gains that line in Task 8.
- Locked naming: plugin id `dev.perfportal.gatling`, group `dev.perfportal`, artifact `gatling-gradle-plugin`, version `0.1.0-SNAPSHOT`, package `dev.perfportal.gradle`.

## Dependency order

```
1 (toolchain+publish) ─> 2 (config) ─> 3 (HTTP client) ─> 4 (tailer) ─> 5 (wiring) ─> 6 (fallback) ─> 7 (e2e) ─> 8 (docs)
```

---

### Task 1: Toolchain skeleton that builds, tests and publishes

**Files:**
- Create: `clients/gatling-gradle/settings.gradle.kts`, `clients/gatling-gradle/build.gradle.kts`, `clients/gatling-gradle/gradle.properties`, `clients/gatling-gradle/src/main/kotlin/dev/perfportal/gradle/PerfportalPlugin.kt`, `clients/gatling-gradle/src/test/kotlin/dev/perfportal/gradle/PluginSmokeTest.kt`, wrapper files via `gradle wrapper`
- Modify: `.github/workflows/ci.yml` (new `plugin` job beside the `agent` job)

**Interfaces:**
- Produces: an applyable plugin id `dev.perfportal.gatling`; `./gradlew build` and `./gradlew publishToMavenLocal` green; CI job `plugin` running both; publish to GitHub Packages on pushes to `main` using `GITHUB_TOKEN` (no new secret — same-repo Packages accepts it).

- [ ] **Step 1: Scaffold the build**

`clients/gatling-gradle/settings.gradle.kts`:
```kotlin
rootProject.name = "gatling-gradle-plugin"
```

`clients/gatling-gradle/build.gradle.kts`:
```kotlin
plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.0.21"
}

group = "dev.perfportal"
version = "0.1.0-SNAPSHOT"

kotlin { jvmToolchain(21) }

repositories { mavenCentral() }

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation(gradleTestKit())
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

gradlePlugin {
    plugins {
        create("perfportal") {
            id = "dev.perfportal.gatling"
            implementationClass = "dev.perfportal.gradle.PerfportalPlugin"
        }
    }
}

tasks.test { useJUnitPlatform() }

publishing {
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/Rabindra184/vantrix")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: ""
                password = System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}
```

`PerfportalPlugin.kt` (walking skeleton — Task 5 fills it):
```kotlin
package dev.perfportal.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project

class PerfportalPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.logger.info("perfportal: plugin applied")
    }
}
```

`PluginSmokeTest.kt`:
```kotlin
package dev.perfportal.gradle

import org.gradle.testfixtures.ProjectBuilder
import org.junit.jupiter.api.Test
import kotlin.test.assertNotNull

class PluginSmokeTest {
    @Test fun `plugin applies by id`() {
        val project = ProjectBuilder.builder().build()
        project.pluginManager.apply("dev.perfportal.gatling")
        assertNotNull(project.plugins.findPlugin(PerfportalPlugin::class.java))
    }
}
```

Add `kotlin("test")` to test deps if `kotlin.test` asserts are used: `testImplementation(kotlin("test"))`.

- [ ] **Step 2: Generate the wrapper and build**

```bash
cd clients/gatling-gradle && gradle wrapper --gradle-version 8.14 && ./gradlew build
```
Expected: BUILD SUCCESSFUL, 1 test passing. Commit the wrapper jar — it is how CI and users build without a system Gradle.

- [ ] **Step 3: CI job**

In `.github/workflows/ci.yml`, beside the `agent` job (mirror its comment style — it explains why the module is outside the workspace):
```yaml
  plugin:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: clients/gatling-gradle
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - run: ./gradlew build --no-daemon
      - name: Publish snapshot to GitHub Packages
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_ACTOR: ${{ github.actor }}
        run: ./gradlew publish --no-daemon
```
Also add `permissions: packages: write` at the workflow level if absent (check first; add the narrowest scope that works).

- [ ] **Step 4: Verify local publish**

```bash
cd clients/gatling-gradle && ./gradlew publishToMavenLocal && ls ~/.m2/repository/dev/perfportal/gatling-gradle-plugin/0.1.0-SNAPSHOT/
```
Expected: a `.jar`, a `.pom`, and the plugin-marker artifact under `~/.m2/repository/dev/perfportal/gatling/`.

- [ ] **Step 5: Commit**

```bash
git add clients/gatling-gradle .github/workflows/ci.yml
git commit -m "build(plugin): a Gradle plugin skeleton that builds, tests and publishes

Sequenced first, before a byte of streaming logic, because the agent's own
design named a distribution story as required and never got one: agent/dist
is git-ignored and no workflow publishes it. A plugin nobody can
plugins{id()} is exactly as useless as a binary nobody can install."
```

---

### Task 2: Configuration extension and env fallback

**Files:**
- Create: `clients/gatling-gradle/src/main/kotlin/dev/perfportal/gradle/PerfportalExtension.kt`, `.../ResolvedConfig.kt`
- Test: `clients/gatling-gradle/src/test/kotlin/dev/perfportal/gradle/ResolvedConfigTest.kt`

**Interfaces:**
- Produces: `PerfportalExtension` (DSL block `perfportal { }`) with `url`, `environment`, `branch`, `commitSha`, `tickSeconds` (default 5), `uploadIfLiveUnavailable` (default false), `resultsDir`; and `ResolvedConfig.from(ext, env: Map<String,String>): ResolvedConfig?` — pure, testable, returns null (with a reason string in `ResolvedConfig.Problem`) when no URL or no token. Token read ONLY from `env["PERFPORTAL_TOKEN"]`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package dev.perfportal.gradle

import org.junit.jupiter.api.Test
import kotlin.test.*

class ResolvedConfigTest {
    private fun ext() = PerfportalExtension()

    @Test fun `DSL value wins over env`() {
        val e = ext().apply { url = "https://dsl.example" }
        val r = ResolvedConfig.from(e, mapOf("PERFPORTAL_URL" to "https://env.example",
                                             "PERFPORTAL_TOKEN" to "pp_x_y"))
        assertEquals("https://dsl.example", (r as ResolvedConfig.Ok).config.baseUrl)
    }

    @Test fun `env fills what the DSL leaves unset`() {
        val r = ResolvedConfig.from(ext(), mapOf("PERFPORTAL_URL" to "https://env.example",
                                                 "PERFPORTAL_ENVIRONMENT" to "staging",
                                                 "PERFPORTAL_TOKEN" to "pp_x_y"))
        val c = (r as ResolvedConfig.Ok).config
        assertEquals("staging", c.environment)
    }

    @Test fun `token comes from env only -- there is no DSL property to set`() {
        // Compile-time property absence is the real guard; this pins the runtime half.
        val r = ResolvedConfig.from(ext().apply { url = "https://x.example" }, emptyMap())
        assertTrue(r is ResolvedConfig.Missing && "PERFPORTAL_TOKEN" in r.reason)
    }

    @Test fun `no url is a stated reason, not a crash`() {
        val r = ResolvedConfig.from(ext(), mapOf("PERFPORTAL_TOKEN" to "pp_x_y"))
        assertTrue(r is ResolvedConfig.Missing && "PERFPORTAL_URL" in r.reason)
    }

    @Test fun `defaults -- tick 5, upload fallback off`() {
        val c = (ResolvedConfig.from(ext().apply { url = "https://x.example" },
                 mapOf("PERFPORTAL_TOKEN" to "t")) as ResolvedConfig.Ok).config
        assertEquals(5, c.tickSeconds)
        assertFalse(c.uploadIfLiveUnavailable)
    }

    @Test fun `trailing slash on url is normalised away`() {
        val c = (ResolvedConfig.from(ext().apply { url = "https://x.example/" },
                 mapOf("PERFPORTAL_TOKEN" to "t")) as ResolvedConfig.Ok).config
        assertEquals("https://x.example", c.baseUrl)
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./gradlew test` → compile error, classes absent.

- [ ] **Step 3: Implement**

```kotlin
package dev.perfportal.gradle

open class PerfportalExtension {
    var url: String? = null
    var environment: String? = null
    var branch: String? = null
    var commitSha: String? = null
    var tickSeconds: Int? = null
    var uploadIfLiveUnavailable: Boolean? = null
    var resultsDir: String? = null   // default applied at wiring time: build/reports/gatling
}

data class PluginConfig(
    val baseUrl: String, val token: String,
    val environment: String?, val branch: String?, val commitSha: String?,
    val tickSeconds: Int, val uploadIfLiveUnavailable: Boolean, val resultsDir: String?,
)

sealed class ResolvedConfig {
    data class Ok(val config: PluginConfig) : ResolvedConfig()
    data class Missing(val reason: String) : ResolvedConfig()

    companion object {
        fun from(ext: PerfportalExtension, env: Map<String, String>): ResolvedConfig {
            val url = (ext.url ?: env["PERFPORTAL_URL"])?.trimEnd('/')
                ?: return Missing("no PerfPortal URL: set perfportal.url or PERFPORTAL_URL")
            val token = env["PERFPORTAL_TOKEN"]
                ?: return Missing("no token: set PERFPORTAL_TOKEN (never a build-file value)")
            return Ok(PluginConfig(
                baseUrl = url, token = token,
                environment = ext.environment ?: env["PERFPORTAL_ENVIRONMENT"],
                branch = ext.branch ?: env["PERFPORTAL_BRANCH"],
                commitSha = ext.commitSha ?: env["PERFPORTAL_COMMIT_SHA"],
                tickSeconds = ext.tickSeconds ?: env["PERFPORTAL_TICK_SECONDS"]?.toIntOrNull() ?: 5,
                uploadIfLiveUnavailable = ext.uploadIfLiveUnavailable
                    ?: env["PERFPORTAL_UPLOAD_IF_LIVE_UNAVAILABLE"]?.toBoolean() ?: false,
                resultsDir = ext.resultsDir,
            ))
        }
    }
}
```

- [ ] **Step 4: Run to verify pass** — `./gradlew test` → all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): perfportal{} config with env fallback; token only ever from PERFPORTAL_TOKEN"`

---

### Task 3: The HTTP client — open, stream, close

**Files:**
- Create: `.../LiveClient.kt`
- Test: `.../LiveClientTest.kt` (fake server via `com.sun.net.httpserver.HttpServer`)

**Interfaces:**
- Produces:
  - `class LiveClient(config: PluginConfig, logger: (String) -> Unit)`
  - `fun open(idempotencyKey: String): OpenedRun?` — null on any failure (already logged)
  - `data class OpenedRun(val runId: String, val streamUrl: String /*absolute*/, var nextOffset: Long)`
  - `fun stream(run: OpenedRun, bytes: ByteArray): StreamResult` — `Advanced(nextOffset)`, `Resume(nextOffset)` (the 409 path), `AuthFailed`, `GaveUp`
  - `fun close(run: OpenedRun): Boolean` — true on 2xx or 409 `RUN_NOT_RUNNING`
- Retry policy inside `stream`: 3 attempts, 1s/2s/4s backoff on IOException/5xx; **no retry** on 401/403.

- [ ] **Step 1: Write the failing tests** — each spins an `HttpServer` on port 0:

```kotlin
class LiveClientTest {
    // helper: start server with a handler map, build PluginConfig pointing at it
    @Test fun `open sends metadata and bearer token, resolves relative streamUrl`() {
        // handler asserts: Authorization == "Bearer tok", body JSON has tool=gatling,
        // idempotencyKey present; responds 201 {"runId":"<uuid>","streamUrl":"/v1/runs/<uuid>/stream","nextOffset":0}
        // assert: returned OpenedRun.streamUrl == "http://localhost:<port>/v1/runs/<uuid>/stream"
    }
    @Test fun `open failure returns null and logs the problem remediation`() {
        // 403 problem+json {"detail":"...","remediation":"Mint a token with the stream scope."}
        // assert null returned; logged line contains that remediation verbatim
    }
    @Test fun `stream advances on 202`() { /* respond {"nextOffset":8191}; assert Advanced(8191) */ }
    @Test fun `409 is a resume point, not an error`() {
        // respond 409 {"type":...,"nextOffset":16383}; assert Resume(16383); assert NOT retried (1 request)
    }
    @Test fun `5xx retries with backoff then gives up`() {
        // always 500; assert 3 requests seen, result GaveUp; use short test backoff injected via ctor
    }
    @Test fun `401 mid-stream stops immediately`() { /* one request only, AuthFailed */ }
    @Test fun `close treats RUN_NOT_RUNNING 409 as done`() { /* respond 409 code RUN_NOT_RUNNING; assert true */ }
    @Test fun `X-Stream-Offset header carries the current offset`() { /* handler records header; assert */ }
}
```
(Each comment line above becomes real assertion code — the fake-server helper makes them 5–10 lines each. Inject `backoffMs: LongArray = longArrayOf(1000, 2000, 4000)` through the constructor so tests pass `longArrayOf(1, 1, 1)`.)

- [ ] **Step 2: Run to verify failure** — compile error.

- [ ] **Step 3: Implement** — `java.net.http.HttpClient` with 10s connect timeout, 30s request timeout; Gson for bodies; `streamUrl` resolved via `URI(config.baseUrl).resolve(relative)`; problem parsing tolerant of non-JSON bodies (log status + first 200 chars).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): live client -- offset-negotiated stream loop over the three endpoints"`

---

### Task 4: The results watcher and tailer

**Files:**
- Create: `.../RunTailer.kt`
- Test: `.../RunTailerTest.kt` (temp dirs, no HTTP — LiveClient faked via interface)

**Interfaces:**
- Consumes: `LiveClient` (extract `interface LiveApi { open/stream/close }` in this task; `LiveClient` implements it).
- Produces: `class RunTailer(api: LiveApi, config: PluginConfig, resultsRoot: Path, taskStartMillis: Long, clock/sleeper injectable)` with `fun start(): Thread` (daemon) and `fun finish()` (final flush + close current run; idempotent). Behaviour:
  - polls `resultsRoot` for directories whose name matches Gatling's `<sim>-<millis>` and whose embedded millis ≥ taskStartMillis, in creation order;
  - on a new directory: if a run is currently open → final-flush + close it (one run per simulation); then `open()` for the new one;
  - each tick: read from `simulation.log` at `nextOffset`, cap 4 MiB, `stream()`; `Resume` sets offset and continues; `AuthFailed` stops streaming permanently (still closes on `finish`); `GaveUp` skips the tick;
  - `finish()` drains remaining bytes (looping while a full 4 MiB was read) then closes.

- [ ] **Step 1: Write the failing tests**

```kotlin
class RunTailerTest {
    // FakeApi records calls; returns scripted results.
    @Test fun `waits for a directory newer than task start`() { /* pre-existing old dir ignored */ }
    @Test fun `ships partial blocks -- whatever bytes exist at the tick`() {
        // write 5000 bytes; tick; assert stream() saw exactly those 5000
    }
    @Test fun `caps a single read at 4 MiB and drains the rest next tick`() {
        // write 5 MiB; tick; assert first chunk 4*1024*1024, second 1 MiB
    }
    @Test fun `a second directory closes the first run and opens a second`() {
        // dir A tailed, then dir B appears; assert close(A) before open(B); offsets independent
    }
    @Test fun `409 resume rewinds the read position`() {
        // FakeApi returns Resume(0) once; assert next read starts at byte 0 again
    }
    @Test fun `finish drains the tail then closes -- including bytes written after the last tick`() {}
    @Test fun `auth failure stops streaming but finish still closes`() {}
    @Test fun `no directory ever appearing means no open and a clean finish`() {}
}
```
Each test drives the tailer synchronously by injecting a fake sleeper (a `Channel`/latch the test releases per tick) rather than real time.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — single-threaded loop; `RandomAccessFile` (or `FileChannel.read` with position) for offset reads; directory-name millis parsed from the suffix after the last `-`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): tailer -- one run per simulation, partial blocks shipped, 409 rewinds"`

---

### Task 5: Task wiring — doFirst, finalizer, never fail the build

**Files:**
- Modify: `.../PerfportalPlugin.kt`
- Test: `.../PerfportalPluginFunctionalTest.kt` (Gradle TestKit + the Task 3 fake server)

**Interfaces:**
- Produces: on apply — registers the `perfportal` extension; `tasks.matching { it.name == "gatlingRun" }.configureEach` adds a `doFirst` that resolves config (a `Missing` reason logs one warning and does nothing else), creates `LiveClient` + `RunTailer`, starts it; registers task `perfportalClose` and sets `gatlingRun.finalizedBy(perfportalClose)` — the finalizer calls `tailer.finish()` and runs **even when gatlingRun fails**, which is the whole reason it is a finalizer and not `doLast`. Every plugin action body is wrapped in a top-level `try/catch(Throwable)` that logs and swallows.

- [ ] **Step 1: Write the failing TestKit tests** — each writes a `settings.gradle.kts` + `build.gradle.kts` into a temp project. The build file registers a FAKE `gatlingRun` (a plain task that writes N bytes into `build/reports/gatling/fake-<millis>/simulation.log`, sleeping between writes), applies our plugin from `pluginClasspath` (via `withPluginClasspath()`), and points `PERFPORTAL_URL` at the fake server:

```kotlin
@Test fun `streams during the task and closes after it`() {
    // fake server records open/stream/close order; assert open before first stream,
    // close after task; total streamed bytes == bytes written
}
@Test fun `closes even when gatlingRun fails`() {
    // fake gatlingRun throws after writing bytes; GradleRunner.buildAndFail();
    // assert close was still called -- the finalizer property
}
@Test fun `missing token warns once and the build succeeds untouched`() {
    // no PERFPORTAL_TOKEN in env passed to runner; assert build SUCCESS,
    // output contains "PERFPORTAL_TOKEN", fake server saw zero requests
}
@Test fun `unreachable portal never fails the build`() {
    // URL points at a closed port; assert build SUCCESS and a warning
}
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Environment for `ResolvedConfig.from` comes from `System.getenv()` captured at execution time inside `doFirst` (TestKit passes env via `GradleRunner.withEnvironment`).
- [ ] **Step 4: Run to verify pass** — note TestKit + `withEnvironment` disables the daemon automatically; do not fight it.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): wire gatlingRun -- doFirst opens, a finalizer closes, failure included"`

---

### Task 6: `uploadIfLiveUnavailable` fallback

**Files:**
- Create: `.../BundleUploader.kt`; Modify: `PerfportalPlugin.kt` (finalizer branch), `LiveClient.kt` (nothing — uploader is its own small class)
- Test: `.../BundleUploaderTest.kt` + one TestKit case

**Interfaces:**
- Produces: `BundleUploader.upload(config, resultsDir: Path): Boolean` — tars `simulation.log` as `run-1/simulation.log` into a gzip stream (pure-JVM tar: Apache Commons Compress `1.26.2`, add to deps), POSTs multipart to `{base}/v1/runs` with field `metadata` = `{"tool":"gatling","waitMs":0,...environment/branch/commitSha}` and file field `bundle` (filename `bundle.tgz`); 202 is success. Runs in the finalizer ONLY when (a) the flag resolved true AND (b) `open` failed for that simulation's directory.

- [ ] **Step 1: Failing tests** — fake server asserts multipart shape (both field names, metadata JSON parses, `waitMs == 0`), 202 → true, 500 → false + warning; TestKit case: flag off + open failing → server sees NO `/v1/runs` POST; flag on + open failing → exactly one.
- [ ] **Step 2–4: fail, implement, pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): opt-in post-run upload when live could not be opened, default off"`

---

### Task 7: End-to-end against the real stack

**Files:**
- Create: `clients/gatling-gradle/e2e/e2e-project/` (a `build.gradle.kts` applying `io.gatling.gradle` 3.15.1.2 + our plugin from `mavenLocal()`, with `fixtures/gatling-3.15.1.2/simulation/ParitySimulation.kt` copied in as its source), `clients/gatling-gradle/e2e/seed.mjs` (mints an org/project/token with `stream`+`read` scopes — same shape as the session's earlier drive scripts, run from `apps/api/` so workspace packages resolve), `clients/gatling-gradle/e2e/run-e2e.sh`

**The script, in order:** assert stack + API + worker are up (fail fast with the compose/env instructions otherwise) → `./gradlew publishToMavenLocal` → `node ../../apps/api/e2e-seed` (prints token) → start `fixtures/.../target-server.js` → run the e2e-project's `gatlingRun` with `PERFPORTAL_URL`/`PERFPORTAL_TOKEN` set → poll `GET /v1/runs/{id}` with the read token until terminal → **assert** `status == "complete"` and `toolAssertions` outcomes are exactly `[passed, passed, failed]` — the fixture simulation's deliberate shape, the same comparison performed by hand in the spec (§7: `11494` / `85.8457997698504` / `179` matched Gatling's console to the last decimal) → also assert the run id printed by the plugin during the build matches the run polled.

- [ ] Steps: write script → run against the local stack (integration-before-e2e discipline applies: `pgrep -f vitest` first; both suites truncate the DB this seeds into) → fix what the real world finds → commit `git commit -m "test(plugin): e2e -- a real Gatling run streams live into a real PerfPortal"`. This gate is manual/on-demand, not in `pnpm` gates and not in the CI `plugin` job (it needs Docker + the seeded stack); Task 8 documents it.

---

### Task 8: Documentation

**Files:**
- Create: `clients/gatling-gradle/README.md` — apply snippet, config table (every key + env fallback), the token rule and WHY (process-list/git-history reasoning, matching the agent's), the 8 KiB liveness expectation (spec §1's table, so nobody files "live is laggy" as a bug), failure semantics table from spec §5, e2e instructions.
- Modify: `CLAUDE.md` — in the Verification section, beside the Go agent's gate: a third-toolchain paragraph naming `cd clients/gatling-gradle && ./gradlew build` as the gate `pnpm` is blind to, and the e2e script as manual.

- [ ] Write both, verify the README's apply snippet against the actual published coordinates, run the full plugin gate once more, commit: `git commit -m "docs(plugin): README and the third toolchain's gate line in CLAUDE.md"`.

---

## Self-review

**Spec coverage:** §0 boundary → no task executes tests (Task 7 runs Gatling via *Gradle*, the permitted side). §1 partial blocks → Task 4 test 2; 8 KiB expectation documented → Task 8. §2 lifecycle/offsets/4 MiB/no-shutdown-hook → Tasks 3–5 (finalizer, not a JVM hook; kill-9 leaves the sweeper path untouched as designed). §3 one-run-per-sim → Task 4 test 4 + Task 5. §4 config/token/idempotencyKey → Task 2; idempotencyKey generated once per task execution in Task 5's `doFirst` (UUID, reused for open retries within `LiveClient.open`). §5 failure table → Tasks 3/5/6 tests map row-for-row; `uploadIfLiveUnavailable` default false → Task 2 test 5 + Task 6 TestKit case. §6 toolchain-first + publish → Task 1. §7 three test layers → Tasks 3–4 (fake server), 5 (TestKit), 7 (real stack). §8 out of scope → no task touches the agent, Maven, or the DataWriter SPI.

**Placeholders:** Task 3 Step 1 and Task 4 Step 1 use annotated test skeletons whose comments each name concrete assertions — acceptable shorthand only because the fake-server helper is defined in the same task; no "TBD/similar to Task N" anywhere.

**Type consistency:** `PluginConfig` (Task 2) is the type `LiveClient` (3), `RunTailer` (4), wiring (5) and `BundleUploader` (6) all take; `LiveApi` extracted in Task 4 is what `RunTailer` consumes and `LiveClient` implements; `OpenedRun.nextOffset` is the single offset source Tasks 3–4 share.

**Known risk, stated:** GitHub Packages publishing from CI needs `packages: write`; if the org disallows it, Task 1's publish step degrades to uploading the jar as a workflow artifact — a one-step change, flagged for the executor rather than hidden.
