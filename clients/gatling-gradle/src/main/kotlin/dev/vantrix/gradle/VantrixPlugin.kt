package dev.vantrix.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import java.util.concurrent.atomic.AtomicReference

/** The `doFirst`-to-finalizer handoff: the tailer plus the resolved config it was opened with,
 *  so the finalizer can read `uploadIfLiveUnavailable` without re-resolving anything. */
private data class TailerHandle(val tailer: RunTailer, val config: PluginConfig)

/**
 * Wires [RunTailer] into the `gatlingRun` task lifecycle, whatever plugin (real Gatling, or a
 * TestKit fake) actually registers that task -- we key off the NAME, never a dependency on the
 * real plugin's classes, via `tasks.matching { it.name == "gatlingRun" }` rather than
 * `tasks.named("gatlingRun")` (which throws when the task is absent).
 *
 * A `doFirst` resolves config and, if present, opens a tailer for the run; a `vantrixClose`
 * task -- registered once per project, unconditionally -- is `finalizedBy`'d onto `gatlingRun` so
 * it closes the run EVEN WHEN gatlingRun fails. State crosses from the `doFirst` to the finalizer
 * through a plain [AtomicReference] (holding a [TailerHandle]) captured by both closures: scoped
 * to this one `apply()` call (i.e. per project), which a companion-object holder would not be in
 * a multi-project build. The same finalizer, after closing the run, is also where the opt-in
 * `uploadIfLiveUnavailable` fallback runs -- see [BundleUploader].
 *
 * Every action body below is wrapped in `try/catch(Throwable)` that logs and swallows -- this
 * plugin must never be the reason a build fails. Configuration-cache compatibility is explicitly
 * out of scope for v0.1: `resultsRoot` resolution below reads `project.file` / `project.layout`
 * and `System.getenv()` from inside a task action, both of which a CC-safe version would instead
 * plumb in at configuration time (e.g. via `ProviderFactory.environmentVariable` and a captured
 * `Directory`).
 *
 * `apply()` itself is guarded too, ahead of its own top-level `try/catch(Throwable)`: a consumer
 * build that already has its own extension or task literally named `vantrix`/`vantrixClose`
 * would otherwise hit an uncaught configuration-time failure the moment this plugin tries to
 * register its own -- not a double-apply of THIS plugin (Gradle's `PluginManager` already
 * applies a given plugin class at most once per project, so that case needs no guard), but a
 * genuine third-party name collision. Colliding is detected before anything is created, so the
 * plugin can go fully inert -- one warning, no extension, no task, no wiring -- rather than
 * half-registering itself against objects it does not own.
 */
class VantrixPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        try {
            if (project.extensions.findByName("vantrix") != null) {
                project.logger.warn(
                    "vantrix: an extension named 'vantrix' already exists; the Vantrix plugin is disabled for this project",
                )
                return
            }
            if ("vantrixClose" in project.tasks.names) {
                project.logger.warn(
                    "vantrix: a task named 'vantrixClose' already exists; the Vantrix plugin is disabled for this project",
                )
                return
            }

            val ext = project.extensions.create("vantrix", VantrixExtension::class.java)
            val handleRef = AtomicReference<TailerHandle?>(null)

            val closeTask = project.tasks.register("vantrixClose") { task ->
                task.doLast {
                    try {
                        // No-op when doFirst never ran (missing config, task skipped/UP-TO-DATE): nothing in the holder.
                        val handle = handleRef.get()
                        handle?.tailer?.finish()

                        // Fallback: strictly opt-in, and only for a simulation whose live open
                        // actually failed -- everything else already streamed successfully.
                        if (handle != null && handle.config.uploadIfLiveUnavailable) {
                            val failures = handle.tailer.openFailures()
                            if (failures.isNotEmpty()) {
                                val uploader = BundleUploader(logger = { msg -> project.logger.warn("vantrix: $msg") })
                                failures.forEach { dir -> uploader.upload(handle.config, dir) }
                            }
                        }
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
                                // Constructed here, in doFirst -- strictly BEFORE Gatling's own task
                                // action runs -- so RunTailer's constructor snapshot (see its class
                                // doc) captures every results directory left over from a previous
                                // run, and never the directory this very invocation is about to
                                // create.
                                val tailer = RunTailer(
                                    api = client,
                                    config = config,
                                    resultsRoot = resultsRoot,
                                    logger = { msg -> project.logger.warn(msg) },
                                )
                                handleRef.set(TailerHandle(tailer, config))
                                tailer.start()
                            }
                        }
                    } catch (t: Throwable) {
                        project.logger.warn("vantrix: setup failed: ${t.message}")
                    }
                }
                task.finalizedBy(closeTask)
            }
        } catch (t: Throwable) {
            project.logger.warn("vantrix: plugin apply failed: ${t.message}")
        }
    }
}
