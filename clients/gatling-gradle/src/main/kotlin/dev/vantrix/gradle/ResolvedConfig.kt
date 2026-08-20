package dev.vantrix.gradle

data class PluginConfig(
    val baseUrl: String, val token: String,
    val environment: String?, val branch: String?, val commitSha: String?,
    val tickSeconds: Int, val uploadIfLiveUnavailable: Boolean, val resultsDir: String?,
)

sealed class ResolvedConfig {
    data class Ok(val config: PluginConfig) : ResolvedConfig()
    data class Missing(val reason: String) : ResolvedConfig()

    companion object {
        fun from(ext: VantrixExtension, env: Map<String, String>): ResolvedConfig {
            val url = (ext.url ?: env["VANTRIX_URL"])?.trimEnd('/')
                ?: return Missing("no Vantrix URL: set vantrix.url or VANTRIX_URL")
            val token = env["VANTRIX_TOKEN"]
                ?: return Missing("no token: set VANTRIX_TOKEN (never a build-file value)")
            return Ok(PluginConfig(
                baseUrl = url, token = token,
                environment = ext.environment ?: env["VANTRIX_ENVIRONMENT"],
                branch = ext.branch ?: env["VANTRIX_BRANCH"],
                commitSha = ext.commitSha ?: env["VANTRIX_COMMIT_SHA"],
                tickSeconds = ext.tickSeconds ?: env["VANTRIX_TICK_SECONDS"]?.toIntOrNull() ?: 5,
                uploadIfLiveUnavailable = ext.uploadIfLiveUnavailable
                    ?: env["VANTRIX_UPLOAD_IF_LIVE_UNAVAILABLE"]?.toBoolean() ?: false,
                resultsDir = ext.resultsDir,
            ))
        }
    }
}
