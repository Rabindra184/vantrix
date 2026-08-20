package dev.vantrix.gradle

open class VantrixExtension {
    var url: String? = null
    var environment: String? = null
    var branch: String? = null
    var commitSha: String? = null
    var tickSeconds: Int? = null
    var uploadIfLiveUnavailable: Boolean? = null
    var resultsDir: String? = null   // default applied at wiring time: build/reports/gatling
}
