package dev.vantrix.gradle

open class VantrixExtension {
    var url: String? = null
    var environment: String? = null
    var branch: String? = null
    var commitSha: String? = null

    /**
     * Which TEST these runs are of, as a slug — `checkout-soak`, not
     * "Checkout soak".
     *
     * Optional, and leaving it unset keeps the platform's original behaviour:
     * runs group by the simulation class in the log header. Setting it is what
     * lets ONE simulation be run as TWO tests with different injection
     * profiles, which is the only way to express that at all.
     *
     * A slug naming no existing test creates it, so a pipeline needs no setup
     * step in the UI first.
     */
    var test: String? = null
    var tickSeconds: Int? = null
    var uploadIfLiveUnavailable: Boolean? = null
    var resultsDir: String? = null   // default applied at wiring time: build/reports/gatling
}
