package dev.vantrix.gradle

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir
import kotlin.test.*

class RunTailerTest {

    // FakeApi records every open/stream/close call in order and returns scripted results;
    // absent a script it auto-succeeds (open) or auto-advances by the chunk size (stream).
    private sealed class ApiCall {
        data class OpenAttempt(val idempotencyKey: String) : ApiCall()
        data class OpenSucceeded(val runId: String) : ApiCall()
        object OpenFailed : ApiCall()
        data class StreamCalled(val runId: String, val offset: Long, val byteCount: Int) : ApiCall()
        data class Closed(val runId: String) : ApiCall()
    }

    private class FakeApi : LiveApi {
        val calls = mutableListOf<ApiCall>()

        private val openOutcomes = ArrayDeque<Boolean>()
        private val streamOutcomes = ArrayDeque<StreamResult?>()
        private var stickyStreamOutcome: StreamResult? = null
        private var runCounter = 0

        fun failNextOpen() {
            openOutcomes.addLast(false)
        }

        fun scriptNextStream(result: StreamResult) {
            streamOutcomes.addLast(result)
        }

        /** Every stream() call with no (or exhausted) scripted outcome returns this, forever. */
        fun alwaysReturnFromStream(result: StreamResult) {
            stickyStreamOutcome = result
        }

        fun streamCalls(): List<ApiCall.StreamCalled> = calls.filterIsInstance<ApiCall.StreamCalled>()

        override fun open(idempotencyKey: String): OpenedRun? {
            calls += ApiCall.OpenAttempt(idempotencyKey)
            val succeed = if (openOutcomes.isNotEmpty()) openOutcomes.removeFirst() else true
            if (!succeed) {
                calls += ApiCall.OpenFailed
                return null
            }
            runCounter++
            val runId = "run-$runCounter"
            calls += ApiCall.OpenSucceeded(runId)
            return OpenedRun(runId, "http://fake/$runId/stream", 0L)
        }

        override fun stream(run: OpenedRun, bytes: ByteArray): StreamResult {
            calls += ApiCall.StreamCalled(run.runId, run.nextOffset, bytes.size)
            val scripted = if (streamOutcomes.isNotEmpty()) streamOutcomes.removeFirst() else null
            return scripted ?: stickyStreamOutcome ?: StreamResult.Advanced(run.nextOffset + bytes.size)
        }

        override fun close(run: OpenedRun): Boolean {
            calls += ApiCall.Closed(run.runId)
            return true
        }
    }

    private fun configFor(): PluginConfig = PluginConfig(
        baseUrl = "http://unused", token = "unused",
        environment = null, branch = null, commitSha = null,
        tickSeconds = 5, uploadIfLiveUnavailable = false, resultsDir = null,
    )

    private fun writeLog(dir: Path, size: Int) {
        Files.write(dir.resolve("simulation.log"), ByteArray(size))
    }

    // Real Gatling results-directory naming: <sim>-yyyyMMddHHmmssSSS -- a FORMATTED timestamp
    // string, not raw epoch millis. These fixtures encode that shape throughout (rather than the
    // old "fake-" + System.currentTimeMillis() the unit suite used to use, which happened to also
    // be valid epoch millis and so never exercised the real-world mismatch).
    private fun realDirName(suffix: String) = "paritysimulation-$suffix"

    @Test fun `a pre-existing real-format directory is ignored forever, even though its numeric suffix dwarfs any real epoch millis`(
        @TempDir tmp: Path,
    ) {
        // Astronomically "new" if that suffix were ever compared as epoch millis (~20 quadrillion
        // vs. a real ~1.7 trillion) -- which is exactly the trap a wall-clock filter falls into.
        // Snapshot-diff must ignore it purely because it already existed before construction.
        val staleDir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        writeLog(staleDir, 10)
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        tailer.tick()
        tailer.tick()

        assertTrue(api.calls.isEmpty(), "a directory present before construction must never be opened, no matter how many ticks pass")

        // A directory in the exact same naming shape, appearing AFTER construction, IS recognised.
        val freshDir = Files.createDirectory(tmp.resolve(realDirName("20260820134512987")))
        writeLog(freshDir, 5)

        tailer.tick()

        val streams = api.streamCalls()
        assertEquals(1, streams.size)
        assertEquals(5, streams[0].byteCount)
        assertEquals(0L, streams[0].offset)

        tailer.finish()
        assertTrue(api.calls.any { it is ApiCall.Closed }, "the fresh directory's run must still be closed by finish()")
        assertEquals(1, api.calls.count { it is ApiCall.OpenAttempt }, "exactly one open -- the stale directory must never generate one")
    }

    @Test fun `TestKit-style fake-millis naming is recognised too, so long as it appears after construction`(
        @TempDir tmp: Path,
    ) {
        // The TestKit functional-test fixtures name their fake results dirs "fake-" +
        // System.currentTimeMillis() -- a different shape from real Gatling's, but still
        // `<something>-<digits>`, so it must still be recognised post-snapshot.
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve("fake-${System.currentTimeMillis()}"))
        writeLog(dir, 7)

        tailer.tick()

        val streams = api.streamCalls()
        assertEquals(1, streams.size)
        assertEquals(7, streams[0].byteCount)
        assertEquals(0L, streams[0].offset)
    }

    @Test fun `discovers multiple new directories within one tick and processes them in NAME order, not creation order`(
        @TempDir tmp: Path,
    ) {
        // Created out of name order: "z-sim" hits disk before "a-sim". If creation order drove
        // anything, z-sim would be processed first. Within a single tick, discovery order must be
        // by NAME.
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dirZ = Files.createDirectory(tmp.resolve("z-sim-20260820134041213"))
        writeLog(dirZ, 3)
        val dirA = Files.createDirectory(tmp.resolve("a-sim-20260820134041213"))
        writeLog(dirA, 4)

        tailer.tick() // both are discovered this tick; the name-first one (a-sim) opens
        tailer.tick() // switches to the second by name (z-sim)

        val streams = api.streamCalls()
        assertEquals(2, streams.size)
        assertEquals(4, streams[0].byteCount, "a-sim (name-first) must be processed before z-sim despite z-sim existing on disk first")
        assertEquals(3, streams[1].byteCount)
    }

    @Test fun `ships partial blocks -- whatever bytes exist at the tick`(@TempDir tmp: Path) {
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        writeLog(dir, 5000)

        tailer.tick()

        val streams = api.streamCalls()
        assertEquals(1, streams.size)
        assertEquals(5000, streams[0].byteCount)
        assertEquals(0L, streams[0].offset)
    }

    @Test fun `caps a single read at 4 MiB and drains the rest next tick`(@TempDir tmp: Path) {
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        val fiveMiB = 5 * 1024 * 1024
        writeLog(dir, fiveMiB)

        tailer.tick()
        var streams = api.streamCalls()
        assertEquals(1, streams.size)
        assertEquals(4 * 1024 * 1024, streams[0].byteCount)
        assertEquals(0L, streams[0].offset)

        tailer.tick()
        streams = api.streamCalls()
        assertEquals(2, streams.size)
        assertEquals(1 * 1024 * 1024, streams[1].byteCount)
        assertEquals((4 * 1024 * 1024).toLong(), streams[1].offset)
    }

    @Test fun `a second directory closes the first run and opens a second`(@TempDir tmp: Path) {
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dirA = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        Files.write(dirA.resolve("simulation.log"), "hello".toByteArray())

        tailer.tick()
        val firstStream = api.streamCalls().single()
        val runIdA = firstStream.runId
        assertEquals(0L, firstStream.offset)
        assertEquals(5, firstStream.byteCount)

        // Appears strictly after the first tick -- appearance order, not name/millis order, is
        // what governs processing order now.
        val dirB = Files.createDirectory(tmp.resolve(realDirName("20260820134199987")))
        Files.write(dirB.resolve("simulation.log"), "world!!".toByteArray())

        tailer.tick()

        val closeIdx = api.calls.indexOfFirst { it is ApiCall.Closed && it.runId == runIdA }
        assertTrue(closeIdx >= 0, "expected A to be closed")
        val openBIdx = api.calls.indexOfFirst { it is ApiCall.OpenSucceeded && it.runId != runIdA }
        assertTrue(openBIdx >= 0, "expected B to be opened")
        assertTrue(closeIdx < openBIdx, "A must close before B opens")

        val streamForB = api.streamCalls().last()
        assertNotEquals(runIdA, streamForB.runId)
        assertEquals(0L, streamForB.offset, "B's offset must start independent of A's")
        assertEquals(7, streamForB.byteCount)
    }

    @Test fun `409 resume rewinds the read position`(@TempDir tmp: Path) {
        val api = FakeApi()
        api.scriptNextStream(StreamResult.Resume(0))
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        writeLog(dir, 100)

        tailer.tick() // first read from 0, server rejects with Resume(0)
        tailer.tick() // must read from 0 again, not from wherever a normal advance would have gone

        val streams = api.streamCalls()
        assertEquals(2, streams.size)
        assertEquals(0L, streams[0].offset)
        assertEquals(0L, streams[1].offset)
        assertEquals(100, streams[1].byteCount)
    }

    @Test fun `finish drains the tail then closes -- including bytes written after the last tick`(@TempDir tmp: Path) {
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        val logFile = dir.resolve("simulation.log")
        Files.write(logFile, ByteArray(100))

        tailer.tick() // streams the first 100 bytes, offset -> 100

        // more bytes appear after the last tick, before finish
        Files.write(logFile, ByteArray(50), StandardOpenOption.APPEND)

        tailer.finish()

        val streams = api.streamCalls()
        assertEquals(2, streams.size)
        assertEquals(0L, streams[0].offset)
        assertEquals(100, streams[0].byteCount)
        assertEquals(100L, streams[1].offset)
        assertEquals(50, streams[1].byteCount)

        val runId = streams[0].runId
        assertTrue(api.calls.any { it is ApiCall.Closed && it.runId == runId })

        // idempotent: a second finish() is a no-op
        val callCountBeforeSecondFinish = api.calls.size
        tailer.finish()
        assertEquals(callCountBeforeSecondFinish, api.calls.size)
    }

    @Test fun `auth failure stops streaming but finish still closes`(@TempDir tmp: Path) {
        val api = FakeApi()
        api.scriptNextStream(StreamResult.AuthFailed)
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        val logFile = dir.resolve("simulation.log")
        Files.write(logFile, ByteArray(10))

        tailer.tick() // this stream attempt comes back AuthFailed
        assertEquals(1, api.streamCalls().size)

        // more bytes, and even a whole new simulation directory -- neither should provoke another call
        Files.write(logFile, ByteArray(20), StandardOpenOption.APPEND)
        val dirB = Files.createDirectory(tmp.resolve(realDirName("20260820134199987")))
        writeLog(dirB, 5)

        tailer.tick()
        assertEquals(1, api.streamCalls().size, "no further stream calls for ANY directory after AuthFailed")
        assertEquals(1, api.calls.count { it is ApiCall.OpenAttempt }, "no open() for the new directory either")

        tailer.finish()
        assertEquals(1, api.streamCalls().size, "finish must not attempt to stream after auth failure")
        assertEquals(1, api.calls.count { it is ApiCall.Closed }, "finish still closes the currently open run")
    }

    @Test fun `no directory ever appearing means no open and a clean finish`(@TempDir tmp: Path) {
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp)

        tailer.tick()
        tailer.tick()
        tailer.finish()

        assertTrue(api.calls.isEmpty())
        assertTrue(tailer.openFailures().isEmpty())
    }

    @Test fun `open failure is recorded in openFailures with no stream calls, and finish stays clean`(@TempDir tmp: Path) {
        val api = FakeApi()
        api.failNextOpen()
        val tailer = RunTailer(api, configFor(), tmp)

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        writeLog(dir, 10)

        tailer.tick()

        assertEquals(listOf(dir), tailer.openFailures())
        assertTrue(api.streamCalls().isEmpty(), "no stream calls for a directory whose open() failed")

        tailer.finish()
        assertTrue(api.calls.none { it is ApiCall.Closed }, "nothing was ever opened, so nothing should be closed")
    }

    // ── Critical 1: drain()'s progress guard ────────────────────────────────────────────────

    @Test @Timeout(value = 10, unit = TimeUnit.SECONDS)
    fun `drain abandons promptly when the server keeps rejecting at the same offset, but still closes`(@TempDir tmp: Path) {
        val api = FakeApi()
        api.alwaysReturnFromStream(StreamResult.Resume(0))
        val logs = mutableListOf<String>()
        val tailer = RunTailer(api, configFor(), tmp, logger = { logs.add(it) })

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        // Well more than one MAX_CHUNK_BYTES read on disk -- an unguarded loop, re-reading and
        // re-sending the identical chunk from offset 0 forever because the server never lets the
        // cursor move, would spin without end (this is exactly Critical 1: a 409 from a run the
        // server no longer accepts writes for reports an UNCHANGED nextOffset).
        writeLog(dir, RunTailer.MAX_CHUNK_BYTES * 3)

        tailer.finish() // the @Timeout above is the backstop if this regresses

        val streams = api.streamCalls()
        assertTrue(streams.isNotEmpty(), "expected at least one stream attempt before the guard tripped")
        assertTrue(streams.size <= 3, "expected the progress guard to trip within a couple of rounds, saw ${streams.size} stream calls")
        assertTrue(streams.all { it.offset == 0L }, "every attempt should have read from offset 0, since the server never advanced it")

        assertTrue(api.calls.any { it is ApiCall.Closed }, "close() must still run once drain gives up")
        assertTrue(
            logs.any { it.contains("abandoning drain", ignoreCase = true) },
            "expected a warning that the drain was abandoned, got: $logs",
        )
    }

    @Test @Timeout(value = 10, unit = TimeUnit.SECONDS)
    fun `a single rewind mid-drain does not trip the progress guard -- drain completes normally`(@TempDir tmp: Path) {
        val api = FakeApi()
        val cap = RunTailer.MAX_CHUNK_BYTES.toLong()
        val logs = mutableListOf<String>()
        val tailer = RunTailer(api, configFor(), tmp, logger = { logs.add(it) })

        val dir = Files.createDirectory(tmp.resolve(realDirName("20260820134041213")))
        val logFile = dir.resolve("simulation.log")
        // Two full chunks plus a short tail: enough for tick() to consume the first chunk (cursor
        // -> N == cap), drain() to read a second full chunk from N and get rewound, and a read
        // from the rewound offset that proves drain resumed there rather than aborting.
        val tailBytes = 777L
        Files.write(logFile, ByteArray((2 * cap + tailBytes).toInt()))

        tailer.tick() // opens the dir, streams [0, cap) -- cursor now N == cap
        assertEquals(cap, api.streamCalls().single().let { it.offset + it.byteCount })

        val rewindTarget = cap / 4 // a genuine rewind: 0 < rewindTarget < N
        api.scriptNextStream(StreamResult.Resume(rewindTarget))

        tailer.finish()

        val streams = api.streamCalls()
        assertTrue(streams.size >= 3, "expected the rewind round plus at least one read after it, got ${streams.size}")
        assertEquals(cap, streams[1].offset, "drain's own first read should continue from N")
        assertEquals(
            rewindTarget, streams[2].offset,
            "the read immediately after a legitimate rewind must start at the rewound offset -- " +
                "the progress guard must not have discarded it",
        )
        assertTrue(
            logs.none { it.contains("abandoning", ignoreCase = true) },
            "a single, non-repeating rewind must never trip the abandon guard, got: $logs",
        )
        assertTrue(api.calls.any { it is ApiCall.Closed }, "drain completing normally must still close the run")
    }
}
