package dev.vantrix.gradle

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/** A run opened for live streaming: its id, the ABSOLUTE URL to stream chunks to, and the next byte offset expected. */
data class OpenedRun(val runId: String, val streamUrl: String, var nextOffset: Long)

/** Outcome of one `stream(...)` call. */
sealed class StreamResult {
    data class Advanced(val nextOffset: Long) : StreamResult()
    data class Resume(val nextOffset: Long) : StreamResult()
    object AuthFailed : StreamResult()
    object GaveUp : StreamResult()
}

/**
 * The subset of [LiveClient]'s surface a consumer needs to drive a live run -- extracted so
 * [RunTailer] (and its tests) can depend on this instead of a concrete HTTP implementation.
 */
interface LiveApi {
    /** POSTs `/v1/runs/live`. Returns null on ANY failure -- already logged, never throws. */
    fun open(idempotencyKey: String): OpenedRun?

    /** Streams one chunk against `run`'s current offset. See [LiveClient.stream] for the full contract. */
    fun stream(run: OpenedRun, bytes: ByteArray): StreamResult

    /** POSTs `/v1/runs/{id}/close`. True on success or if the run was already closed. */
    fun close(run: OpenedRun): Boolean
}

/**
 * The only component that talks to the server: opens a live run, streams chunks against an
 * offset-negotiated cursor, and closes the run when done.
 */
class LiveClient(
    private val config: PluginConfig,
    private val logger: (String) -> Unit,
    // Only indices [0, MAX_ATTEMPTS - 2] are ever read (see stream()'s "attempt < MAX_ATTEMPTS -
    // 1" guard around sleepBackoff) -- a third element here was dead with MAX_ATTEMPTS == 3.
    // sleepBackoff itself is index-safe regardless of this array's length (getOrElse), so this
    // default and MAX_ATTEMPTS cannot silently drift apart again the way [1000, 2000, 4000] and
    // MAX_ATTEMPTS == 3 already had.
    private val backoffMs: LongArray = longArrayOf(1000, 2000),
) : LiveApi {
    // HTTP_1_1, explicitly -- java.net.http.HttpClient's DEFAULT version preference is HTTP_2,
    // which for a cleartext "http://" URI means it first tries an h2c (HTTP/2-over-cleartext)
    // upgrade: the initial request carries `Connection: Upgrade` / `HTTP2-Settings` on top of a
    // plain HTTP/1.1 request. Node's http server (what NestJS's platform-express sits on) does
    // not speak h2c and, against this exact upgrade attempt, resets the connection after zero
    // response bytes -- observed as `IOException: http1_0 content, bytes received: 0` wrapping a
    // `SocketException: Connection reset`, on EVERY call, against the real API. The plugin's own
    // fake-server tests (LiveClientTest, VantrixPluginFunctionalTest) never caught this: both use
    // `com.sun.net.httpserver.HttpServer`, which tolerates the same upgrade headers a real Node
    // server does not. Forcing HTTP_1_1 here removes the upgrade attempt entirely.
    // Caveat: this also forecloses ALPN-negotiated h2 against a future HTTPS endpoint (ALPN, not
    // h2c, is how a TLS connection would normally get HTTP/2) -- accepted because the platform's
    // live endpoints are plain HTTP (Node) today, and h2c is exactly what resets the connection
    // above. Revisit this pin if/when the live endpoints move behind TLS.
    private val http: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /** POSTs `/v1/runs/live`. Returns null on ANY failure -- already logged, never throws. */
    override fun open(idempotencyKey: String): OpenedRun? {
        return try {
            val payload = JsonObject().apply {
                addProperty("tool", "gatling")
                config.environment?.let { addProperty("environment", it) }
                config.branch?.let { addProperty("branch", it) }
                config.commitSha?.let { addProperty("commitSha", it) }
                addProperty("idempotencyKey", idempotencyKey)
            }
            val request = HttpRequest.newBuilder(URI.create("${config.baseUrl}/v1/runs/live"))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer ${config.token}")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload.toString(), StandardCharsets.UTF_8))
                .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() != 201) {
                logFailure("open", response)
                return null
            }
            val body = JsonParser.parseString(response.body()).asJsonObject
            val runId = body.get("runId").asString
            val relativeStreamUrl = body.get("streamUrl").asString
            val nextOffset = body.get("nextOffset").asLong
            val resolvedStreamUrl = URI.create(config.baseUrl).resolve(relativeStreamUrl).toString()
            // The one line a human (or an e2e script grepping the build log) can use to find
            // this run without instrumenting the plugin further -- runId for exact matching,
            // the web app's run-detail URL (`/runs/{id}`, apps/web's `runPath()`) for a click.
            logger("run opened: $runId -> ${config.baseUrl}/runs/$runId")
            OpenedRun(runId, resolvedStreamUrl, nextOffset)
        } catch (e: Exception) {
            logger("open failed: ${e.message}")
            null
        }
    }

    /**
     * POSTs a chunk to `run.streamUrl` carrying `run.nextOffset` as `X-Stream-Offset`.
     * Retries up to [MAX_ATTEMPTS] times, with [backoffMs] between attempts, on IOException or a
     * 5xx response. Never retries 401/403 (-> [StreamResult.AuthFailed]) or 409 (-> [StreamResult.Resume]):
     * both return after exactly one request.
     */
    override fun stream(run: OpenedRun, bytes: ByteArray): StreamResult {
        for (attempt in 0 until MAX_ATTEMPTS) {
            val response = try {
                http.send(buildStreamRequest(run, bytes), HttpResponse.BodyHandlers.ofString())
            } catch (e: IOException) {
                logger("stream attempt ${attempt + 1} failed: ${e.message}")
                if (attempt < MAX_ATTEMPTS - 1) sleepBackoff(attempt)
                continue
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                logger("stream attempt ${attempt + 1} interrupted")
                return StreamResult.GaveUp
            }

            when {
                response.statusCode() == 202 ->
                    return StreamResult.Advanced(parseNextOffset(response.body()))
                response.statusCode() == 409 ->
                    return StreamResult.Resume(parseNextOffset(response.body()))
                response.statusCode() == 401 || response.statusCode() == 403 -> {
                    logFailure("stream", response)
                    return StreamResult.AuthFailed
                }
                response.statusCode() in 500..599 -> {
                    logger("stream attempt ${attempt + 1} failed: HTTP ${response.statusCode()}")
                    if (attempt < MAX_ATTEMPTS - 1) sleepBackoff(attempt)
                }
                else -> {
                    logFailure("stream", response)
                    return StreamResult.GaveUp
                }
            }
        }
        return StreamResult.GaveUp
    }

    /** POSTs `/v1/runs/{id}/close`. True on 2xx, or on a 409 whose `code` is `RUN_NOT_RUNNING` (already closed). */
    override fun close(run: OpenedRun): Boolean {
        return try {
            val request = HttpRequest.newBuilder(URI.create("${config.baseUrl}/v1/runs/${run.runId}/close"))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer ${config.token}")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofString())
            when {
                response.statusCode() in 200..299 -> true
                response.statusCode() == 409 && parseCode(response.body()) == "RUN_NOT_RUNNING" -> true
                else -> {
                    logFailure("close", response)
                    false
                }
            }
        } catch (e: Exception) {
            logger("close failed: ${e.message}")
            false
        }
    }

    private fun buildStreamRequest(run: OpenedRun, bytes: ByteArray): HttpRequest =
        HttpRequest.newBuilder(URI.create(run.streamUrl))
            .timeout(Duration.ofSeconds(30))
            .header("Authorization", "Bearer ${config.token}")
            .header("Content-Type", "application/octet-stream")
            .header("X-Stream-Offset", run.nextOffset.toString())
            .POST(HttpRequest.BodyPublishers.ofByteArray(bytes))
            .build()

    private fun sleepBackoff(attempt: Int) {
        val ms = backoffMs.getOrElse(attempt) { backoffMs.lastOrNull() ?: 0L }
        if (ms > 0) {
            try {
                Thread.sleep(ms)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    /** Logs status + either the problem body's `remediation` verbatim, or the first 200 chars of a non-JSON body. */
    private fun logFailure(op: String, response: HttpResponse<String>) {
        val body = response.body().orEmpty()
        val remediation = parseJsonObjectOrNull(body)
            ?.get("remediation")
            ?.takeIf { it.isJsonPrimitive }
            ?.asString
        val detail = remediation ?: body.take(200)
        logger("$op failed: HTTP ${response.statusCode()} - $detail")
    }

    private fun parseJsonObjectOrNull(body: String): JsonObject? =
        try {
            JsonParser.parseString(body).takeIf { it.isJsonObject }?.asJsonObject
        } catch (e: Exception) {
            null
        }

    private fun parseCode(body: String): String? =
        parseJsonObjectOrNull(body)?.get("code")?.takeIf { it.isJsonPrimitive }?.asString

    private fun parseNextOffset(body: String): Long =
        try {
            parseJsonObjectOrNull(body)?.get("nextOffset")?.asLong ?: 0L
        } catch (e: Exception) {
            0L
        }

    companion object {
        private const val MAX_ATTEMPTS = 3
    }
}
