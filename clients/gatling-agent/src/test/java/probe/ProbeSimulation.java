package probe;

import static io.gatling.javaapi.core.CoreDsl.rampUsers;
import static io.gatling.javaapi.core.CoreDsl.scenario;
import static io.gatling.javaapi.http.HttpDsl.http;
import static io.gatling.javaapi.http.HttpDsl.status;

import io.gatling.javaapi.core.ScenarioBuilder;
import io.gatling.javaapi.core.Simulation;
import io.gatling.javaapi.http.HttpProtocolBuilder;
import java.time.Duration;

/**
 * The simulation {@code GatlingRunE2ETest} runs under the agent: 30 users, each making three
 * requests -- a 200 and a 404 over plain HTTP and a 200 over HTTPS -- against servers the test
 * starts on the ports it passes in {@code pp.port} and {@code pp.tlsPort}.
 *
 * <p>Hosts are named {@code localhost} so DNS resolution happens; users share no connections
 * (Gatling's default), so every user opens its own channels. The warm-up goes to the IP LITERAL
 * {@code 127.0.0.1}: its connect must be tagged as warm-up, and it is the one lookup Gatling hands
 * its resolver that must NOT be reported as DNS.
 */
public class ProbeSimulation extends Simulation {
  private static final int PORT = Integer.getInteger("pp.port");
  private static final int TLS_PORT = Integer.getInteger("pp.tlsPort");

  HttpProtocolBuilder protocol =
      http.baseUrl("http://localhost:" + PORT)
          .warmUp("http://127.0.0.1:" + PORT + "/warm")
          .acceptHeader("text/plain");

  ScenarioBuilder scn =
      scenario("Probe")
          .exec(http("Ok").get("/ok"))
          .exec(http("Missing").get("/missing").check(status().is(404)))
          .exec(http("Secure").get("https://localhost:" + TLS_PORT + "/ok"));

  {
    setUp(scn.injectOpen(rampUsers(30).during(Duration.ofSeconds(3)))).protocols(protocol);
  }
}
