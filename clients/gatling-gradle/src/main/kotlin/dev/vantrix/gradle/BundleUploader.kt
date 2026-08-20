package dev.vantrix.gradle

import com.google.gson.JsonObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
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
 */
class BundleUploader(
    private val logger: (String) -> Unit = {},
) {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /**
     * Tars and gzips `resultsDir/simulation.log`, then POSTs it as a two-part multipart body
     * (`metadata` JSON, `bundle` file) to `{base}/v1/runs`. Returns true on 202 (accepted -- the
     * worker processes it later); any other response status, or any thrown exception, logs ONE
     * warning and returns false. Never throws.
     */
    fun upload(config: PluginConfig, resultsDir: Path): Boolean {
        return try {
            val bundleBytes = buildBundle(resultsDir.resolve("simulation.log"))
            val boundary = "----vantrix-${UUID.randomUUID()}"
            val body = buildMultipartBody(boundary, metadataJson(config), bundleBytes)
            val request = HttpRequest.newBuilder(URI.create("${config.baseUrl}/v1/runs"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer ${config.token}")
                .header("Content-Type", "multipart/form-data; boundary=$boundary")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() == 202) {
                true
            } else {
                logger("upload failed: HTTP ${response.statusCode()} - ${response.body().orEmpty().take(200)}")
                false
            }
        } catch (e: Exception) {
            logger("upload failed: ${e.message}")
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

    /** A gzip stream wrapping a tar with exactly one entry: `run-1/simulation.log`. */
    private fun buildBundle(logFile: Path): ByteArray {
        val logBytes = Files.readAllBytes(logFile)
        val buffer = ByteArrayOutputStream()
        GzipCompressorOutputStream(buffer).use { gz ->
            TarArchiveOutputStream(gz).use { tar ->
                val entry = TarArchiveEntry("run-1/simulation.log")
                entry.size = logBytes.size.toLong()
                tar.putArchiveEntry(entry)
                tar.write(logBytes)
                tar.closeArchiveEntry()
            }
        }
        return buffer.toByteArray()
    }

    /**
     * Hand-built multipart/form-data body -- the JDK has no encoder for this. CRLF discipline
     * matters: a missing one makes busboy on the server side drop the part silently.
     */
    private fun buildMultipartBody(boundary: String, metadataJson: String, bundleBytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        fun write(s: String) = out.write(s.toByteArray(StandardCharsets.UTF_8))

        write("--$boundary\r\n")
        write("Content-Disposition: form-data; name=\"metadata\"\r\n")
        write("\r\n")
        write(metadataJson)
        write("\r\n")

        write("--$boundary\r\n")
        write("Content-Disposition: form-data; name=\"bundle\"; filename=\"bundle.tgz\"\r\n")
        write("Content-Type: application/gzip\r\n")
        write("\r\n")
        out.write(bundleBytes)
        write("\r\n")

        write("--$boundary--\r\n")
        return out.toByteArray()
    }
}
