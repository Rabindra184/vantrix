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
 * The rule: the file a directory belongs to is the one with the LARGEST `startedAt` such that
 * `lower < startedAt <= the directory's last-modified time`, among files not already paired with
 * another run of this `gatlingRun` ([AgentRun.paired]). A JVM writes its header in premain, then
 * Gatling creates the results directory and writes into it until the JVM exits; the next JVM
 * starts after that. So a run's file started after the PREVIOUS simulation's directory was last
 * written, and `lower` is that instant: the latest last-modified time among this `gatlingRun`'s
 * other results directories -- the directories beside this one, under the same results root,
 * last written after [AgentRun.notBeforeMs] -- that is earlier than this directory's own. With
 * no such directory (the first simulation), the bound is [AgentRun.notBeforeMs] itself, the
 * instant this `gatlingRun` began, and inclusive: `notBeforeMs <= startedAt`.
 *
 * THE LOWER BOUND matters in exactly one case: this run's own file is missing -- its JVM died
 * before premain wrote the header, or the agent could not write at all. (A JVM that died AFTER
 * writing its header still has its file.) [AgentRun.paired] keeps an earlier run's file from
 * being taken twice, but an earlier run's file that was never claimed -- that run's live run
 * never opened and the fallback is off, so nothing paired its directory -- would otherwise be
 * the largest candidate left, and this run would carry another simulation's data. With the
 * bound, it pairs nothing.
 *
 * THERE IS NO SLACK on the upper bound, deliberately. Gatling writes its report files into the
 * directory right before its JVM exits, and the next simulation's JVM writes its header well
 * under a second later -- so any allowance past the directory's last write (an earlier version
 * had 1000 ms) lets run k take run k+1's file. Both instants come from the same machine's clock,
 * so none is needed. And a file is paired at most once: even a file that slipped inside a window
 * could not then be sent to two runs.
 *
 * An empty file, one whose first line is not a header with a numeric `startedAt`, or one that
 * cannot be read is skipped. Only the first line is read, and at most [MAX_HEADER_BYTES] of it:
 * an agent file can reach 256 MiB, and a header is a few hundred bytes.
 *
 * Never throws: anything unreadable is simply not a candidate, and a directory with no candidate
 * pairs with nothing.
 */
object AgentFiles {
    private const val MAX_HEADER_BYTES = 64 * 1024
    private val NAME = Regex("^agent-.*\\.ndjson$")

    /** Pairs [resultsDir] with its file and records the pairing in [AgentRun.paired]; null when none. */
    fun pairFor(agent: AgentRun, resultsDir: Path): Path? =
        try {
            val latest = Files.getLastModifiedTime(resultsDir).toMillis()
            val previous = previousDirectoryWrite(agent, resultsDir, latest)
            val eligible = candidates(agent.outDir)
                .mapNotNull { file -> startedAt(file)?.let { file to it } }
                .filter { (_, startedAt) ->
                    startedAt >= agent.notBeforeMs && (previous == null || startedAt > previous) && startedAt <= latest
                }
                .sortedByDescending { (_, startedAt) -> startedAt }
                .map { (file, _) -> file }
            // Claimed under the set's own monitor: the first eligible file nobody has paired yet.
            synchronized(agent.paired) { eligible.firstOrNull { agent.paired.add(it) } }
        } catch (e: Exception) {
            null
        }

    /**
     * The previous simulation's directory's last write: the latest last-modified time, below
     * [latest], among the directories beside [resultsDir] last written after
     * [AgentRun.notBeforeMs]; null when there is none (the first simulation of this `gatlingRun`).
     */
    private fun previousDirectoryWrite(agent: AgentRun, resultsDir: Path, latest: Long): Long? {
        val root = resultsDir.toAbsolutePath().parent ?: return null
        val self = resultsDir.toAbsolutePath().normalize()
        return Files.newDirectoryStream(root).use { stream ->
            stream
                .filter { it.toAbsolutePath().normalize() != self && Files.isDirectory(it) }
                .map { Files.getLastModifiedTime(it).toMillis() }
                .filter { it > agent.notBeforeMs && it < latest }
                .maxOrNull()
        }
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
