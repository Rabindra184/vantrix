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
 * The only component that talks to the server: opens a live run, streams chunks against an
 * offset-negotiated cursor, and closes the run when done.
 */
class LiveClient(
    private val config: PluginConfig,
    private val logger: (String) -> Unit,
    private val backoffMs: LongArray = longArrayOf(1000, 2000, 4000),
) {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /** POSTs `/v1/runs/live`. Returns null on ANY failure -- already logged, never throws. */
    fun open(idempotencyKey: String): OpenedRun? {
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
    fun stream(run: OpenedRun, bytes: ByteArray): StreamResult {
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
    fun close(run: OpenedRun): Boolean {
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
        val ms = if (attempt < backoffMs.size) backoffMs[attempt] else backoffMs.lastOrNull() ?: 0L
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
