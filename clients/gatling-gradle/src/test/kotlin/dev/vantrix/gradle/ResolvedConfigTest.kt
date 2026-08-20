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
}
