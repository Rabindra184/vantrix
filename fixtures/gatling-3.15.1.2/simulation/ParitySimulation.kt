package example

import io.gatling.javaapi.core.CoreDsl.*
import io.gatling.javaapi.http.HttpDsl.*
import io.gatling.javaapi.core.*
import io.gatling.javaapi.http.*
import java.time.Duration

/**
 * Reference fixture for the Perf Portal Gatling parity matrix (PRD Appendix A).
 *
 * Deliberately exercises every element the matrix claims exists:
 *   - two scenarios                      -> S-01..S-04
 *   - groups, including a nested group   -> GR-01..GR-09
 *   - varied latency shapes              -> distribution, percentile bands, indicator bands
 *   - two distinct failure messages      -> G-17 error table, R-11
 *   - passing AND failing assertions     -> G-05 assertions table, both statuses
 *   - ramp + steady phases               -> active users, requests/s vs responses/s
 *
 * Targets a local server only. No external traffic.
 */
class ParitySimulation : Simulation() {

    private val httpProtocol: HttpProtocolBuilder = http
        .baseUrl("http://127.0.0.1:8099")
        .acceptHeader("application/json")
        .shareConnections()

    private val browse: ScenarioBuilder = scenario("Browse")
        .group("Catalog").on(
            exec(http("List Products").get("/fast")),
            pause(Duration.ofMillis(100)),
            exec(http("Product Detail").get("/medium")),
            group("Recommendations").on(
                exec(http("Related Items").get("/spiky"))
            )
        )
        .pause(Duration.ofMillis(150))
        .exec(http("Search").get("/slow"))

    private val checkout: ScenarioBuilder = scenario("Checkout")
        .group("Cart").on(
            exec(http("Add To Cart").get("/flaky").check(status().`is`(200))),
            pause(Duration.ofMillis(80)),
            exec(http("View Cart").get("/fast"))
        )
        .pause(Duration.ofMillis(120))
        .exec(http("Place Order").get("/unstable").check(status().`is`(200)))

    init {
        setUp(
            browse.injectOpen(
                rampUsers(40).during(Duration.ofSeconds(20)),
                constantUsersPerSec(3.0).during(Duration.ofSeconds(40))
            ),
            checkout.injectOpen(
                nothingFor(Duration.ofSeconds(5)),
                rampUsers(25).during(Duration.ofSeconds(25)),
                constantUsersPerSec(2.0).during(Duration.ofSeconds(30))
            )
        )
            .assertions(
                global().responseTime().max().lt(10000),            // expect PASS
                global().successfulRequests().percent().gt(80.0),   // expect PASS
                details("Search").responseTime().percentile3().lt(100)  // expect FAIL
            )
            .protocols(httpProtocol)
    }
}
