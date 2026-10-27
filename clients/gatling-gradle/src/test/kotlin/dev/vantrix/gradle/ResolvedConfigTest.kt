package dev.vantrix.gradle

import org.junit.jupiter.api.Test
import kotlin.test.*

class ResolvedConfigTest {
    private fun ext() = VantrixExtension()

    @Test fun `DSL value wins over env`() {
        val e = ext().apply { url = "https://dsl.example" }
        val r = ResolvedConfig.from(e, mapOf("VANTRIX_URL" to "https://env.example",
                                             "VANTRIX_TOKEN" to "pp_x_y"))
        assertEquals("https://dsl.example", (r as ResolvedConfig.Ok).config.baseUrl)
    }

    @Test fun `env fills what the DSL leaves unset`() {
        val r = ResolvedConfig.from(ext(), mapOf("VANTRIX_URL" to "https://env.example",
                                                 "VANTRIX_ENVIRONMENT" to "staging",
                                                 "VANTRIX_TOKEN" to "pp_x_y"))
        val c = (r as ResolvedConfig.Ok).config
        assertEquals("staging", c.environment)
    }

    @Test fun `token comes from env only -- there is no DSL property to set`() {
        // Compile-time property absence is the real guard; this pins the runtime half.
        val r = ResolvedConfig.from(ext().apply { url = "https://x.example" }, emptyMap())
        assertTrue(r is ResolvedConfig.Missing && "VANTRIX_TOKEN" in r.reason)
    }

    @Test fun `no url is a stated reason, not a crash`() {
        val r = ResolvedConfig.from(ext(), mapOf("VANTRIX_TOKEN" to "pp_x_y"))
        assertTrue(r is ResolvedConfig.Missing && "VANTRIX_URL" in r.reason)
    }

    @Test fun `defaults -- tick 5, upload fallback off`() {
        val c = (ResolvedConfig.from(ext().apply { url = "https://x.example" },
                 mapOf("VANTRIX_TOKEN" to "t")) as ResolvedConfig.Ok).config
        assertEquals(5, c.tickSeconds)
        assertFalse(c.uploadIfLiveUnavailable)
    }

    @Test fun `trailing slash on url is normalised away`() {
        val c = (ResolvedConfig.from(ext().apply { url = "https://x.example/" },
                 mapOf("VANTRIX_TOKEN" to "t")) as ResolvedConfig.Ok).config
        assertEquals("https://x.example", c.baseUrl)
    }

    // ---- agentEnabled: extension, then VANTRIX_AGENT, then on ----

    private fun agentFor(e: VantrixExtension, env: Map<String, String> = emptyMap()): Boolean =
        (ResolvedConfig.from(e.apply { url = "https://x.example" }, env + ("VANTRIX_TOKEN" to "t"))
            as ResolvedConfig.Ok).config.agentEnabled

    @Test fun `the agent is on by default`() {
        assertTrue(agentFor(ext()))
    }

    @Test fun `the extension can turn the agent off`() {
        assertFalse(agentFor(ext().apply { agent = false }))
    }

    @Test fun `VANTRIX_AGENT=false turns the agent off`() {
        assertFalse(agentFor(ext(), mapOf("VANTRIX_AGENT" to "false")))
    }

    @Test fun `the extension wins over VANTRIX_AGENT`() {
        assertTrue(agentFor(ext().apply { agent = true }, mapOf("VANTRIX_AGENT" to "false")))
        assertFalse(agentFor(ext().apply { agent = false }, mapOf("VANTRIX_AGENT" to "true")))
    }

    @Test fun `a blank or unrecognised VANTRIX_AGENT leaves the agent on`() {
        // Compose passes an unset variable as "", and "".toBoolean() is false: a default-on
        // switch must not be turned off by a value nobody chose.
        assertTrue(agentFor(ext(), mapOf("VANTRIX_AGENT" to "")))
        assertTrue(agentFor(ext(), mapOf("VANTRIX_AGENT" to "yes")))
        assertFalse(agentFor(ext(), mapOf("VANTRIX_AGENT" to " FALSE ")))
    }
}
