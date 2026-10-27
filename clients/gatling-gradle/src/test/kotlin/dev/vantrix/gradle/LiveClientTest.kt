package dev.vantrix.gradle

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.charset.StandardCharsets
import java.util.UUID
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.*

class LiveClientTest {

    private var server: HttpServer? = null

    @AfterEach
    fun tearDown() {
        server?.stop(0)
    }

    private data class RecordedRequest(
        val method: String,
        val path: String,
        val headers: com.sun.net.httpserver.Headers,
        val body: String,
    )

    /** Starts a fake server whose paths are wired to the given handlers, recording every request seen. */
    private fun startServer(vararg handlers: Pair<String, (HttpExchange) -> Unit>): Pair<HttpServer, MutableList<RecordedRequest>> {
        val requests = mutableListOf<RecordedRequest>()
        val srv = HttpServer.create(InetSocketAddress(0), 0)
        for ((path, handler) in handlers) {
            srv.createContext(path) { exchange ->
                val body = exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8)
                requests.add(RecordedRequest(exchange.requestMethod, exchange.requestURI.path, exchange.requestHeaders, body))
                handler(exchange)
            }
        }
        srv.executor = null
        srv.start()
        server = srv
        return srv to requests
    }

    private fun configFor(srv: HttpServer, token: String = "tok") = PluginConfig(
        baseUrl = "http://localhost:${srv.address.port}",
        token = token,
        environment = null, branch = null, commitSha = null, test = null,
        tickSeconds = 5, uploadIfLiveUnavailable = false, resultsDir = null, agentEnabled = false,
    )

    private fun respond(exchange: HttpExchange, status: Int, body: String, contentType: String = "application/json") {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", contentType)
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.write(bytes)
        exchange.close()
    }

    @Test fun `open sends metadata and bearer token, resolves relative streamUrl`() {
        val runId = UUID.randomUUID().toString()
        val (srv, requests) = startServer("/v1/runs/live" to { ex ->
            respond(ex, 201, """{"runId":"$runId","streamUrl":"/v1/runs/$runId/stream","nextOffset":0}""")
        })
        val client = LiveClient(configFor(srv, "tok"), logger = {})

        val run = client.open("idem-key-1")

        assertNotNull(run)
        assertEquals("http://localhost:${srv.address.port}/v1/runs/$runId/stream", run.streamUrl)
        assertEquals(1, requests.size)
        val req = requests[0]
        assertEquals("Bearer tok", req.headers.getFirst("Authorization"))
        val bodyJson = JsonParser.parseString(req.body).asJsonObject
        assertEquals("gatling", bodyJson.get("tool").asString)
        assertEquals("idem-key-1", bodyJson.get("idempotencyKey").asString)
    }

    @Test fun `open success logs the run id and its portal URL`() {
        val runId = UUID.randomUUID().toString()
        val (srv, _) = startServer("/v1/runs/live" to { ex ->
            respond(ex, 201, """{"runId":"$runId","streamUrl":"/v1/runs/$runId/stream","nextOffset":0}""")
        })
        val logs = mutableListOf<String>()
        val client = LiveClient(configFor(srv), logger = { logs.add(it) })

        val run = client.open("idem-key-1")

        assertNotNull(run)
        assertTrue(
            logs.any { it.contains(runId) && it.contains("http://localhost:${srv.address.port}/runs/$runId") },
            "expected a log line naming the run id and its portal URL, got: $logs",
        )
    }

    @Test fun `open failure returns null and logs the problem remediation`() {
        val remediation = "Mint a token with the stream scope."
        val (srv, _) = startServer("/v1/runs/live" to { ex ->
            respond(
                ex, 403,
                """{"type":"https://x/errors/FORBIDDEN","title":"forbidden","status":403,"code":"FORBIDDEN",""" +
                    """"detail":"no stream scope","remediation":"$remediation"}""",
                "application/problem+json",
            )
        })
        val logs = mutableListOf<String>()
        val client = LiveClient(configFor(srv), logger = { logs.add(it) })

        val run = client.open("idem-key-1")

        assertNull(run)
        assertTrue(logs.any { it.contains(remediation) }, "expected a log line containing the remediation, got: $logs")
    }

    @Test fun `stream advances on 202`() {
        val (srv, _) = startServer("/v1/runs/abc/stream" to { ex -> respond(ex, 202, """{"nextOffset":8191}""") })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        val result = client.stream(run, "hello".toByteArray())

        assertEquals(StreamResult.Advanced(8191), result)
    }

    @Test fun `409 is a resume point, not an error`() {
        val (srv, requests) = startServer("/v1/runs/abc/stream" to { ex ->
            respond(
                ex, 409,
                """{"type":"t","title":"t","status":409,"code":"STREAM_OFFSET_REJECTED","detail":"d",""" +
                    """"remediation":"r","nextOffset":16383}""",
                "application/problem+json",
            )
        })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 100)

        val result = client.stream(run, "hello".toByteArray())

        assertEquals(StreamResult.Resume(16383), result)
        assertEquals(1, requests.size)
    }

    @Test fun `5xx retries with backoff then gives up`() {
        val (srv, requests) = startServer("/v1/runs/abc/stream" to { ex -> respond(ex, 500, "boom", "text/plain") })
        val client = LiveClient(configFor(srv), logger = {}, backoffMs = longArrayOf(1, 1, 1))
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        val result = client.stream(run, "hello".toByteArray())

        assertEquals(StreamResult.GaveUp, result)
        assertEquals(3, requests.size)
    }

    @Test fun `401 mid-stream stops immediately`() {
        val (srv, requests) = startServer("/v1/runs/abc/stream" to { ex ->
            respond(
                ex, 401,
                """{"type":"t","title":"t","status":401,"code":"UNAUTHENTICATED","detail":"d","remediation":"r"}""",
                "application/problem+json",
            )
        })
        val client = LiveClient(configFor(srv), logger = {}, backoffMs = longArrayOf(1, 1, 1))
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        val result = client.stream(run, "hello".toByteArray())

        assertEquals(StreamResult.AuthFailed, result)
        assertEquals(1, requests.size)
    }

    @Test fun `close treats RUN_NOT_RUNNING 409 as done`() {
        val (srv, _) = startServer("/v1/runs/abc/close" to { ex ->
            respond(
                ex, 409,
                """{"type":"t","title":"t","status":409,"code":"RUN_NOT_RUNNING","detail":"d","remediation":"r"}""",
                "application/problem+json",
            )
        })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        assertTrue(client.close(run))
    }

    @Test fun `X-Stream-Offset header carries the current offset`() {
        val (srv, requests) = startServer("/v1/runs/abc/stream" to { ex -> respond(ex, 202, """{"nextOffset":42}""") })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 12345)

        client.stream(run, "hello".toByteArray())

        assertEquals("12345", requests[0].headers.getFirst("X-Stream-Offset"))
    }

    // ── uploadAgent: PUT /v1/runs/{id}/agent ─────────────────────────────────────────────

    private fun agentFile(tmp: Path): Path {
        val file = tmp.resolve("agent-1-1000.ndjson")
        Files.writeString(file, "{\"t\":\"header\",\"startedAt\":1000}\n{\"t\":\"s\",\"ts\":1}\n")
        return file
    }

    private fun problem(status: Int, code: String) =
        """{"type":"t","title":"t","status":$status,"code":"$code","detail":"d","remediation":"r"}"""

    @Test fun `uploadAgent PUTs the file with the bearer token as x-ndjson and reads 204 as stored`(@TempDir tmp: Path) {
        val file = agentFile(tmp)
        val (srv, requests) = startServer("/v1/runs/abc/agent" to { ex ->
            ex.sendResponseHeaders(204, -1)
            ex.close()
        })
        val client = LiveClient(configFor(srv, "tok"), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        val result = client.uploadAgent(run, file)

        assertEquals(AgentUpload.Stored, result)
        assertEquals(1, requests.size)
        val req = requests[0]
        assertEquals("PUT", req.method)
        assertEquals("/v1/runs/abc/agent", req.path)
        assertEquals("Bearer tok", req.headers.getFirst("Authorization"))
        assertEquals("application/x-ndjson", req.headers.getFirst("Content-Type"))
        assertEquals(Files.readString(file), req.body)
    }

    @Test fun `uploadAgent reads 404, 409 and 413 as refusals carrying the status and the problem's code`(@TempDir tmp: Path) {
        val file = agentFile(tmp)
        for ((status, code) in listOf(404 to "NOT_FOUND", 409 to "RUN_NOT_RUNNING", 413 to "AGENT_LOG_TOO_LARGE")) {
            val (srv, _) = startServer("/v1/runs/abc/agent" to { ex ->
                respond(ex, status, problem(status, code), "application/problem+json")
            })
            val client = LiveClient(configFor(srv), logger = {})
            val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

            assertEquals(AgentUpload.Refused(status, code), client.uploadAgent(run, file))
            srv.stop(0)
        }
    }

    @Test fun `uploadAgent reads a refusal with no problem body as a refusal with no code`(@TempDir tmp: Path) {
        val file = agentFile(tmp)
        val (srv, _) = startServer("/v1/runs/abc/agent" to { ex -> respond(ex, 404, "Cannot PUT", "text/html") })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        assertEquals(AgentUpload.Refused(404, null), client.uploadAgent(run, file))
    }

    @Test fun `uploadAgent answers Failed, never throws, when nothing is listening`(@TempDir tmp: Path) {
        val file = agentFile(tmp)
        val (srv, _) = startServer()
        val port = srv.address.port
        val config = configFor(srv)
        srv.stop(0)
        server = null
        val client = LiveClient(config, logger = {})
        val run = OpenedRun("abc", "http://localhost:$port/v1/runs/abc/stream", 0)

        val result = client.uploadAgent(run, file)

        assertTrue(result is AgentUpload.Failed, "expected Failed, got $result")
        assertTrue(result.message.isNotBlank())
    }

    @Test fun `uploadAgent answers Failed, never throws, when the file has gone`(@TempDir tmp: Path) {
        val (srv, requests) = startServer("/v1/runs/abc/agent" to { ex ->
            ex.sendResponseHeaders(204, -1)
            ex.close()
        })
        val client = LiveClient(configFor(srv), logger = {})
        val run = OpenedRun("abc", "http://localhost:${srv.address.port}/v1/runs/abc/stream", 0)

        val result = client.uploadAgent(run, tmp.resolve("gone.ndjson"))

        assertTrue(result is AgentUpload.Failed, "expected Failed, got $result")
        assertTrue(requests.isEmpty())
    }
}
