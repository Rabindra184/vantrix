package dev.vantrix.gradle

import com.google.gson.JsonParser
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * Pairs a Gatling results directory with the agent file its simulation JVM wrote.
 *
 * Upstream Gatling's Gradle plugin starts ONE JVM PER SIMULATION, one after another, and each
 * writes its own `agent-<pid>-<millis>.ndjson` (or `agent-<millis>.ndjson`) into
 * [AgentRun.outDir]. The NAME is never parsed: what identifies a file is its header, the first
 * line, whose `startedAt` is the instant that JVM's agent started.
 *
 * A JVM writes its header in premain, then Gatling creates the results directory and writes
 * into it until the JVM exits; the next JVM starts after that. So the file a directory belongs
 * to is the one with the LARGEST `startedAt` not after the directory's last write -- allowing
 * [ALLOWANCE_MS] for a coarse file-system clock -- and not before [AgentRun.notBeforeMs], the
 * instant this `gatlingRun` began, before which no file can be this run's.
 *
 * An empty file, one whose first line is not a header with a numeric `startedAt`, or one that
 * cannot be read is skipped. Only the first line is read, and at most [MAX_HEADER_BYTES] of it:
 * an agent file can reach 256 MiB, and a header is a few hundred bytes.
 *
 * Never throws: anything unreadable is simply not a candidate, and a directory with no candidate
 * pairs with nothing.
 */
object AgentFiles {
    private const val ALLOWANCE_MS = 1000L
    private const val MAX_HEADER_BYTES = 64 * 1024
    private val NAME = Regex("^agent-.*\\.ndjson$")

    fun pairFor(agent: AgentRun, resultsDir: Path): Path? =
        try {
            val latest = Files.getLastModifiedTime(resultsDir).toMillis() + ALLOWANCE_MS
            candidates(agent.outDir)
                .mapNotNull { file -> startedAt(file)?.let { file to it } }
                .filter { (_, startedAt) -> startedAt >= agent.notBeforeMs && startedAt <= latest }
                .maxByOrNull { (_, startedAt) -> startedAt }
                ?.first
        } catch (e: Exception) {
            null
        }

    private fun candidates(outDir: Path): List<Path> {
        if (!Files.isDirectory(outDir)) return emptyList()
        return Files.newDirectoryStream(outDir).use { stream ->
            stream.filter { NAME.matches(it.fileName.toString()) && Files.isRegularFile(it) }
        }
    }

    /** The header's `startedAt`, or null when the first line is not a header carrying a numeric one. */
    private fun startedAt(file: Path): Long? {
        try {
            val line = Files.newInputStream(file).use { firstLine(it) } ?: return null
            val json = JsonParser.parseString(line)
            if (!json.isJsonObject) return null
            val obj = json.asJsonObject
            val t = obj.get("t")
            if (t == null || !t.isJsonPrimitive || t.asString != "header") return null
            val startedAt = obj.get("startedAt")
            if (startedAt == null || !startedAt.isJsonPrimitive || !startedAt.asJsonPrimitive.isNumber) return null
            return startedAt.asLong
        } catch (e: Exception) {
            return null
        }
    }

    /**
     * The bytes before the first newline, read at most [MAX_HEADER_BYTES] at a time. A file that
     * ends without one is its own first line; a first line longer than the bound is no header.
     */
    private fun firstLine(input: InputStream): String? {
        val buf = input.readNBytes(MAX_HEADER_BYTES + 1)
        if (buf.isEmpty()) return null
        val newline = buf.indexOf('\n'.code.toByte())
        val end = when {
            newline >= 0 -> newline
            buf.size > MAX_HEADER_BYTES -> return null
            else -> buf.size
        }
        return String(buf, 0, end, StandardCharsets.UTF_8).trimEnd('\r')
    }
}
