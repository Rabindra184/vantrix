package dev.vantrix.gradle

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import org.junit.jupiter.api.Test
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
        private var runCounter = 0

        fun failNextOpen() {
            openOutcomes.addLast(false)
        }

        fun scriptNextStream(result: StreamResult) {
            streamOutcomes.addLast(result)
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
            return scripted ?: StreamResult.Advanced(run.nextOffset + bytes.size)
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

    @Test fun `waits for a directory newer than task start`(@TempDir tmp: Path) {
        val taskStart = 2_000_000L
        // pre-existing old dir ignored
        val oldDir = Files.createDirectory(tmp.resolve("BasicSimulation-1000000"))
        writeLog(oldDir, 10)
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick()

        assertTrue(api.calls.isEmpty(), "an older directory must never be opened")
        assertTrue(tailer.openFailures().isEmpty())

        tailer.finish()
        assertTrue(api.calls.isEmpty(), "finish must stay clean when nothing eligible ever appeared")
    }

    @Test fun `ships partial blocks -- whatever bytes exist at the tick`(@TempDir tmp: Path) {
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        writeLog(dir, 5000)
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick()

        val streams = api.streamCalls()
        assertEquals(1, streams.size)
        assertEquals(5000, streams[0].byteCount)
        assertEquals(0L, streams[0].offset)
    }

    @Test fun `caps a single read at 4 MiB and drains the rest next tick`(@TempDir tmp: Path) {
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        val fiveMiB = 5 * 1024 * 1024
        writeLog(dir, fiveMiB)
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

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
        val taskStart = 1_000_000L
        val dirA = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        Files.write(dirA.resolve("simulation.log"), "hello".toByteArray())
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick()
        val firstStream = api.streamCalls().single()
        val runIdA = firstStream.runId
        assertEquals(0L, firstStream.offset)
        assertEquals(5, firstStream.byteCount)

        val dirB = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 2}"))
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
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        writeLog(dir, 100)
        val api = FakeApi()
        api.scriptNextStream(StreamResult.Resume(0))
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick() // first read from 0, server rejects with Resume(0)
        tailer.tick() // must read from 0 again, not from wherever a normal advance would have gone

        val streams = api.streamCalls()
        assertEquals(2, streams.size)
        assertEquals(0L, streams[0].offset)
        assertEquals(0L, streams[1].offset)
        assertEquals(100, streams[1].byteCount)
    }

    @Test fun `finish drains the tail then closes -- including bytes written after the last tick`(@TempDir tmp: Path) {
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        val logFile = dir.resolve("simulation.log")
        Files.write(logFile, ByteArray(100))
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

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
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        val logFile = dir.resolve("simulation.log")
        Files.write(logFile, ByteArray(10))
        val api = FakeApi()
        api.scriptNextStream(StreamResult.AuthFailed)
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick() // this stream attempt comes back AuthFailed
        assertEquals(1, api.streamCalls().size)

        // more bytes, and even a whole new simulation directory -- neither should provoke another call
        Files.write(logFile, ByteArray(20), StandardOpenOption.APPEND)
        val dirB = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 2}"))
        writeLog(dirB, 5)

        tailer.tick()
        assertEquals(1, api.streamCalls().size, "no further stream calls for ANY directory after AuthFailed")
        assertEquals(1, api.calls.count { it is ApiCall.OpenAttempt }, "no open() for the new directory either")

        tailer.finish()
        assertEquals(1, api.streamCalls().size, "finish must not attempt to stream after auth failure")
        assertEquals(1, api.calls.count { it is ApiCall.Closed }, "finish still closes the currently open run")
    }

    @Test fun `no directory ever appearing means no open and a clean finish`(@TempDir tmp: Path) {
        val taskStart = 1_000_000L
        val api = FakeApi()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick()
        tailer.tick()
        tailer.finish()

        assertTrue(api.calls.isEmpty())
        assertTrue(tailer.openFailures().isEmpty())
    }

    @Test fun `open failure is recorded in openFailures with no stream calls, and finish stays clean`(@TempDir tmp: Path) {
        val taskStart = 1_000_000L
        val dir = Files.createDirectory(tmp.resolve("BasicSimulation-${taskStart + 1}"))
        writeLog(dir, 10)
        val api = FakeApi()
        api.failNextOpen()
        val tailer = RunTailer(api, configFor(), tmp, taskStart)

        tailer.tick()

        assertEquals(listOf(dir), tailer.openFailures())
        assertTrue(api.streamCalls().isEmpty(), "no stream calls for a directory whose open() failed")

        tailer.finish()
        assertTrue(api.calls.none { it is ApiCall.Closed }, "nothing was ever opened, so nothing should be closed")
    }
}
