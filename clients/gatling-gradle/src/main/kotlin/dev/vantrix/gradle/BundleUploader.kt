package dev.vantrix.gradle

import com.google.gson.JsonObject
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.SequenceInputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.Collections
import java.util.UUID
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream

/**
 * The `uploadIfLiveUnavailable` fallback: when a simulation's live run could never be opened
 * (`RunTailer.openFailures()`), its finished `simulation.log` would otherwise just be lost. This
 * tars that one file as `run-1/simulation.log`, gzips the tar, and POSTs it as a batch bundle to
 * `{base}/v1/runs` -- the same ingest endpoint a manual upload would use -- so the run shows up
 * late instead of not at all.
 *
 * Strictly one-shot: no retries. The gating (flag on AND an open failure) lives in
 * [VantrixPlugin]'s finalizer, not here -- this class always uploads when asked.
 *
 * Everything below is STREAMED through a temp file rather than buffered in memory. Gradle's
 * default daemon heap is 512m; a soak-test `simulation.log` in the hundreds of MB would otherwise
 * sit in memory up to three times over at once (raw bytes, the tar+gzip buffer, the multipart body
 * buffer), enough to OOM a long-lived daemon that unrelated future builds go on to reuse. An
 * `OutOfMemoryError` is a [Throwable], not an `Exception` -- it would sail past this class's own
 * `catch (Exception)` too, which is one more reason never to hold the whole file at once rather
 * than just documenting the risk.
 */
class BundleUploader(
    private val logger: (String) -> Unit = {},
) {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /**
     * Tars and gzips `resultsDir/simulation.log` to a temp file, then streams it as the `bundle`
     * part of a two-part multipart body (`metadata` JSON, `bundle` file) POSTed to
     * `{base}/v1/runs`. Returns true on 202 (accepted -- the worker processes it later); false on
     * any other response status, on a log over [MAX_BUNDLE_BYTES], or on any thrown `Exception` --
     * all three are caught and logged here. This never fails the BUILD: a `Throwable` that isn't
     * an `Exception` (e.g. an `OutOfMemoryError`) can still escape this method, but the caller
     * (`VantrixPlugin`'s finalizer) wraps every call site in its own `catch (Throwable)`, which is
     * the actual backstop.
     */
    fun upload(config: PluginConfig, resultsDir: Path): Boolean {
        val logFile = resultsDir.resolve("simulation.log")
        return try {
            val logSize = Files.size(logFile)
            if (logSize > MAX_BUNDLE_BYTES) {
                logger(
                    "upload skipped: simulation.log is $logSize bytes, over the server's " +
                        "$MAX_BUNDLE_BYTES-byte bundle cap (it would answer 413 anyway)",
                )
                return false
            }
            val tmpBundle = Files.createTempFile("vantrix-bundle-", ".tgz")
            try {
                writeBundle(logFile, logSize, tmpBundle)
                postBundle(config, tmpBundle)
            } finally {
                Files.deleteIfExists(tmpBundle)
            }
        } catch (e: Exception) {
            logger("upload failed: ${e.message}")
            false
        }
    }

    private fun postBundle(config: PluginConfig, bundleFile: Path): Boolean {
        val boundary = "----vantrix-${UUID.randomUUID()}"
        val prefix = multipartPrefix(boundary, metadataJson(config))
        val suffix = multipartSuffix(boundary)
        // A fresh three-way stream per call -- BodyPublishers.ofInputStream's supplier may be
        // invoked more than once (e.g. on a retried send), and `bundleFile` is still on disk at
        // that point (deleted only once `upload`'s own `finally` runs).
        val bodyPublisher = HttpRequest.BodyPublishers.ofInputStream {
            SequenceInputStream(
                Collections.enumeration(
                    listOf<InputStream>(
                        ByteArrayInputStream(prefix),
                        Files.newInputStream(bundleFile),
                        ByteArrayInputStream(suffix),
                    ),
                ),
            )
        }
        val request = HttpRequest.newBuilder(URI.create("${config.baseUrl}/v1/runs"))
            .timeout(Duration.ofSeconds(60))
            .header("Authorization", "Bearer ${config.token}")
            .header("Content-Type", "multipart/form-data; boundary=$boundary")
            .POST(bodyPublisher)
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        return if (response.statusCode() == 202) {
            true
        } else {
            logger("upload failed: HTTP ${response.statusCode()} - ${response.body().orEmpty().take(200)}")
            false
        }
    }

    /** `{"tool":"gatling","waitMs":0}` plus `environment`/`branch`/`commitSha` -- ONLY when non-null. */
    private fun metadataJson(config: PluginConfig): String {
        val obj = JsonObject().apply {
            addProperty("tool", "gatling")
            addProperty("waitMs", 0)
            config.environment?.let { addProperty("environment", it) }
            config.branch?.let { addProperty("branch", it) }
            config.commitSha?.let { addProperty("commitSha", it) }
        }
        return obj.toString()
    }

    /**
     * Writes a gzip stream to [tmpBundle] wrapping a tar with exactly one entry:
     * `run-1/simulation.log`. Streams [logFile] in through an 8 KiB (default) buffer -- never
     * holds it whole in memory.
     */
    private fun writeBundle(logFile: Path, logSize: Long, tmpBundle: Path) {
        Files.newOutputStream(tmpBundle).use { fileOut ->
            GzipCompressorOutputStream(BufferedOutputStream(fileOut)).use { gz ->
                TarArchiveOutputStream(gz).use { tar ->
                    val entry = TarArchiveEntry("run-1/simulation.log")
                    entry.size = logSize
                    tar.putArchiveEntry(entry)
                    Files.newInputStream(logFile).use { it.copyTo(tar) }
                    tar.closeArchiveEntry()
                }
            }
        }
    }

    /** Everything before the `bundle` part's file bytes: the whole `metadata` part, then the `bundle` part's own headers. */
    private fun multipartPrefix(boundary: String, metadataJson: String): ByteArray {
        val text = buildString {
            append("--$boundary\r\n")
            append("Content-Disposition: form-data; name=\"metadata\"\r\n")
            append("\r\n")
            append(metadataJson)
            append("\r\n")
            append("--$boundary\r\n")
            append("Content-Disposition: form-data; name=\"bundle\"; filename=\"bundle.tgz\"\r\n")
            append("Content-Type: application/gzip\r\n")
            append("\r\n")
        }
        return text.toByteArray(StandardCharsets.UTF_8)
    }

    /** The CRLF that must close the `bundle` part's file bytes, then the closing boundary. */
    private fun multipartSuffix(boundary: String): ByteArray =
        "\r\n--$boundary--\r\n".toByteArray(StandardCharsets.UTF_8)

    companion object {
        /**
         * Matches the server's own bundle cap (`apps/api/src/config.ts`'s `maxBundleBytes`,
         * `512 * 1024 * 1024` by default) -- a log bigger than this would answer 413 from the
         * server anyway, so there is no point streaming it there first.
         */
        private const val MAX_BUNDLE_BYTES = 512L * 1024 * 1024
    }
}
