package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.stream.Stream;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Runs a REAL Gatling simulation ({@code probe.ProbeSimulation}) in a child JVM under the shaded
 * agent jar, launched the way the on-prem runner launches it, and reads the NDJSON back.
 *
 * <p>The child's classpath is this test's runtime classpath MINUS the agent's own unshaded
 * classes and its Byte Buddy: the runner never puts either on a simulation's classpath, and if
 * they were there the system class loader would load {@code AgentMain} from them (classpath
 * entries win over the {@code -javaagent} jar) and the shaded artifact would go untested.
 */
class GatlingRunE2ETest {
  /** {@code DEFAULT_JVM_OPTIONS} in apps/runner/src/artifact.ts -- the runner's opens. */
  private static final List<String> RUNNER_OPENS =
      List.of(
          "--add-opens=java.base/java.lang=ALL-UNNAMED",
          "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
          "--add-opens=java.base/java.util=ALL-UNNAMED",
          "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
          "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED");

  /** 30 users x the simulation's two plain-HTTP requests and one HTTPS one. */
  private static final Map<Integer, Long> EXPECTED_CODES = Map.of(200, 60L, 404, 30L);

  /**
   * The fewest bytes a TLS client sends on one connection before its first request: the
   * ClientHello. Gatling here handshakes with BoringSSL (netty-tcnative), which pads every
   * ClientHello to at least 512 bytes. Measured on this simulation: about 1,590 bytes sent per
   * handshake with the meter added at {@code Bootstrap.connect}'s exit, and 126 to 189 with the
   * meter added only after Gatling's own connect listener had run (the ClientHello missed) -- so
   * 512 separates the two by a factor of about three either way.
   */
  private static final long MIN_CLIENT_HELLO_BYTES = 512;

  private static final ObjectMapper JSON = new ObjectMapper();

  @TempDir static Path serverDir;
  @TempDir Path tmp;

  private static HttpServer http;
  private static HttpsServer https;
  private static ExecutorService pool;

  @BeforeAll
  static void startTargets() throws Exception {
    pool = Executors.newFixedThreadPool(16);
    http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 128);
    http.createContext("/", GatlingRunE2ETest::answer);
    http.setExecutor(pool);
    http.start();

    https = HttpsServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 128);
    https.setHttpsConfigurator(new HttpsConfigurator(selfSignedContext(serverDir)));
    https.createContext("/", GatlingRunE2ETest::answer);
    https.setExecutor(pool);
    https.start();
  }

  @AfterAll
  static void stopTargets() {
    if (http != null) http.stop(0);
    if (https != null) https.stop(0);
    if (pool != null) pool.shutdownNow();
  }

  /** 200 for every path but {@code /missing}, which is a 404. */
  private static void answer(HttpExchange ex) throws IOException {
    try (InputStream in = ex.getRequestBody()) {
      in.readAllBytes();
    }
    boolean missing = ex.getRequestURI().getPath().equals("/missing");
    byte[] body = (missing ? "missing" : "ok").getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().add("Content-Type", "text/plain");
    ex.sendResponseHeaders(missing ? 404 : 200, body.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(body);
    }
  }

  @Test
  void recordsEveryEventOfARealGatlingRun() throws Exception {
    Path out = tmp.resolve("agent.ndjson");
    int exit = runGatling("out=" + out, null);
    assertEquals(0, exit, childLog());

    List<Map<String, Object>> lines = readNdjson(out);
    String all = summary(lines);
    assertEquals("perfportal-agent/1", lines.get(0).get("format"), all);
    assertEquals(Boolean.TRUE, ((Map<?, ?>) lines.get(0).get("collects")).get("http"), all);
    assertEquals(requestCountFromSimulationLog(tmp.resolve("results")), count(lines, "status"), all);
    assertEquals(EXPECTED_CODES, statusCodes(lines), all);
    assertTrue(count(lines, "connect", nonWarmup()) > 0, all);
    assertEquals(count(lines, "connect", ok()), count(lines, "close"), all);
    assertTrue(count(lines, "tls", ok(), nonWarmup()) > 0, all);
    assertTrue(count(lines, "connect", warmup()) >= 1, all);
    assertTrue(
        count(lines, "connect", warmup(), remoteStartsWith("127.0.0.1/127.0.0.1:")) >= 1,
        "the warm-up's connect names its remote host/ip:port: " + all);
    assertTrue(count(lines, "dns", hostIs("localhost"), ok()) > 0, all);
    assertEquals(0, count(lines, "dns", hostIs("127.0.0.1")), all);
    assertTrue(count(lines, "s") >= 1, all);
    assertEquals(0, count(lines, "error"), all);

    // Every connect names its remote with the RESOLVED ip, which is what the sampler matches
    // /proc rows by, and carries the agent's own channel id: a number, never shared by two
    // connects, that exactly one close repeats and every tls on the channel carries.
    List<Object> opened = new ArrayList<>();
    for (Map<String, Object> c : select(lines, "connect", ok())) {
      assertTrue(((String) c.get("remote")).matches("[^/]+/[0-9.]+:\\d+"), c.toString());
      assertTrue(c.get("ch") instanceof Number, c.toString());
      opened.add(((Number) c.get("ch")).longValue());
    }
    assertEquals(opened.size(), new HashSet<>(opened).size(), "a ch repeated: " + all);
    List<Object> closed = new ArrayList<>();
    for (Map<String, Object> c : select(lines, "close")) closed.add(((Number) c.get("ch")).longValue());
    assertEquals(new TreeSet<>(opened), new TreeSet<>(closed), all);
    assertEquals(closed.size(), new HashSet<>(closed).size(), "a channel closed twice");
    for (Map<String, Object> t : select(lines, "tls", ok())) {
      assertTrue(opened.contains(((Number) t.get("ch")).longValue()), t.toString());
    }

    // The shutdown writes one final sample, after everything else, carrying the cumulative
    // counters since the last tick: it is the file's last line and its only final sample.
    List<Map<String, Object>> samples = select(lines, "s");
    Map<String, Object> lastSample = samples.get(samples.size() - 1);
    assertEquals(lastSample, lines.get(lines.size() - 1), "the file does not end on a sample");
    assertEquals(Boolean.TRUE, lastSample.get("final"), "the last sample is not the final one");
    assertEquals(1, samples.stream().filter(x -> x.containsKey("final")).count(), all);

    // Bytes are cumulative, so the final sample holds at least every earlier sample's figure.
    Map<?, ?> finalBytes = (Map<?, ?>) lastSample.get("bytes");
    for (Map<String, Object> earlier : samples) {
      for (Map.Entry<?, ?> e : ((Map<?, ?>) earlier.get("bytes")).entrySet()) {
        List<?> was = (List<?>) e.getValue();
        List<?> now = (List<?>) finalBytes.get(e.getKey());
        assertNotNull(now, e.getKey() + " is missing from the final sample " + lastSample);
        for (int i = 0; i < 2; i++) {
          assertTrue(
              ((Number) now.get(i)).longValue() >= ((Number) was.get(i)).longValue(),
              e.getKey() + ": final " + now + " below an earlier " + was);
        }
      }
    }

    // The meter is on the channel before Gatling's own listener can write the ClientHello, so
    // the bytes sent to the TLS remote cover at least one ClientHello for EVERY handshake.
    String tlsRemote = "localhost/127.0.0.1:" + https.getAddress().getPort();
    long handshakes = count(lines, "tls", ok());
    List<?> tlsBytes = (List<?>) finalBytes.get(tlsRemote);
    assertNotNull(tlsBytes, "no bytes for " + tlsRemote + " in " + lastSample);
    long sent = ((Number) tlsBytes.get(0)).longValue();
    // Kept in the test report, so a reader can see what a real run produced.
    System.out.println(
        "agent events " + all + "; warm-up connects " + count(lines, "connect", warmup())
            + "; tls ok " + handshakes + "; bytes to " + tlsRemote + " " + tlsBytes
            + " in the final sample");
    assertEquals(30, handshakes, all);
    assertTrue(
        sent >= handshakes * MIN_CLIENT_HELLO_BYTES,
        "sent " + sent + " bytes to " + tlsRemote + " over " + handshakes + " handshakes");
    assertTrue(((Number) tlsBytes.get(1)).longValue() > 0, lastSample.toString());
  }

  @Test
  void unwritableOutputStillRunsTheSimulation() throws Exception {
    Path readOnly = Files.createDirectory(tmp.resolve("read-only"));
    Files.setPosixFilePermissions(readOnly, PosixFilePermissions.fromString("r-xr-xr-x"));
    try {
      int exit = runGatling("out=" + readOnly.resolve("agent.ndjson"), null);
      assertEquals(0, exit, childLog());
      assertNotNull(simulationLog(tmp.resolve("results")), "no simulation.log was written");
    } finally {
      Files.setPosixFilePermissions(readOnly, PosixFilePermissions.fromString("rwxr-xr-x"));
    }
  }

  @Test
  void relocationSurvivesAnOldByteBuddyOnTheClasspath() throws Exception {
    String old = System.getProperty("oldByteBuddyJar");
    assertTrue(old != null && Files.isRegularFile(Path.of(old)), "oldByteBuddyJar: " + old);
    Path out = tmp.resolve("agent.ndjson");
    int exit = runGatling("out=" + out, Path.of(old));
    assertEquals(0, exit, childLog());
    List<Map<String, Object>> lines = readNdjson(out);
    String all = summary(lines);
    assertEquals(requestCountFromSimulationLog(tmp.resolve("results")), count(lines, "status"), all);
    assertEquals(0, count(lines, "error"), all);
  }

  // ---------------------------------------------------------------- running Gatling

  private int runGatling(String agentArgs, Path prependToClasspath) throws Exception {
    Path conf = Files.createDirectories(tmp.resolve("conf"));
    // Without one, Gatling's logback logs DEBUG to stdout and buries anything worth reading.
    Files.writeString(
        conf.resolve("logback.xml"),
        "<configuration><appender name=\"C\" class=\"ch.qos.logback.core.ConsoleAppender\">"
            + "<encoder><pattern>%d %-5level %logger - %msg%n</pattern></encoder></appender>"
            + "<root level=\"WARN\"><appender-ref ref=\"C\"/></root></configuration>");
    List<String> cmd = new ArrayList<>();
    cmd.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
    cmd.addAll(RUNNER_OPENS);
    cmd.add("-javaagent:" + agentJar() + "=" + agentArgs);
    cmd.add("-Dpp.port=" + http.getAddress().getPort());
    cmd.add("-Dpp.tlsPort=" + https.getAddress().getPort());
    cmd.add("-cp");
    cmd.add(childClasspath(conf, prependToClasspath));
    cmd.add("io.gatling.app.Gatling");
    cmd.add("-s");
    cmd.add("probe.ProbeSimulation");
    cmd.add("-rf");
    cmd.add(tmp.resolve("results").toString());
    cmd.add("--no-reports");
    Process p =
        new ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .redirectOutput(tmp.resolve("child.log").toFile())
            .start();
    if (!p.waitFor(120, TimeUnit.SECONDS)) {
      p.destroyForcibly();
      throw new AssertionError("Gatling did not finish in 120 s:\n" + childLog());
    }
    return p.exitValue();
  }

  private static String childClasspath(Path conf, Path first) {
    List<String> kept = new ArrayList<>();
    if (first != null) kept.add(first.toString());
    kept.add(conf.toString());
    for (String e : System.getProperty("java.class.path").split(File.pathSeparator)) {
      String norm = e.replace('\\', '/');
      if (norm.endsWith("/classes/java/main") || norm.endsWith("/resources/main")) continue;
      if (Path.of(e).getFileName().toString().startsWith("byte-buddy")) continue;
      kept.add(e);
    }
    return String.join(File.pathSeparator, kept);
  }

  private static Path agentJar() {
    String p = System.getProperty("agentJar");
    assertTrue(p != null && !p.isEmpty(), "the agentJar system property is not set");
    return Path.of(p);
  }

  private String childLog() throws IOException {
    Path log = tmp.resolve("child.log");
    return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "(no child log)";
  }

  // ---------------------------------------------------------------- reading the NDJSON

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> readNdjson(Path file) throws IOException {
    List<Map<String, Object>> out = new ArrayList<>();
    for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
      if (!line.isEmpty()) out.add(JSON.readValue(line, Map.class));
    }
    assertTrue(!out.isEmpty(), "the agent wrote nothing");
    return out;
  }

  @SafeVarargs
  private static List<Map<String, Object>> select(
      List<Map<String, Object>> lines, String type, Predicate<Map<String, Object>>... filters) {
    List<Map<String, Object>> out = new ArrayList<>();
    outer:
    for (Map<String, Object> l : lines) {
      if (!type.equals(l.get("t"))) continue;
      for (Predicate<Map<String, Object>> f : filters) if (!f.test(l)) continue outer;
      out.add(l);
    }
    return out;
  }

  @SafeVarargs
  private static long count(
      List<Map<String, Object>> lines, String type, Predicate<Map<String, Object>>... filters) {
    return select(lines, type, filters).size();
  }

  private static Predicate<Map<String, Object>> ok() {
    return l -> Boolean.TRUE.equals(l.get("ok"));
  }

  private static Predicate<Map<String, Object>> warmup() {
    return l -> Boolean.TRUE.equals(l.get("warmup"));
  }

  private static Predicate<Map<String, Object>> nonWarmup() {
    return l -> !l.containsKey("warmup");
  }

  private static Predicate<Map<String, Object>> hostIs(String host) {
    return l -> host.equals(l.get("host"));
  }

  private static Predicate<Map<String, Object>> remoteStartsWith(String prefix) {
    return l -> l.get("remote") instanceof String && ((String) l.get("remote")).startsWith(prefix);
  }

  private static Map<Integer, Long> statusCodes(List<Map<String, Object>> lines) {
    Map<Integer, Long> out = new TreeMap<>();
    for (Map<String, Object> s : select(lines, "status")) {
      out.merge(((Number) s.get("code")).intValue(), 1L, Long::sum);
    }
    return out;
  }

  /** Event counts by type, for failure messages. */
  private static String summary(List<Map<String, Object>> lines) {
    Map<String, Integer> byType = new TreeMap<>();
    for (Map<String, Object> l : lines) byType.merge(String.valueOf(l.get("t")), 1, Integer::sum);
    List<Map<String, Object>> errors = select(lines, "error");
    return byType + (errors.isEmpty() ? "" : " errors=" + errors);
  }

  // ---------------------------------------------------------------- reading simulation.log

  private static Path simulationLog(Path results) throws IOException {
    if (!Files.isDirectory(results)) return null;
    try (Stream<Path> s = Files.walk(results)) {
      return s.filter(p -> p.getFileName().toString().equals("simulation.log"))
          .findFirst()
          .orElse(null);
    }
  }

  /**
   * The number of REQUEST records in Gatling's binary {@code simulation.log}: the requests the
   * simulation made, as Gatling itself counts them. The format is the one
   * packages/plugin-gatling decodes (header.ts, record-decoder.ts, reader.ts).
   */
  private static long requestCountFromSimulationLog(Path results) throws IOException {
    Path log = simulationLog(results);
    assertNotNull(log, "no simulation.log under " + results);
    long requests = 0;
    try (DataInputStream in =
        new DataInputStream(new java.io.BufferedInputStream(Files.newInputStream(log)))) {
      assertEquals(0, in.readByte(), "not a Run record");
      skipString(in); // gatling version
      skipString(in); // simulation class
      in.readLong(); // run start
      skipString(in); // description
      int scenarios = in.readInt();
      for (int i = 0; i < scenarios; i++) skipString(in);
      int assertions = in.readInt();
      for (int i = 0; i < assertions; i++) skip(in, in.readInt());
      while (true) {
        int type;
        try {
          type = in.readByte();
        } catch (EOFException end) {
          return requests;
        }
        switch (type) {
          case 1: // request
            skipGroups(in);
            skipCachedString(in); // name
            in.readInt(); // start
            in.readInt(); // end
            in.readByte(); // ok
            skipCachedString(in); // message
            requests++;
            break;
          case 2: // user
            in.readInt();
            in.readByte();
            in.readInt();
            break;
          case 3: // group
            skipGroups(in);
            in.readInt();
            in.readInt();
            in.readInt();
            in.readByte();
            break;
          case 4: // error
            skipCachedString(in);
            in.readInt();
            break;
          default:
            throw new AssertionError("unknown simulation.log record type " + type);
        }
      }
    }
  }

  private static void skipString(DataInputStream in) throws IOException {
    int len = in.readInt();
    if (len == 0) return;
    skip(in, len + 1); // the bytes and the coder byte
  }

  // DataInputStream.skipNBytes is Java 12; these tests compile for 11, as the agent does.
  private static void skip(DataInputStream in, int n) throws IOException {
    in.readFully(new byte[n]);
  }

  private static void skipCachedString(DataInputStream in) throws IOException {
    if (in.readInt() >= 0) skipString(in); // a negative index is a back-reference, nothing follows
  }

  private static void skipGroups(DataInputStream in) throws IOException {
    int n = in.readInt();
    for (int i = 0; i < n; i++) skipCachedString(in);
  }

  // ---------------------------------------------------------------- the HTTPS target's key

  /** A TLS context over a self-signed key made by the JDK's own keytool, for the HTTPS target. */
  private static SSLContext selfSignedContext(Path dir) throws Exception {
    Path store = dir.resolve("target.p12");
    char[] pass = "changeit".toCharArray();
    Process kt =
        new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair",
                "-alias",
                "target",
                "-keyalg",
                "EC",
                "-groupname",
                "secp256r1",
                "-dname",
                "CN=localhost",
                "-ext",
                "SAN=dns:localhost,ip:127.0.0.1",
                "-validity",
                "2",
                "-storetype",
                "PKCS12",
                "-keystore",
                store.toString(),
                "-storepass",
                new String(pass))
            .redirectErrorStream(true)
            .start();
    String ktOut = new String(kt.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertTrue(kt.waitFor(60, TimeUnit.SECONDS) && kt.exitValue() == 0, "keytool: " + ktOut);
    KeyStore ks = KeyStore.getInstance("PKCS12");
    try (InputStream in = Files.newInputStream(store)) {
      ks.load(in, pass);
    }
    KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    kmf.init(ks, pass);
    SSLContext ctx = SSLContext.getInstance("TLS");
    ctx.init(kmf.getKeyManagers(), null, null);
    return ctx;
  }
}
