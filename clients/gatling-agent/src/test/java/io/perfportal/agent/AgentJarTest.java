package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarFile;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Tests the SHADED artifact the runner will pass to -javaagent, not the classes. */
class AgentJarTest {
  @TempDir Path dir;
  // Separate from dir, so the no-output case can assert dir stays empty.
  @TempDir Path logs;

  /** The child JVM's main: does nothing, so all output is the agent's. */
  public static final class Noop {
    public static void main(String[] args) {}
  }

  /** Lives long enough for the sampler to tick twice. */
  public static final class Sleeper {
    public static void main(String[] args) throws InterruptedException {
      Thread.sleep(2_600);
    }
  }

  // The child runs on this JVM's OS, so it collects machine figures exactly when this one could.
  private static final String MACHINE_REFUSAL = Sampler.machineRefusal();
  private static final boolean MACHINE = MACHINE_REFUSAL == null;

  private static Path agentJar() {
    String p = System.getProperty("agentJar");
    assertTrue(p != null && !p.isEmpty(), "the agentJar system property is not set");
    return Path.of(p);
  }

  @Test
  void relocatesByteBuddyAndDeclaresThePremain() throws Exception {
    try (JarFile jar = new JarFile(agentJar().toFile())) {
      List<String> names = new ArrayList<>();
      Collections.list(jar.entries()).forEach(e -> names.add(e.getName()));
      assertFalse(
          names.stream().anyMatch(n -> n.startsWith("net/bytebuddy/")),
          "unrelocated Byte Buddy in the agent jar");
      assertTrue(
          names.stream().anyMatch(n -> n.startsWith("io/perfportal/agent/shaded/bytebuddy/")),
          "no relocated Byte Buddy in the agent jar");
      assertTrue(names.contains("io/perfportal/agent/AgentMain.class"));
      assertFalse(
          names.stream().anyMatch(n -> n.startsWith("io/gatling/")), "Gatling bundled in the agent");
      assertEquals(
          "io.perfportal.agent.AgentMain",
          jar.getManifest().getMainAttributes().getValue("Premain-Class"));
    }
  }

  @Test
  void writesTheHeaderFirstInARealJvm() throws Exception {
    Path out = dir.resolve("agent.ndjson");
    Process p = run("out=" + out, true);
    assertEquals(0, p.exitValue(), output(p));
    List<String> lines = Files.readAllLines(out);
    assertTrue(lines.size() >= 1, "no header written");
    String h = lines.get(0);
    assertTrue(h.startsWith("{\"t\":\"header\",\"format\":\"perfportal-agent/1\","), h);
    assertTrue(h.contains("\"agentVersion\":\"0.1.0\""), h);
    assertTrue(h.contains("\"gatlingHttpClient\":\"3.15.1\""), h);
    assertTrue(h.contains("\"gatlingHttp\":\"3.15.1\""), h);
    assertTrue(h.contains("\"collects\":{\"http\":true,\"machine\":" + MACHINE + "}"), h);
    assertTrue(
        h.contains(
            "\"reasons\":"
                + (MACHINE ? "{}" : "{\"machine\":" + EventWriter.quote(MACHINE_REFUSAL) + "}")),
        h);
    assertTrue(h.matches(".*\"startedAt\":\\d+.*"), h);
  }

  @Test
  void namesItsHostInTheHeader() throws Exception {
    Path out = dir.resolve("agent.ndjson");
    Process p = run("out=" + out, true);
    assertEquals(0, p.exitValue(), output(p));
    String h = Files.readAllLines(out).get(0);
    assertTrue(h.contains("\"host\":"), h);
    // Still one JSON object, the host a string (or null when the JVM cannot name it).
    JsonNode header = new ObjectMapper().readTree(h);
    assertTrue(header.isObject(), h);
    JsonNode host = header.get("host");
    assertTrue(host.isTextual() || host.isNull(), h);
    // The child runs on this machine, so it names the host this JVM does.
    String expected;
    try {
      expected = InetAddress.getLocalHost().getHostName();
    } catch (Exception e) {
      expected = null;
    }
    assertEquals(expected, host.isNull() ? null : host.asText(), h);
  }

  @Test
  void saysWhyHttpIsOffWhenGatlingIsAbsent() throws Exception {
    Path out = dir.resolve("agent.ndjson");
    Process p = run("out=" + out, false);
    assertEquals(0, p.exitValue(), output(p));
    String h = Files.readAllLines(out).get(0);
    assertTrue(h.contains("\"collects\":{\"http\":false,\"machine\":" + MACHINE + "}"), h);
    assertTrue(
        h.contains(
            "\"reasons\":{\"http\":\"gatling-http-client was not found on the classpath\""
                + (MACHINE ? "" : ",\"machine\":" + EventWriter.quote(MACHINE_REFUSAL))
                + "}"),
        h);
    assertTrue(h.contains("\"gatlingHttpClient\":null"), h);
  }

  @Test
  void samplesEverySecondEvenWhenHttpCollectionIsOff() throws Exception {
    Path out = dir.resolve("agent.ndjson");
    Process p = run("out=" + out, false, Sleeper.class);
    assertEquals(0, p.exitValue(), output(p));
    List<String> lines = Files.readAllLines(out);
    assertTrue(lines.get(0).contains("\"collects\":{\"http\":false,"), lines.get(0));
    List<String> samples = lines.subList(1, lines.size());
    assertTrue(samples.size() >= 2, "two ticks in 2.6 s: " + lines);
    for (String s : samples) {
      assertTrue(s.startsWith("{\"t\":\"s\",\"at\":"), s);
      assertEquals(MACHINE, s.contains("\"cpu\":["), s);
    }
  }

  @Test
  void anUnwritableOutputNeverFailsTheJvm() throws Exception {
    Path out = dir.resolve("no-such-dir/sub/agent.ndjson");
    Files.writeString(dir.resolve("no-such-dir"), "a file, not a directory");
    Process p = run("out=" + out, true);
    assertEquals(0, p.exitValue(), output(p));
  }

  @Test
  void noOutputOptionMeansTheAgentStaysQuiet() throws Exception {
    Process p = run("", true);
    assertEquals(0, p.exitValue(), output(p));
    try (var files = Files.list(dir)) {
      assertEquals(0, files.count());
    }
  }

  private Process run(String agentArgs, boolean withGatling) throws Exception {
    return run(agentArgs, withGatling, Noop.class);
  }

  private Process run(String agentArgs, boolean withGatling, Class<?> main) throws Exception {
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    String cp = System.getProperty("java.class.path");
    if (!withGatling) {
      StringBuilder kept = new StringBuilder();
      for (String e : cp.split(File.pathSeparator)) {
        if (Path.of(e).getFileName().toString().startsWith("gatling-")) continue;
        if (kept.length() > 0) kept.append(File.pathSeparator);
        kept.append(e);
      }
      cp = kept.toString();
    }
    String agent = "-javaagent:" + agentJar() + (agentArgs.isEmpty() ? "" : "=" + agentArgs);
    Process p =
        new ProcessBuilder(java, agent, "-cp", cp, main.getName())
            .redirectErrorStream(true)
            .redirectOutput(logs.resolve("child.log").toFile())
            .start();
    assertTrue(p.waitFor(60, TimeUnit.SECONDS), "child JVM did not exit");
    return p;
  }

  private String output(Process p) throws Exception {
    Path log = logs.resolve("child.log");
    return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "";
  }
}
