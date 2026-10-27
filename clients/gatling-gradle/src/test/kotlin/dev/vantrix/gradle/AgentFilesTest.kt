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

        // 5000 is past 3500 + 1000, so the second JVM had not started when this directory was last written.
        assertEquals(first, AgentFiles.pairFor(agent, resultsDir(results, 3500)))
        assertEquals(second, AgentFiles.pairFor(agent, resultsDir(results, 9000)))
    }

    @Test fun `the 1000 ms allowance past the directory's last write is inclusive`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        agentFile(outDir, "agent-11-1000.ndjson", header(1000))
        val second = agentFile(outDir, "agent-22-5000.ndjson", header(5000))
        val agent = AgentRun(outDir, notBeforeMs = 0)

        assertEquals(second, AgentFiles.pairFor(agent, resultsDir(results, 4000)))
    }

    @Test fun `a file started before notBeforeMs is never chosen`(@TempDir tmp: Path) {
        val (outDir, results) = setUp(tmp)
        agentFile(outDir, "agent-11-1500.ndjson", header(1500))
        val agent = AgentRun(outDir, notBeforeMs = 2000)

        assertNull(AgentFiles.pairFor(agent, resultsDir(results, 3000)))

        val late = agentFile(outDir, "agent-22-2500.ndjson", header(2500))
        assertEquals(late, AgentFiles.pairFor(agent, resultsDir(results, 3001)))
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
