package dev.vantrix.gradle

import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import java.util.concurrent.atomic.AtomicReference

/** The tailer plus the resolved config it was opened with, so the finalizer can read
 *  `uploadIfLiveUnavailable` without re-resolving anything, and the agent run [AgentLauncher]
 *  prepared for this `gatlingRun` (`null` when the agent is off or could not be attached). */
data class TailerHandle(val tailer: RunTailer, val config: PluginConfig, val agentRun: AgentRun?)

/**
 * Carries the run `gatlingRun`'s `doFirst` opened to `vantrixClose`, which closes it.
 *
 * ═══ TWO TASKS SHARE STATE THROUGH A BUILD SERVICE, NOT A CAPTURED REFERENCE ═══
 *
 * This used to be a plain `AtomicReference` both closures captured. Under Gradle's configuration
 * cache each task's actions are serialized and run from their own deserialized copy, so one
 * reference captured by two tasks becomes two: the close would find nothing and the run would
 * never be closed. A build service is one object for the whole build, which every task that
 * declares `usesService` reaches -- the mechanism Gradle provides for exactly this. Registered
 * once per project, so a multi-project build keeps one handoff each.
 */
abstract class VantrixRunHandoff : BuildService<BuildServiceParameters.None> {
    private val handle = AtomicReference<TailerHandle?>(null)

    fun put(value: TailerHandle) = handle.set(value)

    /** The handle `doFirst` left, at most once: `null` when it never ran or opened nothing. */
    fun take(): TailerHandle? = handle.getAndSet(null)
}
