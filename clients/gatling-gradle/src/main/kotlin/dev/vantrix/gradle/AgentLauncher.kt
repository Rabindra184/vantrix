package dev.vantrix.gradle

import org.gradle.api.Task
import java.lang.reflect.Method
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Where this `gatlingRun`'s agent files land, and an instant taken before any of them could have
 * been written -- what the tailer pairs each results directory with.
 */
data class AgentRun(val outDir: Path, val notBeforeMs: Long) {
    /**
     * The agent files already paired with a run of this `gatlingRun` -- [AgentFiles.pairFor] never
     * pairs one file with two runs. Shared by the tailer and the fallback uploader, guarded by its
     * own monitor; outside the constructor, so it takes no part in equality.
     */
    internal val paired: MutableSet<Path> = mutableSetOf()
}

/**
 * Starts `gatlingRun` with the PerfPortal Gatling agent, by adding one `-javaagent:` to the JVM
 * arguments upstream hands each simulation JVM.
 *
 * Upstream `io.gatling.gradle` 3.15.1.2 starts ONE JVM PER SIMULATION, every one with
 * `task.jvmArgs ?: gatlingExt.jvmArgs` -- a Groovy elvis, so a task list that is null OR EMPTY
 * falls back to the `gatling` extension's, which is where a user's `gatling { jvmArgs = [...] }`
 * lives. So the list extended here is that same choice, and the result is set on the TASK.
 * Setting `[ours]` there alone would make the task list non-empty, and upstream would then stop
 * reading the user's JVM flags without a word. A non-empty task list wins and the extension's is
 * NOT added, as upstream does.
 *
 * Both are reached by reflection (`getJvmArgs()` / `setJvmArgs(List)`), so the plugin keeps no
 * compile dependency on Gatling's classes; a task without them gets one warning and `null`.
 *
 * The output path carries the agent's `{jvm}` token, which each JVM replaces with its own id, so
 * one simulation's file never overwrites another's. `max` is the API's 256 MiB cap less the
 * runner's 1024-byte headroom: on reaching `max` the agent writes one closing line past it, and a
 * file at exactly the cap would be refused whole.
 *
 * Never throws: anything that goes wrong is one warning and `null`, and the run goes ahead
 * without the agent. The arguments are rewritten only once the jar is on disk, so a JVM is never
 * pointed at an agent that is not there.
 */
object AgentLauncher {
    const val RESOURCE = "/dev/vantrix/gradle/agent/gatling-agent.jar"

    /** The API's `MAX_AGENT_LOG_BYTES` default (256 MiB) less the runner's `AGENT_CAP_HEADROOM_BYTES`. */
    const val MAX_BYTES = 268_435_456L - 1024L

    /** What identifies OUR agent in an existing list: ours from an earlier `gatlingRun`, or one the user wired. */
    private const val MARKER = "/vantrix/agent/gatling-agent.jar"

    /** Characters the `-javaagent:<jar>=out=<path>,max=<n>` argument cannot carry in a path. */
    private val UNSAFE = listOf('=', ',')

    fun prepare(task: Task, buildDir: Path, logger: (String) -> Unit): AgentRun? {
        try {
            val notBeforeMs = System.currentTimeMillis()
            val getter = getterOf(task)
            val setter = setterOf(task)
            if (getter == null || setter == null) {
                logger("${task.name} has no jvmArgs property to add the agent to; this run carries no agent data")
                return null
            }

            val agentDir = buildDir.resolve("vantrix").resolve("agent").toAbsolutePath()
            val jar = agentDir.resolve("gatling-agent.jar")
            val outDir = agentDir.resolve("out")

            // The JVM takes everything before the first `=` of `-javaagent:` as the jar's path, and
            // the agent splits its options on `,`. A path carrying `=` would stop every simulation
            // JVM from starting; one carrying `,` would cut `out=` short and send the agent's file
            // (truncating whatever is there) outside the build. Checked before anything is
            // extracted or any argument is touched.
            val unsafe = UNSAFE.firstOrNull { it in jar.toString() || it in outDir.toString() }
            if (unsafe != null) {
                logger(
                    "the build directory path $agentDir contains '$unsafe', which a -javaagent argument " +
                        "cannot carry; the agent is skipped and this run carries no agent data",
                )
                return null
            }

            val stream = AgentLauncher::class.java.getResourceAsStream(RESOURCE)
            if (stream == null) {
                logger("the plugin carries no agent jar ($RESOURCE); this run carries no agent data")
                return null
            }
            // Closed on every path, a failing createDirectories included.
            stream.use {
                Files.createDirectories(agentDir)
                Files.copy(it, jar, StandardCopyOption.REPLACE_EXISTING)
            }
            // A file left by an earlier run must never be paired with this one's results.
            emptyDirectory(outDir)

            val taskList = readList(getter, task)
            val base = if (taskList.isNotEmpty()) taskList else extensionList(task)
            val already = base.any { arg ->
                arg.startsWith("-javaagent:") && arg.replace('\\', '/').contains(MARKER)
            }
            val ours = "-javaagent:$jar=out=${outDir.resolve("agent-{jvm}.ndjson")},max=$MAX_BYTES"
            setter.invoke(task, if (already) base else base + ours)

            return AgentRun(outDir, notBeforeMs)
        } catch (t: Throwable) {
            // A reflective failure arrives as an InvocationTargetException whose own message is null.
            val reason = (t.cause ?: t).message ?: t.javaClass.simpleName
            logger("could not start ${task.name} with the agent ($reason); this run carries no agent data")
            return null
        }
    }

    /** The `gatling` extension's list, or empty: no extension, no accessor, or a null list. */
    private fun extensionList(task: Task): List<String> {
        val ext = task.project.extensions.findByName("gatling") ?: return emptyList()
        val getter = getterOf(ext) ?: return emptyList()
        return readList(getter, ext)
    }

    private fun getterOf(target: Any): Method? =
        target.javaClass.methods.firstOrNull {
            it.name == "getJvmArgs" && it.parameterCount == 0 && List::class.java.isAssignableFrom(it.returnType)
        }

    private fun setterOf(target: Any): Method? =
        target.javaClass.methods.firstOrNull {
            it.name == "setJvmArgs" && it.parameterCount == 1 && it.parameterTypes[0].isAssignableFrom(List::class.java)
        }

    private fun readList(getter: Method, target: Any): List<String> =
        (getter.invoke(target) as List<*>?).orEmpty().filterNotNull().map { it.toString() }

    private fun emptyDirectory(dir: Path) {
        if (Files.exists(dir)) {
            Files.walk(dir).use { paths ->
                paths.sorted(Comparator.reverseOrder()).filter { it != dir }.forEach { Files.delete(it) }
            }
        }
        Files.createDirectories(dir)
    }
}
