package example

import io.gatling.javaapi.core.CoreDsl.*
import io.gatling.javaapi.http.HttpDsl.*
import io.gatling.javaapi.core.*
import io.gatling.javaapi.http.*

/**
 * A CORPUS, not a load test.
 *
 * Gatling writes its assertions into the simulation.log HEADER, at start, before
 * any traffic. So the cheapest way to learn the encoding for every
 * Path x Target x Condition is to declare many assertions and run the smallest
 * possible simulation: one user, one request. The traffic is irrelevant and
 * deliberately negligible; only the header is read.
 *
 * Each assertion below is numbered in a fixed order so the decoded bytes can be
 * lined up against a known meaning one-for-one.
 */
class AssertionCorpus : Simulation() {

    private val httpProtocol: HttpProtocolBuilder = http
        .baseUrl("https://api-ecomm.gatling.io")
        .acceptHeader("application/json")

    private val scn: ScenarioBuilder = scenario("Corpus")
        .exec(http("Session").get("/session"))

    init {
        setUp(scn.injectOpen(atOnceUsers(1)))
            .assertions(
                // ── Paths ────────────────────────────────────────────────
                global().responseTime().max().lt(1),                 //  0 global
                forAll().responseTime().max().lt(2),                 //  1 forAll
                details("Session").responseTime().max().lt(3),       //  2 details, 1 part
                details("A", "B").responseTime().max().lt(4),        //  3 details, 2 parts

                // ── Targets: response time ───────────────────────────────
                global().responseTime().min().lt(10),                //  4
                global().responseTime().max().lt(11),                //  5
                global().responseTime().mean().lt(12),               //  6
                global().responseTime().stdDev().lt(13),             //  7
                global().responseTime().percentile1().lt(14),        //  8
                global().responseTime().percentile2().lt(15),        //  9
                global().responseTime().percentile3().lt(16),        // 10
                global().responseTime().percentile4().lt(17),        // 11
                global().responseTime().percentile(99.9).lt(18),     // 12

                // ── Targets: counts and percents ─────────────────────────
                // The percent and rate targets are Double-valued; the count and
                // response-time ones are Int. Mixing the literal types is what
                // the compiler is telling us about the metric, so keep them.
                global().allRequests().count().lt(20),               // 13
                global().allRequests().percent().lt(21.0),           // 14
                global().failedRequests().count().lt(22),            // 15
                global().failedRequests().percent().lt(23.0),        // 16
                global().successfulRequests().count().lt(24),        // 17
                global().successfulRequests().percent().lt(25.0),    // 18
                global().requestsPerSec().lt(26.0),                  // 19

                // ── Conditions ───────────────────────────────────────────
                global().responseTime().max().lt(30),                // 20 lt
                global().responseTime().max().lte(31),               // 21 lte
                global().responseTime().max().gt(32),                // 22 gt
                global().responseTime().max().gte(33),               // 23 gte
                global().responseTime().max().between(34, 35),       // 24 between
                global().responseTime().max().around(36, 37),        // 25 around
                global().responseTime().max().deviatesAround(38, 0.5), // 26 deviatesAround
                global().responseTime().max().shouldBe(39),          // 27 is
                global().responseTime().max().`in`(40, 41, 42),      // 28 in
            )
            .protocols(httpProtocol)
    }
}
