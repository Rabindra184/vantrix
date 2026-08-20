package dev.vantrix.gradle

import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Watches [resultsRoot] for Gatling results directories created at or after [taskStartMillis] and
 * streams each one's `simulation.log` through [api] as Gatling writes it -- one live run per
 * simulation directory, in creation order.
 *
 * A directory is recognised by Gatling's own `<sim>-<millis>` naming: the millis are parsed from
 * after the LAST `-`; a non-numeric suffix means it is not a results directory.
 *
 * Single-threaded by design: [start] launches one daemon thread that owns the tick loop, and
 * every state mutation ([tick], [finish]) is taken under [lock] so [finish] -- normally called
 * from a different thread, the task's finalizer -- can never race a tick in flight.
 */
class RunTailer(
    private val api: LiveApi,
    private val config: PluginConfig,
    private val resultsRoot: Path,
    private val taskStartMillis: Long,
    private val sleeper: (Long) -> Unit = Thread::sleep,
) {
    private val lock = ReentrantLock()

    private var current: TailState? = null
    private var lastConsideredMillis: Long = taskStartMillis - 1
    private var authFailedPermanently = false
    private var finished = false
    private val openFailures = mutableListOf<Path>()

    private class TailState(val logFile: Path, val run: OpenedRun)

    /** Starts the daemon polling thread: tick immediately, then tick again every `tickSeconds`. */
    fun start(): Thread {
        val thread = Thread({
            while (true) {
                tick()
                if (finished) break
                sleeper(config.tickSeconds * 1000L)
            }
        }, "vantrix-tailer")
        thread.isDaemon = true
        thread.start()
        return thread
    }

    /** Every directory whose `open()` call failed -- the fallback-upload branch reads this after [finish]. */
    fun openFailures(): List<Path> = lock.withLock { openFailures.toList() }

    /**
     * One polling iteration: switch to a newer directory if one has appeared (closing the
     * current run first), then pump whatever bytes are now waiting for the currently open run.
     * A no-op once [finish] has run, or once a [StreamResult.AuthFailed] has been seen.
     */
    internal fun tick() {
        lock.withLock {
            if (finished || authFailedPermanently) return
            maybeSwitchDirectory()
            current?.let { pumpOnce(it) }
        }
    }

    /**
     * Final flush of the currently open run (looping while a full read means more may be behind
     * it), then closes it. Idempotent -- a second call is a no-op -- and clean when no directory
     * ever appeared.
     */
    fun finish() {
        lock.withLock {
            if (finished) return
            finished = true
            current?.let { state ->
                drain(state)
                api.close(state.run)
            }
            current = null
        }
    }

    private fun maybeSwitchDirectory() {
        val next = nextEligibleDir() ?: return
        current?.let { state ->
            drain(state)
            api.close(state.run)
            current = null
        }
        lastConsideredMillis = next.first
        val opened = api.open(UUID.randomUUID().toString())
        if (opened == null) {
            openFailures.add(next.second)
            return
        }
        current = TailState(next.second.resolve("simulation.log"), opened)
    }

    /** Reads and ships one chunk (whatever bytes exist right now, capped at [MAX_CHUNK_BYTES]). */
    private fun pumpOnce(state: TailState) {
        val bytes = readChunk(state.logFile, state.run.nextOffset)
        if (bytes.isEmpty()) return
        applyResult(state, api.stream(state.run, bytes))
    }

    /** Repeats reads+streams while each read fully saturated the cap -- there may be more behind it. */
    private fun drain(state: TailState) {
        while (!authFailedPermanently) {
            val bytes = readChunk(state.logFile, state.run.nextOffset)
            if (bytes.isEmpty()) return
            val full = bytes.size == MAX_CHUNK_BYTES
            val progressed = applyResult(state, api.stream(state.run, bytes))
            if (!progressed || !full) return
        }
    }

    /** Applies a [StreamResult] to [state]'s offset. Returns false when nothing further should be attempted. */
    private fun applyResult(state: TailState, result: StreamResult): Boolean =
        when (result) {
            is StreamResult.Advanced -> {
                state.run.nextOffset = result.nextOffset
                true
            }
            is StreamResult.Resume -> {
                state.run.nextOffset = result.nextOffset
                true
            }
            StreamResult.AuthFailed -> {
                authFailedPermanently = true
                false
            }
            StreamResult.GaveUp -> false
        }

    private fun nextEligibleDir(): Pair<Long, Path>? =
        listEligibleDirs().firstOrNull { it.first > lastConsideredMillis }

    private fun listEligibleDirs(): List<Pair<Long, Path>> {
        if (!Files.isDirectory(resultsRoot)) return emptyList()
        val entries = Files.newDirectoryStream(resultsRoot).use { it.toList() }
        return entries
            .filter { Files.isDirectory(it) }
            .mapNotNull { dir ->
                val millis = parseMillis(dir.fileName.toString()) ?: return@mapNotNull null
                if (millis < taskStartMillis) null else millis to dir
            }
            .sortedBy { it.first }
    }

    private fun readChunk(logFile: Path, offset: Long): ByteArray {
        if (!Files.exists(logFile)) return ByteArray(0)
        RandomAccessFile(logFile.toFile(), "r").use { raf ->
            val length = raf.length()
            if (offset >= length) return ByteArray(0)
            val toRead = minOf(MAX_CHUNK_BYTES.toLong(), length - offset)
            val buf = ByteArray(toRead.toInt())
            raf.seek(offset)
            raf.readFully(buf)
            return buf
        }
    }

    companion object {
        const val MAX_CHUNK_BYTES = 4 * 1024 * 1024

        private fun parseMillis(dirName: String): Long? {
            val idx = dirName.lastIndexOf('-')
            if (idx < 0 || idx == dirName.length - 1) return null
            return dirName.substring(idx + 1).toLongOrNull()
        }
    }
}
