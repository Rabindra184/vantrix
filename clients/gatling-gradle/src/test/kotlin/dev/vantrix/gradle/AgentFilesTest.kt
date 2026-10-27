package dev.vantrix.gradle

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import kotlin.test.*

class AgentFilesTest {

    private fun header(startedAt: Long) =
        """{"t":"header","format":"perfportal-agent/1","agentVersion":"0.1.0","startedAt":$startedAt}"""

    /** An agent file whose first line is [firstLine], followed by a sample line like a real one. */
    private fun agentFile(outDir: Path, name: String, firstLine: String): Path {
        val file = outDir.resolve(name)
        Files.writeString(file, "$firstLine\n{\"t\":\"s\",\"ts\":1}\n")
        return file
    }

    /** A results directory whose last-modified time is [lastModifiedMs]. */
    private fun resultsDir(root: Path, lastModifiedMs: Long): Path {
        val dir = Files.createDirectory(root.resolve("sim-$lastModifiedMs"))
        Files.write(dir.resolve("simulation.log"), ByteArray(4))
        Files.setLastModifiedTime(dir, FileTime.fromMillis(lastModifiedMs))
        return dir
    }

    private fun setUp(tmp: Path): Pair<Path, Path> {
        val outDir = Files.createDirectory(tmp.resolve("out"))
        val results = Files.createDirectory(tmp.resolve("results"))
        return outDir to results
    }

    @Test fun `pairs a directory with the latest agent file that started before its last write`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val first = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        val second = agentFile(outDir, "agent-22-5000.ndjson", header(5000))
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(first, AgentFiles.pairFor(agent, resultsDir(results, 4000)))
        assertEquals(second, AgentFiles.pairFor(agent, resultsDir(results, 9000)))
    }

    @Test fun `a header at exactly the directory's last write is that directory's`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        val atLastWrite = agentFile(outDir, "agent-22-5000.ndjson", header(5000))

        assertEquals(atLastWrite, AgentFiles.pairFor(AgentRun(outDir, notBeforeMs = 0), resultsDir(results, 5000)))
    }

    @Test fun `a header at exactly notBeforeMs belongs to this gatlingRun`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val atNotBefore = agentFile(outDir, "agent-33-7000.ndjson", header(7000))

        assertEquals(atNotBefore, AgentFiles.pairFor(AgentRun(outDir, notBeforeMs = 7000), resultsDir(results, 7500)))
    }

    @Test fun `the next simulation's file, started 1 ms after this directory's last write, is not this run's`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        // Run k's JVM started at 1000 and last wrote its directory at 5000; run k+1's JVM wrote its
        // header 1 ms later. Any slack past the last write would hand run k the next run's file.
        val own = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        agentFile(outDir, "agent-22-5001.ndjson", header(5001))

        assertEquals(own, AgentFiles.pairFor(AgentRun(outDir, notBeforeMs = 0), resultsDir(results, 5000)))
    }

    @Test fun `a file already paired with one run is never paired with a second`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val only = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(only, AgentFiles.pairFor(agent, resultsDir(results, 3000)))
        // A later directory whose own JVM left no file: the earlier run's file stays that run's.
        assertNull(AgentFiles.pairFor(agent, resultsDir(results, 6000)))
        // The memory belongs to ONE gatlingRun: a fresh AgentRun has paired nothing yet. (Its
        // directory sits under its own root: beside the two above, their last writes would bound
        // it from below, which is a different rule.)
        val otherRoot = Files.createDirectory(tmp.resolve("results-other"))
        assertEquals(only, AgentFiles.pairFor(AgentRun(outDir, notBeforeMs = 0), resultsDir(otherRoot, 7000)))
    }

    @Test fun `a run whose own JVM left no file never takes an earlier run's unclaimed file`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        // Run 1 wrote its file and its directory, but nothing ever paired them (its live run never
        // opened and the fallback is off), so its file is still unclaimed.
        val earlier = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        val earlierDir = resultsDir(results, 4000)
        val agent = AgentRun(outDir, notBeforeMs = 0)

        // Run 2's JVM left no file: its directory pairs nothing, rather than run 1's file.
        assertNull(AgentFiles.pairFor(agent, resultsDir(results, 9000)))
        // And run 1's file is still run 1's.
        assertEquals(earlier, AgentFiles.pairFor(agent, earlierDir))
    }

    @Test fun `a file started before notBeforeMs is never chosen`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        agentFile(outDir, "agent-11-1500.ndjson", header(1500))
        val agent = AgentRun(outDir, notBeforeMs = 2000)

        assertNull(AgentFiles.pairFor(agent, resultsDir(results, 3000)))

        // A file started after notBeforeMs is. (Its directory sits under its own root: beside the
        // one above, last written at 3000, that write would bound it from below -- a header at
        // 2500 would belong to that earlier directory's run.)
        val late = agentFile(outDir, "agent-22-2500.ndjson", header(2500))
        val otherRoot = Files.createDirectory(tmp.resolve("results-other"))
        assertEquals(late, AgentFiles.pairFor(agent, resultsDir(otherRoot, 3001)))
    }

    @Test fun `empty, headerless and malformed files are skipped`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val good = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        Files.write(outDir.resolve("agent-22-2000.ndjson"), ByteArray(0))
        agentFile(outDir, "agent-33-2100.ndjson", """{"t":"s","ts":2100}""")
        agentFile(outDir, "agent-44-2200.ndjson", "not json at all")
        agentFile(outDir, "agent-55-2300.ndjson", """{"t":"header","startedAt":"2300"}""")
        agentFile(outDir, "agent-66-2400.ndjson", """{"t":"header"}""")
        agentFile(outDir, "agent-77-2500.ndjson", "[1,2,3]")
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(good, AgentFiles.pairFor(agent, resultsDir(results, 9000)))
    }

    @Test fun `only agent-star-ndjson files are considered`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val good = agentFile(outDir, "agent-1000.ndjson", header(1000))
        agentFile(outDir, "other-2000.ndjson", header(2000))
        agentFile(outDir, "agent-3000.ndjson.tmp", header(3000))
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(good, AgentFiles.pairFor(agent, resultsDir(results, 9000)))
    }

    @Test fun `no agent files, or no output directory at all, pairs nothing`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val dir = resultsDir(results, 9000)

        assertNull(AgentFiles.pairFor(AgentRun(outDir, notBeforeMs = 0), dir))
        assertNull(AgentFiles.pairFor(AgentRun(tmp.resolve("missing"), notBeforeMs = 0), dir))
    }

    @Test fun `a header line far longer than any real one is skipped without reading the file`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        val good = agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        // A first line with no newline for well past the read bound: never a real header.
        Files.writeString(outDir.resolve("agent-22-2000.ndjson"), header(2000).dropLast(1) + ",\"pad\":\"" + "x".repeat(200_000) + "\"}\n")
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(good, AgentFiles.pairFor(agent, resultsDir(results, 9000)))
    }
}
