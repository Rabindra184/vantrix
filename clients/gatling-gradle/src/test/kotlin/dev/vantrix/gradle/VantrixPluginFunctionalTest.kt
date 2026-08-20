package dev.vantrix.gradle

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir
import kotlin.test.*

/**
 * Exercises the plugin end-to-end through Gradle TestKit: a fake `gatlingRun` task plays the
 * part of the real Gatling plugin's task (same name, nothing else in common), our plugin is
 * applied from the plugin-under-test classpath, and a tiny `com.sun.net.httpserver` fixture
 * (same pattern as [LiveClientTest], copied locally rather than shared) plays the part of the
 * Vantrix portal.
 *
 * `withEnvironment` forces TestKit to fork a fresh, non-daemon build JVM per run (env can't
 * safely be injected into a shared daemon), so each of these takes on the order of 10-30s. That
 * is expected -- see the module's CLAUDE.md notes on this plugin's task 5.
 */
class VantrixPluginFunctionalTest {

    private var server: HttpServer? = null

    @AfterEach
    fun tearDown() {
        server?.stop(0)
    }

    // ---- fake portal -------------------------------------------------------------------

    private data class RecordedEvent(val type: String, val byteCount: Int = 0)

    private class FakeServerState {
        val events = CopyOnWriteArrayList<RecordedEvent>()
        val runsPostMarkerPresent = CopyOnWriteArrayList<Boolean>()
        var runCounter = 0
    }

    /**
     * Starts a fake portal recording open/stream/close/upload events in the order requests
     * arrive. [openStatusCode] lets a test make `open` fail (e.g. 403) to exercise the
     * fallback-upload path; [projectDir], when given, lets the `/v1/runs` (bundle upload) handler
     * check -- at the moment it receives the request -- whether a marker file the fake
     * `gatlingRun` task writes as the LAST thing it does already exists, proving the upload
     * arrived after the task itself finished rather than mid-task.
     */
    private fun startServer(openStatusCode: Int = 201, projectDir: File? = null): Pair<HttpServer, FakeServerState> {
        val state = FakeServerState()
        val srv = HttpServer.create(InetSocketAddress(0), 0)

        srv.createContext("/v1/runs/live") { exchange ->
            exchange.requestBody.readBytes()
            if (openStatusCode == 201) {
                val n = synchronized(state) { ++state.runCounter }
                val runId = "run-$n"
                state.events.add(RecordedEvent("open"))
                respond(exchange, 201, """{"runId":"$runId","streamUrl":"/v1/runs/$runId/stream","nextOffset":0}""")
            } else {
                state.events.add(RecordedEvent("open-failed"))
                respond(
                    exchange, openStatusCode,
                    """{"type":"t","title":"t","status":$openStatusCode,"code":"FORBIDDEN","detail":"d","remediation":"r"}""",
                )
            }
        }
        // Exact context: only matches a POST to precisely "/v1/runs" (the fallback bundle
        // upload), never "/v1/runs/live" or "/v1/runs/{id}/..." -- HttpServer resolves those to
        // their own, longer-prefix contexts registered separately.
        srv.createContext("/v1/runs") { exchange ->
            exchange.requestBody.readBytes()
            val markerPresent = projectDir?.let { File(it, "build/reports/gatling/task-finished.marker").exists() } ?: false
            state.events.add(RecordedEvent("runs-post"))
            state.runsPostMarkerPresent.add(markerPresent)
            respond(exchange, 202, "{}")
        }
        srv.createContext("/v1/runs/") { exchange ->
            val path = exchange.requestURI.path
            when {
                path.endsWith("/stream") -> {
                    val bytes = exchange.requestBody.readBytes()
                    val offsetHeader = exchange.requestHeaders.getFirst("X-Stream-Offset")?.toLongOrNull() ?: 0L
                    state.events.add(RecordedEvent("stream", bytes.size))
                    respond(exchange, 202, """{"nextOffset":${offsetHeader + bytes.size}}""")
                }
                path.endsWith("/close") -> {
                    exchange.requestBody.readBytes()
                    state.events.add(RecordedEvent("close"))
                    respond(exchange, 200, "{}")
                }
                else -> {
                    exchange.requestBody.readBytes()
                    respond(exchange, 404, "{}")
                }
            }
        }
        srv.executor = null
        srv.start()
        server = srv
        return srv to state
    }

    private fun respond(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.write(bytes)
        exchange.close()
    }

    // ---- temp project scaffolding -------------------------------------------------------

    private fun writeSettings(projectDir: File) {
        File(projectDir, "settings.gradle.kts").writeText("rootProject.name = \"functional-test\"\n")
    }

    /**
     * `plugins {}` is required to be the FIRST statement in a Kotlin DSL build script, so a task
     * registered later in the same `build.gradle.kts` would always run AFTER our plugin's
     * `apply()` -- too late to exercise the collision guard (it would instead blow up on the
     * user's own registration line, a different failure). `gradle.rootProject { ... }` in
     * `settings.gradle.kts` runs before the root project's build script is evaluated at all,
     * which is the only way to genuinely pre-exist a task ahead of `apply()`. Confirmed
     * empirically: against the unguarded plugin this reproduces exactly the reviewer's failure --
     * "Failed to apply plugin 'dev.vantrix.gatling' > Cannot add task 'vantrixClose'...".
     */
    private fun writeSettingsWithPreexistingVantrixCloseTask(projectDir: File) {
        File(projectDir, "settings.gradle.kts").writeText(
            """
            |rootProject.name = "functional-test"
            |gradle.rootProject {
            |    tasks.register("vantrixClose") { doLast { println("USER-DEFINED-VANTRIXCLOSE") } }
            |}
            """.trimMargin(),
        )
    }

    /** [fakeTaskBody] is the body of `tasks.register("gatlingRun") { <body> }` -- e.g. a `doLast { ... }`. */
    private fun writeBuildFile(projectDir: File, fakeTaskBody: String) {
        File(projectDir, "build.gradle.kts").writeText(
            """
            |plugins {
            |    id("dev.vantrix.gatling")
            |}
            |
            |tasks.register("gatlingRun") {
            |$fakeTaskBody
            |}
            """.trimMargin(),
        )
    }

    private fun runner(projectDir: File, env: Map<String, String>): GradleRunner =
        GradleRunner.create()
            .withProjectDir(projectDir)
            .withPluginClasspath()
            .withArguments("gatlingRun", "--stacktrace")
            .withEnvironment(env)

    /** PATH + JAVA_HOME from the real environment (withEnvironment REPLACES, not merges) plus whatever is given. */
    private fun envFor(vararg extra: Pair<String, String>): Map<String, String> {
        val base = mutableMapOf<String, String>()
        System.getenv("PATH")?.let { base["PATH"] = it }
        System.getenv("JAVA_HOME")?.let { base["JAVA_HOME"] = it }
        base.putAll(extra)
        return base
    }

    private fun <T> pollUntil(timeoutMs: Long = 20_000, intervalMs: Long = 200, condition: (T) -> Boolean, supplier: () -> T): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last = supplier()
        while (System.currentTimeMillis() < deadline) {
            last = supplier()
            if (condition(last)) return last
            Thread.sleep(intervalMs)
        }
        return last
    }

    // ---- tests ----------------------------------------------------------------------------

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `streams during the task and closes after it`(@TempDir tmp: File) {
        val (srv, state) = startServer()
        writeSettings(tmp)
        writeBuildFile(
            tmp,
            """
            |    doLast {
            |        val dir = layout.buildDirectory.dir("reports/gatling/fake-" + System.currentTimeMillis()).get().asFile
            |        dir.mkdirs()
            |        val log = java.io.File(dir, "simulation.log")
            |        log.appendBytes(ByteArray(1000) { 'a'.code.toByte() })
            |        Thread.sleep(2000)
            |        log.appendBytes(ByteArray(500) { 'b'.code.toByte() })
            |    }
            """.trimMargin(),
        )
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:${srv.address.port}",
            "VANTRIX_TOKEN" to "tok",
            "VANTRIX_TICK_SECONDS" to "1",
        )

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, result.task(":vantrixClose")?.outcome)

        // finish() is synchronous inside the finalizer's own action, so by the time build()
        // returns everything is already settled -- this poll is just a robustness net.
        val events = pollUntil(condition = { it: List<RecordedEvent> -> it.any { e -> e.type == "close" } }) {
            state.events.toList()
        }

        val openIdx = events.indexOfFirst { it.type == "open" }
        val firstStreamIdx = events.indexOfFirst { it.type == "stream" }
        val lastCloseIdx = events.indexOfLast { it.type == "close" }

        assertTrue(openIdx >= 0, "expected an open event, got: $events")
        assertTrue(firstStreamIdx >= 0, "expected at least one stream event, got: $events")
        assertTrue(openIdx < firstStreamIdx, "expected open strictly before the first stream, got: $events")
        assertTrue(firstStreamIdx < lastCloseIdx, "expected close after the streaming, got: $events")

        val totalStreamed = events.filter { it.type == "stream" }.sumOf { it.byteCount }
        assertEquals(1500, totalStreamed, "expected all written bytes to have been streamed, got: $events")
    }

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `closes even when gatlingRun fails`(@TempDir tmp: File) {
        val (srv, state) = startServer()
        writeSettings(tmp)
        writeBuildFile(
            tmp,
            """
            |    doLast {
            |        val dir = layout.buildDirectory.dir("reports/gatling/fake-" + System.currentTimeMillis()).get().asFile
            |        dir.mkdirs()
            |        val log = java.io.File(dir, "simulation.log")
            |        log.appendBytes(ByteArray(1000) { 'a'.code.toByte() })
            |        Thread.sleep(1500)
            |        throw org.gradle.api.GradleException("boom -- intentional failure for the finalizer test")
            |    }
            """.trimMargin(),
        )
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:${srv.address.port}",
            "VANTRIX_TOKEN" to "tok",
            "VANTRIX_TICK_SECONDS" to "1",
        )

        val result = runner(tmp, env).buildAndFail()

        assertEquals(TaskOutcome.FAILED, result.task(":gatlingRun")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, result.task(":vantrixClose")?.outcome)

        val events = pollUntil(condition = { it: List<RecordedEvent> -> it.any { e -> e.type == "close" } }) {
            state.events.toList()
        }
        assertTrue(events.any { it.type == "close" }, "expected close to have been called despite the failure, got: $events")
    }

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `missing token warns once and the build succeeds untouched`(@TempDir tmp: File) {
        val (srv, state) = startServer()
        writeSettings(tmp)
        writeBuildFile(
            tmp,
            """
            |    doLast {
            |        println("fake gatlingRun ran")
            |    }
            """.trimMargin(),
        )
        // Deliberately no VANTRIX_TOKEN.
        val env = envFor("VANTRIX_URL" to "http://localhost:${srv.address.port}")

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertTrue(result.output.contains("VANTRIX_TOKEN"), "expected the missing-token reason in output, got:\n${result.output}")
        assertTrue(state.events.isEmpty(), "expected zero requests to the portal, got: ${state.events}")
    }

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `unreachable portal never fails the build`(@TempDir tmp: File) {
        val closedPortSocket = ServerSocket(0)
        val deadPort = closedPortSocket.localPort
        closedPortSocket.close()

        writeSettings(tmp)
        writeBuildFile(
            tmp,
            """
            |    doLast {
            |        val dir = layout.buildDirectory.dir("reports/gatling/fake-" + System.currentTimeMillis()).get().asFile
            |        dir.mkdirs()
            |        val log = java.io.File(dir, "simulation.log")
            |        log.appendBytes(ByteArray(200) { 'a'.code.toByte() })
            |        Thread.sleep(2000)
            |    }
            """.trimMargin(),
        )
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:$deadPort",
            "VANTRIX_TOKEN" to "tok",
            "VANTRIX_TICK_SECONDS" to "1",
        )

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertTrue(
            result.output.contains("vantrix:") && result.output.contains("failed", ignoreCase = true),
            "expected a vantrix warning about the unreachable portal in output, got:\n${result.output}",
        )
    }

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `a pre-existing vantrixClose task disables the plugin instead of crashing the build`(@TempDir tmp: File) {
        val (srv, state) = startServer()
        writeSettingsWithPreexistingVantrixCloseTask(tmp)
        writeBuildFile(
            tmp,
            """
            |    doLast {
            |        println("fake gatlingRun ran")
            |    }
            """.trimMargin(),
        )
        // Full, valid env -- if the plugin wired anything at all here, it would have everything it needs to.
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:${srv.address.port}",
            "VANTRIX_TOKEN" to "tok",
        )

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertTrue(
            result.output.contains("a task named 'vantrixClose' already exists"),
            "expected the disabled-plugin warning in output, got:\n${result.output}",
        )
        assertTrue(
            state.events.isEmpty(),
            "expected zero requests to the portal -- the plugin should have gone fully inert rather than half-wiring, got: ${state.events}",
        )
    }

    /** [fakeTaskBody] used by the two fallback-upload tests below: writes a results dir with a log,
     * sleeps long enough for a tick to discover it and attempt (and fail) an open, then writes a
     * marker file as the LAST thing it does -- outside the results dir, so it never pollutes the
     * tarred bundle -- so the fake portal can tell whether an upload arrived before or after. */
    private fun fallbackUploadTaskBody(): String =
        """
        |    doLast {
        |        val dir = layout.buildDirectory.dir("reports/gatling/fake-" + System.currentTimeMillis()).get().asFile
        |        dir.mkdirs()
        |        val log = java.io.File(dir, "simulation.log")
        |        log.appendBytes(ByteArray(200) { 'a'.code.toByte() })
        |        Thread.sleep(1500)
        |        java.io.File(dir.parentFile, "task-finished.marker").writeText("done")
        |    }
        """.trimMargin()

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `flag off -- an open failure never triggers a fallback upload`(@TempDir tmp: File) {
        val (srv, state) = startServer(openStatusCode = 403, projectDir = tmp)
        writeSettings(tmp)
        writeBuildFile(tmp, fallbackUploadTaskBody())
        // Deliberately no VANTRIX_UPLOAD_IF_LIVE_UNAVAILABLE -- default is false.
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:${srv.address.port}",
            "VANTRIX_TOKEN" to "tok",
            "VANTRIX_TICK_SECONDS" to "1",
        )

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, result.task(":vantrixClose")?.outcome)

        val events = pollUntil(condition = { it: List<RecordedEvent> -> it.any { e -> e.type == "open-failed" } }) {
            state.events.toList()
        }
        assertTrue(events.any { it.type == "open-failed" }, "expected an open-failed event, got: $events")
        assertTrue(
            state.events.none { it.type == "runs-post" },
            "expected zero POSTs to /v1/runs when the flag is off, got: ${state.events}",
        )
    }

    @Test
    @Timeout(value = 90, unit = TimeUnit.SECONDS)
    fun `flag on -- an open failure uploads the finished log exactly once, after the task itself finished`(@TempDir tmp: File) {
        val (srv, state) = startServer(openStatusCode = 403, projectDir = tmp)
        writeSettings(tmp)
        writeBuildFile(tmp, fallbackUploadTaskBody())
        val env = envFor(
            "VANTRIX_URL" to "http://localhost:${srv.address.port}",
            "VANTRIX_TOKEN" to "tok",
            "VANTRIX_TICK_SECONDS" to "1",
            "VANTRIX_UPLOAD_IF_LIVE_UNAVAILABLE" to "true",
        )

        val result = runner(tmp, env).build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":gatlingRun")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, result.task(":vantrixClose")?.outcome)

        val events = pollUntil(condition = { it: List<RecordedEvent> -> it.any { e -> e.type == "runs-post" } }) {
            state.events.toList()
        }
        val uploadEvents = events.filter { it.type == "runs-post" }
        assertEquals(1, uploadEvents.size, "expected exactly one POST to /v1/runs, got: $events")
        assertEquals(1, state.runsPostMarkerPresent.size)
        assertTrue(
            state.runsPostMarkerPresent[0],
            "expected the upload to arrive after the task's own doLast (marker file) had already run, " +
                "got marker-present=${state.runsPostMarkerPresent}",
        )
    }
}
