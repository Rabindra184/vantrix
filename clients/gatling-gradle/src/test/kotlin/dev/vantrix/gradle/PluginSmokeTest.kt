package dev.vantrix.gradle

import org.gradle.testfixtures.ProjectBuilder
import org.junit.jupiter.api.Test
import kotlin.test.assertNotNull

class PluginSmokeTest {
    @Test fun `plugin applies by id`() {
        val project = ProjectBuilder.builder().build()
        project.pluginManager.apply("dev.vantrix.gatling")
        assertNotNull(project.plugins.findPlugin(VantrixPlugin::class.java))
    }
}
