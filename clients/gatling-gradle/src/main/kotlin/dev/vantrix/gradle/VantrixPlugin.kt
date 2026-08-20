package dev.vantrix.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import java.util.concurrent.atomic.AtomicReference

/**
 * Wires [RunTailer] into the `gatlingRun` task lifecycle, whatever plugin (real Gatling, or a
 * TestKit fake) actually registers that task -- we key off the NAME, never a dependency on the
 * real plugin's classes, via `tasks.matching { it.name == "gatlingRun" }` rather than
 * `tasks.named("gatlingRun")` (which throws when the task is absent).
 *
 * A `doFirst` resolves config and, if present, opens a tailer for the run; a `vantrixClose`
 * task -- registered once per project, unconditionally -- is `finalizedBy`'d onto `gatlingRun` so
 * it closes the run EVEN WHEN gatlingRun fails. State crosses from the `doFirst` to the finalizer
 * through a plain [AtomicReference] captured by both closures: scoped to this one `apply()` call
 * (i.e. per project), which a companion-object holder would not be in a multi-project build.
 *
 * Every action body below is wrapped in `try/catch(Throwable)` that logs and swallows -- this
 * plugin must never be the reason a build fails. Configuration-cache compatibility is explicitly
 * out of scope for v0.1: `resultsRoot` resolution below reads `project.file` / `project.layout`
 * and `System.getenv()` from inside a task action, both of which a CC-safe version would instead
 * plumb in at configuration time (e.g. via `ProviderFactory.environmentVariable` and a captured
 * `Directory`).
 */
class VantrixPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val ext = project.extensions.create("vantrix", VantrixExtension::class.java)
        val tailerRef = AtomicReference<RunTailer?>(null)

        val closeTask = project.tasks.register("vantrixClose") { task ->
            task.doLast {
                try {
                    // No-op when doFirst never ran (missing config, task skipped/UP-TO-DATE): nothing in the holder.
                    tailerRef.get()?.finish()
                } catch (t: Throwable) {
                    project.logger.warn("vantrix: close failed: ${t.message}")
                }
            }
        }

        project.tasks.matching { it.name == "gatlingRun" }.configureEach { task ->
            task.doFirst {
                try {
                    // Captured at EXECUTION time, never configuration time -- TestKit's withEnvironment
                    // (and any real CI run) sets env per-invocation, not per-configuration.
                    val resolved = ResolvedConfig.from(ext, System.getenv())
                    when (resolved) {
                        is ResolvedConfig.Missing -> {
                            project.logger.warn("vantrix: ${resolved.reason}")
                        }
                        is ResolvedConfig.Ok -> {
                            val config = resolved.config
                            val resultsRoot = config.resultsDir
                                ?.let { project.file(it).toPath() }
                                ?: project.layout.buildDirectory.dir("reports/gatling").get().asFile.toPath()
                            val client = LiveClient(config, logger = { msg -> project.logger.warn("vantrix: $msg") })
                            val tailer = RunTailer(
                                api = client,
                                config = config,
                                resultsRoot = resultsRoot,
                                taskStartMillis = System.currentTimeMillis(),
                            )
                            tailerRef.set(tailer)
                            tailer.start()
                        }
                    }
                } catch (t: Throwable) {
                    project.logger.warn("vantrix: setup failed: ${t.message}")
                }
            }
            task.finalizedBy(closeTask)
        }
    }
}
