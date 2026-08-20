package dev.vantrix.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project

class VantrixPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.logger.info("vantrix: plugin applied")
    }
}
