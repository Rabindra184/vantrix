package dev.vantrix.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.logging.Logger
import org.gradle.api.logging.Logging

/** Task actions log through this, never `project.logger`: a task action that reaches the project
 *  is what Gradle's configuration cache refuses. */
private val log: Logger = Logging.getLogger(VantrixPlugin::class.java)

/**
 * Wires [RunTailer] into the `gatlingRun` task lifecycle, whatever plugin (real Gatling, or a
 * TestKit fake) actually registers that task -- we key off the NAME, never a dependency on the
 * real plugin's classes, via `tasks.matching { it.name == "gatlingRun" }` rather than
 * `tasks.named("gatlingRun")` (which throws when the task is absent).
 *
 * A `doFirst` resolves config and, if present, opens a tailer for the run; a `vantrixClose`
 * task -- registered once per project, unconditionally -- is `finalizedBy`'d onto `gatlingRun` so
 * it closes the run EVEN WHEN gatlingRun fails. State crosses from the `doFirst` to the finalizer
 * through a per-project [VantrixRunHandoff] build service. The same finalizer, after closing the
 * run, is also where the opt-in `uploadIfLiveUnavailable` fallback runs -- see [BundleUploader].
 *
 * Every action body below is wrapped in `try/catch(Throwable)` that logs and swallows -- this
 * plugin must never be the reason a build fails.
 *
 * ═══ CONFIGURATION-CACHE SAFE, BECAUSE GATLING's OWN DEMO TURNS THE CACHE ON ═══
 *
 * `gatling-gradle-plugin-demo-kotlin` ships `org.gradle.configuration-cache=true`. Under it the
 * first version failed the build with three problems (`Project` captured by both task actions)
 * and lost the agent (`AgentLauncher` read `Task.project` during execution) -- breaking the rule
 * above for the project a Gatling Enterprise user actually starts from. So no task action here
 * touches the project: what they need is captured at configuration time as values the cache can
 * store -- a provider of a plain [VantrixExtension.snapshot], the build and project directories,
 * a provider of the `gatling` extension's `jvmArgs` -- and the run is handed across through a
 * build service, which survives each task being run from its own deserialized copy. The
 * environment is still read in `doFirst`, at execution time, where the cache allows it.
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
            val handoff = project.gradle.sharedServices.registerIfAbsent(
                "vantrix-run-handoff" + project.path,
                VantrixRunHandoff::class.java,
            ) {}
            // Read when first asked for -- after the build script has set them -- and stored by
            // the configuration cache as plain values.
            val settings = project.provider { ext.snapshot() }
            val gatlingJvmArgs = project.provider { AgentLauncher.jvmArgsOf(project.extensions.findByName("gatling")) }
            val buildDir = project.layout.buildDirectory
            val projectDir = project.layout.projectDirectory

            val closeTask = project.tasks.register("vantrixClose") { task ->
                task.usesService(handoff)
                task.doLast {
                    try {
                        // No-op when doFirst never ran (missing config, task skipped/UP-TO-DATE): nothing handed over.
                        val handle = handoff.get().take()
                        handle?.tailer?.finish()

                        // Fallback: strictly opt-in, and only for a simulation whose live open
                        // actually failed -- everything else already streamed successfully.
                        if (handle != null && handle.config.uploadIfLiveUnavailable) {
                            val failures = handle.tailer.openFailures()
                            if (failures.isNotEmpty()) {
                                val uploader = BundleUploader(logger = { msg -> log.warn("vantrix: $msg") })
                                failures.forEach { dir -> uploader.upload(handle.config, dir, handle.agentRun) }
                            }
                        }
                    } catch (t: Throwable) {
                        log.warn("vantrix: close failed: ${t.message}")
                    }
                }
            }

            project.tasks.matching { it.name == "gatlingRun" }.configureEach { task ->
                task.usesService(handoff)
                task.doFirst { run ->
                    try {
                        // Captured at EXECUTION time, never configuration time -- TestKit's withEnvironment
                        // (and any real CI run) sets env per-invocation, not per-configuration.
                        val resolved = ResolvedConfig.from(settings.get(), System.getenv())
                        when (resolved) {
                            is ResolvedConfig.Missing -> {
                                log.warn("vantrix: ${resolved.reason}")
                            }
                            is ResolvedConfig.Ok -> {
                                val config = resolved.config
                                // Before Gatling's own action runs, so the jvmArgs it reads already
                                // carry the agent; prepare() never throws, so a failure here costs
                                // the agent and nothing else.
                                val agentRun = if (config.agentEnabled) {
                                    AgentLauncher.prepare(
                                        run,
                                        buildDir.get().asFile.toPath(),
                                        extensionJvmArgs = { gatlingJvmArgs.getOrElse(emptyList()) },
                                        logger = { msg -> log.warn("vantrix: $msg") },
                                    )
                                } else {
                                    null
                                }
                                // `project.file` semantics: relative to the project, absolute as given.
                                val resultsRoot = config.resultsDir
                                    ?.let { projectDir.asFile.toPath().resolve(it) }
                                    ?: buildDir.dir("reports/gatling").get().asFile.toPath()
                                val client = LiveClient(config, logger = { msg -> log.warn("vantrix: $msg") })
                                // Constructed here, in doFirst -- strictly BEFORE Gatling's own task
                                // action runs -- so RunTailer's constructor snapshot (see its class
                                // doc) captures every results directory left over from a previous
                                // run, and never the directory this very invocation is about to
                                // create.
                                val tailer = RunTailer(
                                    api = client,
                                    config = config,
                                    resultsRoot = resultsRoot,
                                    agent = agentRun,
                                    logger = { msg -> log.warn(msg) },
                                )
                                handoff.get().put(TailerHandle(tailer, config, agentRun))
                                tailer.start()
                            }
                        }
                    } catch (t: Throwable) {
                        log.warn("vantrix: setup failed: ${t.message}")
                    }
                }
                task.finalizedBy(closeTask)
            }
        } catch (t: Throwable) {
            project.logger.warn("vantrix: plugin apply failed: ${t.message}")
        }
    }
}
