package dev.vantrix.gradle

import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Watches [resultsRoot] for Gatling results directories that appear AFTER this tailer is
 * constructed, and streams each one's `simulation.log` through [api] as Gatling writes it -- one
 * live run per simulation directory, in order of first appearance.
 *
 * Recognition is snapshot-diff, not wall-clock: the constructor records the NAMES of every
 * directory already present under [resultsRoot], and a directory is treated as new iff its name
 * is absent from that snapshot AND has the shape Gatling uses for a results directory --
 * `<sim>-<digits>`, the digits taken from after the last `-` (a non-numeric suffix means it is
 * not a results directory, snapshot or not).
 *
 * Deliberately NOT wall-clock based -- an earlier version parsed that trailing `<digits>` as raw
 * epoch millis and excluded anything older than the task's start time. That looks reasonable but
 * is wrong for a REAL Gatling run: Gatling names its directories `<sim>-yyyyMMddHHmmssSSS`, a
 * *formatted* timestamp string (e.g. `paritysimulation-20260820134041213`) that still parses as a
 * valid `Long`, just roughly 11,000x larger than any actual `System.currentTimeMillis()` value
 * for the same instant. Every results directory a project has ever produced therefore parsed as
 * "from the future" and was treated as new on every subsequent run -- proven empirically: one
 * `gatlingRun` opened three separate platform runs from three accumulated stale directories.
 * Parsing `yyyyMMddHHmmssSSS` "properly" with a formatter would only trade that bug for a
 * timezone assumption (Gatling's formatting locale/zone across versions and machines is not a
 * documented contract, and is exactly the kind of thing that breaks silently). Snapshot-diff
 * sidesteps wall-clock reasoning entirely: the trailing digits are used only to recognise the
 * SHAPE of a results directory, never interpreted as a point in time.
 *
 * Single-threaded by design: [start] launches one daemon thread that owns the tick loop, and
 * every state mutation ([tick], [finish]) is taken under [lock] so [finish] -- normally called
 * from a different thread, the task's finalizer -- can never race a tick in flight.
 */
class RunTailer(
    private val api: LiveApi,
    private val config: PluginConfig,
    private val resultsRoot: Path,
    private val sleeper: (Long) -> Unit = Thread::sleep,
    private val logger: (String) -> Unit = {},
) {
    private val lock = ReentrantLock()

    // Names present under resultsRoot at construction time -- i.e. strictly before VantrixPlugin's
    // doFirst returns and Gatling's own task action can create anything new. Everything captured
    // here is permanently excluded from recognition, no matter how "new" its suffix looks.
    private val knownNames: MutableSet<String> = snapshotNames(resultsRoot).toMutableSet()

    // Directories discovered (not in knownNames, shape-matching) but not yet opened, in the order
    // they should be processed: order of first appearance across ticks, name-sorted within a tick.
    private val pending = ArrayDeque<Path>()

    private var current: TailState? = null
    private var authFailedPermanently = false

    // Written under [lock] (finish()) but read both under it (tick()) and outside it (start()'s
    // own loop, on the daemon thread, deciding whether to sleep and tick again). That outside
    // read is safe today only via the lock's own happens-before on the writing side; @Volatile
    // makes the visibility guarantee explicit rather than relying on that being true forever.
    @Volatile
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
     * it), then closes it -- then does the SAME for every simulation directory that never got a
     * tick of its own, including one whose directory appears only after `finish()` has already
     * started (each loop iteration re-discovers via [nextEligibleDir], which rescans
     * [resultsRoot]). Without this, a multi-simulation run whose last directory appears within one
     * tick of the task ending would never be opened at all -- not streamed, and absent from
     * [openFailures] too, so [uploadIfLiveUnavailable]'s fallback could not rescue it either.
     * Idempotent -- a second call is a no-op -- and clean when no directory ever appeared.
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

            while (!authFailedPermanently) {
                val next = nextEligibleDir() ?: break
                val opened = api.open(UUID.randomUUID().toString())
                if (opened == null) {
                    openFailures.add(next)
                    continue
                }
                val state = TailState(next.resolve("simulation.log"), opened)
                drain(state)
                api.close(state.run)
            }
        }
    }

    private fun maybeSwitchDirectory() {
        val next = nextEligibleDir() ?: return
        current?.let { state ->
            drain(state)
            api.close(state.run)
            current = null
        }
        val opened = api.open(UUID.randomUUID().toString())
        if (opened == null) {
            openFailures.add(next)
            return
        }
        current = TailState(next.resolve("simulation.log"), opened)
    }

    /**
     * Reads and ships one chunk (whatever bytes exist right now, capped at [MAX_CHUNK_BYTES]).
     * Audited for [drain]'s same hazard and found not to need its guard: this is a single
     * read+stream, never a loop, so a server stuck answering the same [StreamResult.Resume]
     * forever costs one wasted HTTP call per external `tick()` invocation -- gated by the daemon
     * thread's own `sleeper` interval, never a tight loop, and never inside the build's own
     * thread the way [drain] (called from `finish()`, synchronously, under [lock]) is.
     */
    private fun pumpOnce(state: TailState) {
        val bytes = readChunk(state.logFile, state.run.nextOffset)
        if (bytes.isEmpty()) return
        applyResult(state, api.stream(state.run, bytes))
    }

    /**
     * Repeats reads+streams while each read fully saturated the cap -- there may be more behind
     * it. Called synchronously from [finish], under [lock], inside `vantrixClose`'s `doLast` --
     * i.e. on the build's own thread, with nothing downstream to catch a loop that never ends.
     *
     * Progress-guarded for exactly that reason. A run the server no longer accepts writes for
     * (swept stale, or already closed -- see `apps/api/src/ingest/live.service.ts`'s `stream`)
     * answers every POST with 409 and an UNCHANGED `nextOffset` equal to the offset it was given.
     * The old loop treated that 409 as ordinary [StreamResult.Resume] progress and, with a full
     * [MAX_CHUNK_BYTES] backlog still on disk, re-read and re-sent the identical chunk forever:
     * the one outcome nothing here may ever produce. A round therefore counts as progress only
     * when the resulting offset is STRICTLY GREATER than the offset that round's chunk was sent
     * at; two CONSECUTIVE non-progress rounds abandon the drain (the caller still calls
     * [LiveApi.close] -- see [finish]). One non-progress round alone does not abandon: a genuine
     * rewind (offset negotiation resuming from an earlier point after a gap) also reports a
     * `nextOffset` that is not strictly greater than what was just sent, and must be allowed to
     * continue once the very next read -- now starting from that earlier offset -- moves forward
     * again and resets the counter. [MAX_DRAIN_ROUNDS] is a second, independent guard against the
     * same hang, for any future [StreamResult] shape this reasoning does not anticipate.
     */
    private fun drain(state: TailState) {
        var consecutiveNonProgress = 0
        var rounds = 0
        while (!authFailedPermanently) {
            rounds++
            if (rounds > MAX_DRAIN_ROUNDS) {
                logger("drain exceeded $MAX_DRAIN_ROUNDS rounds for run ${state.run.runId}; abandoning drain")
                return
            }
            val offsetBeforeSend = state.run.nextOffset
            val bytes = readChunk(state.logFile, offsetBeforeSend)
            if (bytes.isEmpty()) return
            val full = bytes.size == MAX_CHUNK_BYTES
            val progressed = applyResult(state, api.stream(state.run, bytes))
            if (!progressed) return
            if (state.run.nextOffset > offsetBeforeSend) {
                consecutiveNonProgress = 0
            } else {
                consecutiveNonProgress++
                if (consecutiveNonProgress >= 2) {
                    logger("server no longer accepting bytes for run ${state.run.runId}; abandoning drain")
                    return
                }
            }
            if (!full) return
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

    /**
     * Pops the next directory to process, discovering any newly-appeared ones first (see
     * [discoverNewDirs]). Returns null when nothing new has ever appeared beyond what's already
     * been processed.
     */
    private fun nextEligibleDir(): Path? {
        discoverNewDirs()
        return if (pending.isNotEmpty()) pending.removeFirst() else null
    }

    /**
     * Scans [resultsRoot] for directories not yet known (absent from the construction-time
     * snapshot AND never discovered before) whose name matches the results-dir shape, and
     * enqueues them onto [pending] in name order. Every enqueued name is added to [knownNames]
     * immediately, so it can never be rediscovered even after being dequeued and processed.
     */
    private fun discoverNewDirs() {
        if (!Files.isDirectory(resultsRoot)) return
        val entries = Files.newDirectoryStream(resultsRoot).use { it.toList() }
        entries
            .filter { Files.isDirectory(it) }
            .map { it.fileName.toString() to it }
            .filter { (name, _) -> name !in knownNames && matchesResultsDirShape(name) }
            .sortedBy { it.first }
            .forEach { (name, path) ->
                knownNames += name
                pending.addLast(path)
            }
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

        // Belt-and-braces cap on drain()'s round count -- independent of the progress guard, so a
        // future StreamResult shape the guard doesn't anticipate still cannot hang the build.
        // 1024 rounds at MAX_CHUNK_BYTES each is 4 GiB, comfortably above any real backlog (the
        // server's own per-run size cap, MAX_BUNDLE_BYTES, defaults to 512 MiB -- 128 rounds).
        const val MAX_DRAIN_ROUNDS = 1024

        // Gatling's own results-directory shape: <sim>-<digits>, digits taken from after the LAST
        // '-'. Matched only to recognise the SHAPE of a results directory -- the digits are never
        // parsed as a number, let alone a timestamp; see the class doc for why.
        private val RESULTS_DIR_SHAPE = Regex("^.+-\\d+$")

        private fun matchesResultsDirShape(dirName: String): Boolean = RESULTS_DIR_SHAPE.matches(dirName)

        private fun snapshotNames(resultsRoot: Path): Set<String> {
            if (!Files.isDirectory(resultsRoot)) return emptySet()
            val entries = Files.newDirectoryStream(resultsRoot).use { it.toList() }
            return entries.filter { Files.isDirectory(it) }.map { it.fileName.toString() }.toSet()
        }
    }
}
