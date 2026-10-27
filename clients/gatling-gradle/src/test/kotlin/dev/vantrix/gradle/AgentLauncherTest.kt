package dev.vantrix.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.tasks.Internal
import org.gradle.testfixtures.ProjectBuilder
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.*

/**
 * [AgentLauncher] against stand-ins shaped like upstream `io.gatling.gradle` 3.15.1.2:
 * `GatlingRunTask` and the `gatling` extension (GatlingPluginExtension) each carry a
 * `List<String> getJvmArgs()` / `setJvmArgs(List<String>)` pair, and the per-simulation
 * `javaexec` passes `task.jvmArgs ?: gatlingExt.jvmArgs` -- a Groovy elvis, so a task list that
 * is null OR EMPTY falls back to the extension's. Nothing here names a Gatling class, which is
 * the point: the plugin finds both by reflection.
 */
class AgentLauncherTest {

    open class FakeGatlingRun : DefaultTask() {
        @get:Internal
        var jvmArgs: List<String>? = null
    }

    open class FakeGatlingExtension {
        var jvmArgs: List<String>? = null
    }

    open class NoJvmArgsTask : DefaultTask()

    private fun project(dir: Path): Project = ProjectBuilder.builder().withProjectDir(dir.toFile()).build()

    private fun fakeTask(project: Project, args: List<String>?): FakeGatlingRun =
        project.tasks.register("gatlingRun", FakeGatlingRun::class.java).get().also { it.jvmArgs = args }

    private fun gatlingExt(project: Project, args: List<String>?) {
        project.extensions.create("gatling", FakeGatlingExtension::class.java).jvmArgs = args
    }

    private fun ours(buildDir: Path): String {
        val jar = buildDir.resolve("vantrix/agent/gatling-agent.jar").toAbsolutePath()
        val out = buildDir.resolve("vantrix/agent/out").resolve("agent-{jvm}.ndjson").toAbsolutePath()
        return "-javaagent:$jar=out=$out,max=268434432"
    }

    private fun prepare(task: Task, buildDir: Path, logs: MutableList<String> = mutableListOf()) =
        AgentLauncher.prepare(task, buildDir) { logs += it }

    @Test fun `the task's own list is kept, in order, with ours appended`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, listOf("-Xmx2g", "-javaagent:/opt/other.jar"))
        val buildDir = tmp.resolve("build")

        val run = prepare(task, buildDir)

        assertNotNull(run)
        assertEquals(listOf("-Xmx2g", "-javaagent:/opt/other.jar", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `a second prepare adds nothing but still returns the run`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, listOf("-Xmx2g"))
        val buildDir = tmp.resolve("build")

        prepare(task, buildDir)
        val second = prepare(task, buildDir)

        assertNotNull(second)
        assertEquals(listOf("-Xmx2g", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `a null task list keeps the gatling extension's list and appends ours`(@TempDir tmp: Path) {
        val p = project(tmp)
        gatlingExt(p, listOf("-Xmx4g", "-Dfoo=bar"))
        val task = fakeTask(p, null)
        val buildDir = tmp.resolve("build")

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf("-Xmx4g", "-Dfoo=bar", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `an empty task list keeps the gatling extension's list too -- upstream's elvis treats empty as unset`(
        @TempDir tmp: Path,
    ) {
        val p = project(tmp)
        gatlingExt(p, listOf("-Xmx4g"))
        val task = fakeTask(p, emptyList())
        val buildDir = tmp.resolve("build")

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf("-Xmx4g", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `a non-empty task list wins and the extension's is not added, as upstream`(@TempDir tmp: Path) {
        val p = project(tmp)
        gatlingExt(p, listOf("-Xmx4g"))
        val task = fakeTask(p, listOf("-Xmx2g"))
        val buildDir = tmp.resolve("build")

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf("-Xmx2g", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `no gatling extension and a null task list gives ours alone`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, null)
        val buildDir = tmp.resolve("build")

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf(ours(buildDir)), task.jvmArgs)
    }

    @Test fun `a gatling extension whose list is null gives ours alone`(@TempDir tmp: Path) {
        val p = project(tmp)
        gatlingExt(p, null)
        val task = fakeTask(p, null)
        val buildDir = tmp.resolve("build")

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf(ours(buildDir)), task.jvmArgs)
    }

    @Test fun `an agent already on the extension's list is not added twice`(@TempDir tmp: Path) {
        val p = project(tmp)
        val buildDir = tmp.resolve("build")
        gatlingExt(p, listOf("-Xmx4g", ours(buildDir)))
        val task = fakeTask(p, null)

        assertNotNull(prepare(task, buildDir))
        assertEquals(listOf("-Xmx4g", ours(buildDir)), task.jvmArgs)
    }

    @Test fun `a task without jvmArgs accessors returns null and logs once`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = p.tasks.register("gatlingRun", NoJvmArgsTask::class.java).get()
        val logs = mutableListOf<String>()
        val buildDir = tmp.resolve("build")

        assertNull(prepare(task, buildDir, logs))
        assertEquals(1, logs.size, "expected exactly one warning, got $logs")
        assertTrue("jvmArgs" in logs.single(), "the warning should say what is missing: ${logs.single()}")
        assertFalse(Files.exists(buildDir.resolve("vantrix/agent")), "nothing should be extracted for a task we cannot attach to")
    }

    /**
     * The JVM takes everything before the first `=` of `-javaagent:` as the jar's path, and the
     * agent splits its options on `,`: a path carrying either cannot be passed at all. A Jenkins
     * matrix workspace (`.../JDK=jdk21,label=linux/`) carries both.
     */
    private fun assertSkippedFor(ch: Char, tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, listOf("-Xmx2g"))
        val buildDir = tmp.resolve("JDK${ch}jdk21").resolve("build")
        val logs = mutableListOf<String>()

        assertNull(prepare(task, buildDir, logs))
        assertEquals(listOf("-Xmx2g"), task.jvmArgs, "jvmArgs must be left exactly as they were")
        assertEquals(1, logs.size, "expected exactly one warning, got $logs")
        assertTrue("'$ch'" in logs.single(), "the warning should name the character: ${logs.single()}")
        assertFalse(Files.exists(buildDir.resolve("vantrix/agent")), "nothing should be extracted for a run the agent skips")
    }

    @Test fun `a build path carrying = skips the agent and leaves jvmArgs untouched`(@TempDir tmp: Path) =
        assertSkippedFor('=', tmp)

    @Test fun `a build path carrying a comma skips the agent and leaves jvmArgs untouched`(@TempDir tmp: Path) =
        assertSkippedFor(',', tmp)

    @Test fun `the agent jar is extracted, non-empty, and overwritten each time`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, null)
        val buildDir = tmp.resolve("build")
        val jar = buildDir.resolve("vantrix/agent/gatling-agent.jar")
        Files.createDirectories(jar.parent)
        Files.write(jar, byteArrayOf(1, 2, 3))

        prepare(task, buildDir)

        assertTrue(Files.size(jar) > 3, "expected the real agent jar, got ${Files.size(jar)} bytes")
        val resource = AgentLauncher::class.java.getResourceAsStream("/dev/vantrix/gradle/agent/gatling-agent.jar")!!
            .use { it.readBytes() }
        assertContentEquals(resource, Files.readAllBytes(jar))
    }

    @Test fun `a file left in out from an earlier run is gone, and out exists`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, null)
        val buildDir = tmp.resolve("build")
        val out = buildDir.resolve("vantrix/agent/out")
        Files.createDirectories(out.resolve("nested"))
        Files.write(out.resolve("agent-1-2.ndjson"), byteArrayOf(9))
        Files.write(out.resolve("nested/x"), byteArrayOf(9))

        val run = prepare(task, buildDir)

        assertNotNull(run)
        assertEquals(out.toAbsolutePath(), run.outDir.toAbsolutePath())
        assertTrue(Files.isDirectory(out))
        assertEquals(0, Files.list(out).use { it.count() })
    }

    @Test fun `notBeforeMs is taken at prepare time`(@TempDir tmp: Path) {
        val p = project(tmp)
        val task = fakeTask(p, null)
        val before = System.currentTimeMillis()
        val run = prepare(task, tmp.resolve("build"))
        val after = System.currentTimeMillis()

        assertNotNull(run)
        assertTrue(run.notBeforeMs in before..after, "notBeforeMs ${run.notBeforeMs} not in $before..$after")
    }
}
