package dev.vantrix.gradle

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayInputStream
import java.io.File
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.*

/**
 * Same fake-server pattern as [LiveClientTest], but capturing the RAW request bytes rather than a
 * decoded [String] -- the bundle part is a gzip stream, and a UTF-8 round trip would corrupt it.
 */
class BundleUploaderTest {

    private var server: HttpServer? = null

    @AfterEach
    fun tearDown() {
        server?.stop(0)
    }

    private data class RecordedRequest(
        val method: String,
        val path: String,
        val headers: com.sun.net.httpserver.Headers,
        val body: ByteArray,
    )

    private fun startServer(status: Int, responseBody: String = "{}"): Pair<HttpServer, MutableList<RecordedRequest>> {
        val requests = mutableListOf<RecordedRequest>()
        val srv = HttpServer.create(InetSocketAddress(0), 0)
        srv.createContext("/v1/runs") { exchange: HttpExchange ->
            val body = exchange.requestBody.readBytes()
            requests.add(RecordedRequest(exchange.requestMethod, exchange.requestURI.path, exchange.requestHeaders, body))
            val bytes = responseBody.toByteArray(StandardCharsets.UTF_8)
            exchange.responseHeaders.set("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.write(bytes)
            exchange.close()
        }
        srv.executor = null
        srv.start()
        server = srv
        return srv to requests
    }

    private fun configFor(
        srv: HttpServer,
        environment: String? = "prod",
        branch: String? = "main",
        commitSha: String? = "sha123",
        token: String = "tok",
    ) = PluginConfig(
        baseUrl = "http://localhost:${srv.address.port}",
        token = token,
        environment = environment, branch = branch, commitSha = commitSha,
        tickSeconds = 5, uploadIfLiveUnavailable = true, resultsDir = null,
    )

    private fun extractBoundary(contentType: String): String {
        val marker = "boundary="
        val idx = contentType.indexOf(marker)
        assertTrue(idx >= 0, "expected a boundary in Content-Type, got: $contentType")
        return contentType.substring(idx + marker.length)
    }

    /**
     * Splits a raw multipart body into name -> raw part bytes via an ISO-8859-1 round trip, which
     * is lossless for every byte 0-255 -- safe even though the `bundle` part is binary gzip data.
     * Also enforces the CRLF discipline the brief calls out: each part must open with a CRLF right
     * after its boundary line, and its body must end with a CRLF right before the next boundary.
     */
    private fun parseMultipart(raw: ByteArray, boundary: String): Map<String, ByteArray> {
        val text = raw.toString(Charsets.ISO_8859_1)
        val delimiter = "--$boundary"
        val result = mutableMapOf<String, ByteArray>()
        for (rawSegment in text.split(delimiter)) {
            if (rawSegment.isEmpty() || rawSegment == "--\r\n" || rawSegment == "--") continue
            assertTrue(rawSegment.startsWith("\r\n"), "expected each part to open with a CRLF right after its boundary line")
            val segment = rawSegment.substring(2)
            val headerEnd = segment.indexOf("\r\n\r\n")
            assertTrue(headerEnd >= 0, "expected a blank line separating a part's headers from its body")
            val headers = segment.substring(0, headerEnd)
            val rawBody = segment.substring(headerEnd + 4)
            assertTrue(rawBody.endsWith("\r\n"), "expected each part body to end with a CRLF right before the next boundary")
            val partBody = rawBody.substring(0, rawBody.length - 2)
            val name = Regex("name=\"([^\"]+)\"").find(headers)?.groupValues?.get(1)
                ?: fail("no name= found in part headers: $headers")
            result[name] = partBody.toByteArray(Charsets.ISO_8859_1)
        }
        return result
    }

    private fun untarGzip(bytes: ByteArray): Map<String, ByteArray> {
        val result = mutableMapOf<String, ByteArray>()
        GzipCompressorInputStream(ByteArrayInputStream(bytes)).use { gz ->
            TarArchiveInputStream(gz).use { tar ->
                var entry = tar.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        result[entry.name] = tar.readBytes()
                    }
                    entry = tar.nextEntry
                }
            }
        }
        return result
    }

    @Test
    fun `uploads a multipart body -- both fields, metadata JSON, bundle gunzips and untars back to the exact log bytes`(@TempDir tmp: File) {
        val logBytes = "GATLING LOG LINE\n".repeat(200).toByteArray(StandardCharsets.UTF_8)
        File(tmp, "simulation.log").writeBytes(logBytes)
        val (srv, requests) = startServer(status = 202)

        val result = BundleUploader(logger = {}).upload(configFor(srv), tmp.toPath())

        assertTrue(result)
        assertEquals(1, requests.size)
        val req = requests[0]
        assertEquals("POST", req.method)
        assertEquals("/v1/runs", req.path)
        assertEquals("Bearer tok", req.headers.getFirst("Authorization"))

        val contentType = req.headers.getFirst("Content-Type")
        assertNotNull(contentType)
        assertTrue(contentType.startsWith("multipart/form-data; boundary="), "got: $contentType")
        val boundary = extractBoundary(contentType)

        // Boundary discipline: the body must open with the metadata part's exact header block.
        assertTrue(
            req.body.toString(Charsets.ISO_8859_1)
                .startsWith("--$boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"),
            "expected the body to open with the metadata part's exact headers",
        )

        val parts = parseMultipart(req.body, boundary)
        assertEquals(setOf("metadata", "bundle"), parts.keys, "expected exactly the two named parts")

        val metadataJson = JsonParser.parseString(parts.getValue("metadata").toString(StandardCharsets.UTF_8)).asJsonObject
        assertEquals("gatling", metadataJson.get("tool").asString)
        assertEquals(0, metadataJson.get("waitMs").asInt)

        val bundleBytes = parts.getValue("bundle")
        assertTrue(bundleBytes.isNotEmpty())
        val untarred = untarGzip(bundleBytes)
        assertEquals(setOf("run-1/simulation.log"), untarred.keys)
        assertContentEquals(logBytes, untarred.getValue("run-1/simulation.log"))
    }

    @Test
    fun `metadata omits environment when null, but keeps branch and commitSha when present`(@TempDir tmp: File) {
        File(tmp, "simulation.log").writeBytes("x".toByteArray())
        val (srv, requests) = startServer(status = 202)

        val result = BundleUploader(logger = {}).upload(
            configFor(srv, environment = null, branch = "main", commitSha = "sha123"),
            tmp.toPath(),
        )

        assertTrue(result)
        val contentType = requests[0].headers.getFirst("Content-Type")
        val boundary = extractBoundary(contentType!!)
        val parts = parseMultipart(requests[0].body, boundary)
        val metadataJson = JsonParser.parseString(parts.getValue("metadata").toString(StandardCharsets.UTF_8)).asJsonObject

        assertFalse(metadataJson.has("environment"), "expected no 'environment' key when null, got: $metadataJson")
        assertEquals("main", metadataJson.get("branch").asString)
        assertEquals("sha123", metadataJson.get("commitSha").asString)
    }

    @Test
    fun `202 is success`(@TempDir tmp: File) {
        File(tmp, "simulation.log").writeBytes("x".toByteArray())
        val (srv, _) = startServer(status = 202)

        assertTrue(BundleUploader(logger = {}).upload(configFor(srv), tmp.toPath()))
    }

    @Test
    fun `500 is a failure -- returns false and logs a warning naming the status`(@TempDir tmp: File) {
        File(tmp, "simulation.log").writeBytes("x".toByteArray())
        val (srv, _) = startServer(status = 500, responseBody = "internal error, try later")
        val logs = mutableListOf<String>()

        val result = BundleUploader(logger = { logs.add(it) }).upload(configFor(srv), tmp.toPath())

        assertFalse(result)
        assertTrue(logs.any { it.contains("500") }, "expected a warning naming the 500 status, got: $logs")
    }
}
