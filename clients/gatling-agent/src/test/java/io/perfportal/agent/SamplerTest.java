package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SamplerTest {
  @TempDir Path dir;

  private static final boolean LINUX = Sampler.machineRefusal() == null;

  @BeforeEach
  @AfterEach
  void disarmNetty() {
    NettyMemory.disarm();
  }

  @Test
  void emitsOneSampleLinePerSecondWithCumulativeGc() throws Exception {
    Path out = dir.resolve("s.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    Sampler s =
        Sampler.start(w, new SocketRegistry(), ClassLoader.getSystemClassLoader(), LINUX);
    List<String> lines;
    try {
      lines = waitForLines(out, 2, 4_000);
      System.gc();
      lines = waitForLines(out, 3, 3_000);
    } finally {
      s.stop();
      w.close();
    }
    // Read while the writer was still open: each sample is flushed as it is written, so a
    // killed JVM loses at most the second in flight.
    assertTrue(lines.size() >= 3, lines.toString());
    long previousAt = -1;
    long previousGcCount = -1;
    for (String l : lines) {
      assertTrue(l.startsWith("{\"t\":\"s\",\"at\":"), l);
      long at = Long.parseLong(first(l, "\"at\":(\\d+)"));
      if (previousAt >= 0) {
        long gap = at - previousAt;
        assertTrue(gap >= 500 && gap <= 1_600, "one second apart, got " + gap + "ms");
      }
      previousAt = at;
      String gc = first(l, "\"gc\":\\{([^}]*)}");
      assertFalse(gc.isEmpty(), "gc map empty: " + l);
      long gcCount = sumCounts(gc);
      assertTrue(gcCount >= previousGcCount, "gc counts are cumulative: " + l);
      previousGcCount = gcCount;
      assertTrue(l.matches(".*\"heap\":\\[-?\\d+,-?\\d+,-?\\d+].*"), l);
      assertTrue(l.contains("\"netty\":null"), "netty is not read before arm(): " + l);
      assertTrue(l.contains("\"bytes\":{}"), l);
      assertEquals(LINUX, l.contains("\"cpu\":["), l);
      assertEquals(LINUX, l.contains("\"mem\":["), l);
      assertEquals(LINUX, l.contains("\"tcp\":{"), l);
      assertEquals(LINUX, l.contains("\"states\":{"), l);
    }
    assertTrue(previousGcCount >= 1, "System.gc() between samples shows up");
  }

  @Test
  void readsTheMachineAndGatlingsOwnSocketsFromProc() throws Exception {
    Path proc = Path.of(SamplerTest.class.getResource("/proc/stat").toURI()).getParent();
    SocketRegistry r = new SocketRegistry();
    r.opened("established", 0xB78E, "localhost/127.0.0.1:8080");
    r.opened("mapped", 0xB79E, "localhost/127.0.0.1:8080");
    r.opened("closed", 0xB7A0, "localhost/127.0.0.1:8080");
    r.closed("closed", 1_000);
    r.addBytes("localhost/127.0.0.1:8080", 120, 4_000);
    String l = Sampler.sample(1_500, r, null, proc);
    assertTrue(l.contains("\"at\":1500,"), l);
    assertTrue(l.contains("\"cpu\":[2172484,0,2313797,116144375,1779744,0,1596614,0]"), l);
    assertTrue(l.contains("\"mem\":[8022316,6169700]"), l);
    assertTrue(l.contains("\"tcp\":{\"RtoAlgorithm\":1,\"RtoMin\":200,"), l);
    assertTrue(l.contains("\"InCsumErrors\":0}"), l);
    assertTrue(l.contains("\"bytes\":{\"localhost/127.0.0.1:8080\":[120,4000]}"), l);
    // Two ESTABLISHED (one in tcp, one IPv4-mapped in tcp6) and the TIME_WAIT; the listener,
    // the ::1 pair and the outbound 1.1.1.1 socket are not Gatling's.
    assertTrue(
        l.endsWith("\"states\":{\"localhost/127.0.0.1:8080\":{\"1\":2,\"6\":1}}}"), l);
  }

  @Test
  void theFirstUnexpectedErrorIsReportedOnceAndStopsSampling() throws Exception {
    Path out = dir.resolve("e.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    List<String> failures = new CopyOnWriteArrayList<>();
    SocketRegistry broken =
        new SocketRegistry() {
          @Override
          Map<String, long[]> bytesByRemote() {
            throw new IllegalStateException("boom");
          }
        };
    Sampler s =
        Sampler.start(
            w, broken, ClassLoader.getSystemClassLoader(), null, (where, t) -> failures.add(where + ": " + t.getMessage()));
    try {
      s.join(4_000);
      assertFalse(s.alive(), "sampling stopped after the failure");
    } finally {
      s.stop();
      w.close();
    }
    assertEquals(List.of("sampler: boom"), failures);
    assertEquals(List.of(), Files.readAllLines(out));
  }

  @Test
  void stopsOnceTheWriterStopsAccepting() throws Exception {
    Path out = dir.resolve("sealed.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    w.seal();
    Sampler s = Sampler.start(w, new SocketRegistry(), ClassLoader.getSystemClassLoader(), false);
    try {
      s.join(4_000);
      assertFalse(s.alive());
    } finally {
      s.stop();
      w.close();
    }
  }

  @Test
  void ticksOnTheWallClockSecondAndSkipsAheadWhenLate() {
    assertEquals(2_000, Sampler.nextTick(-1, 1_234));
    assertEquals(3_000, Sampler.nextTick(2_000, 2_010));
    // A tick that ran 3.5 s late does not fire three catch-up samples in a burst.
    assertEquals(6_000, Sampler.nextTick(2_000, 5_500));
  }

  @Test
  void runsOnADaemonThreadNamedForTheAgent() throws Exception {
    Path out = dir.resolve("t.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    Sampler s = Sampler.start(w, new SocketRegistry(), ClassLoader.getSystemClassLoader(), false);
    try {
      Thread t =
          Thread.getAllStackTraces().keySet().stream()
              .filter(th -> th.getName().equals("perfportal-agent-sampler"))
              .findFirst()
              .orElseThrow();
      assertTrue(t.isDaemon());
    } finally {
      s.stop();
      w.close();
    }
  }

  @Test
  void saysWhyMachineFiguresAreOff() {
    String os = System.getProperty("os.name");
    if (os.startsWith("Linux")) {
      assertNull(Sampler.machineRefusal());
    } else {
      assertEquals(
          "machine figures are collected on Linux only (os.name=" + os + ")",
          Sampler.machineRefusal());
    }
  }

  @Test
  void nettyIsNotTouchedBeforeArm() throws Exception {
    try (Recording cl = nettyLoader()) {
      assertNull(NettyMemory.read(cl));
      assertTrue(
          cl.loaded.stream().noneMatch(n -> n.startsWith("io.netty.buffer.")),
          "loaded before arm(): " + cl.loaded);

      NettyMemory.arm();
      long[] m = NettyMemory.read(cl);
      assertNotNull(m);
      assertEquals(2, m.length);
      assertTrue(m[0] >= 0 && m[1] >= 0, m[0] + "," + m[1]);
      assertTrue(cl.loaded.contains("io.netty.buffer.ByteBufAllocator"), cl.loaded.toString());
    }
  }

  @Test
  void nettyAbsentReadsAsNull() throws Exception {
    NettyMemory.arm();
    try (URLClassLoader empty = new URLClassLoader(new URL[0], ClassLoader.getPlatformClassLoader())) {
      assertNull(NettyMemory.read(empty));
    }
  }

  @Test
  void onLinuxTheRealProcIsReadable() throws Exception {
    assumeTrue(LINUX, "machine figures are Linux only");
    String l = Sampler.sample(System.currentTimeMillis(), new SocketRegistry(), null, Path.of("/proc"));
    assertTrue(l.matches(".*\"cpu\":\\[\\d+(,\\d+){7}].*"), l);
    assertTrue(l.matches(".*\"mem\":\\[\\d+,\\d+].*"), l);
    assertTrue(l.contains("\"ActiveOpens\":"), l);
  }

  /** A loader holding only Netty's jars, which records every class it defines. */
  static final class Recording extends URLClassLoader {
    final Set<String> loaded = ConcurrentHashMap.newKeySet();

    Recording(URL[] urls) {
      super(urls, ClassLoader.getPlatformClassLoader());
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
      loaded.add(name);
      return super.findClass(name);
    }
  }

  private static Recording nettyLoader() throws Exception {
    List<URL> urls = new ArrayList<>();
    for (String e : System.getProperty("java.class.path").split(File.pathSeparator)) {
      Path p = Path.of(e);
      if (p.getFileName().toString().startsWith("netty-")) urls.add(p.toUri().toURL());
    }
    assertFalse(urls.isEmpty(), "no Netty jars on the test classpath");
    return new Recording(urls.toArray(new URL[0]));
  }

  private static List<String> waitForLines(Path out, int n, long timeoutMs) throws Exception {
    long deadline = System.currentTimeMillis() + timeoutMs;
    List<String> lines = List.of();
    while (System.currentTimeMillis() < deadline) {
      lines = Files.exists(out) ? Files.readAllLines(out) : List.of();
      lines = lines.stream().filter(l -> !l.isEmpty()).collect(Collectors.toList());
      if (lines.size() >= n) return lines;
      Thread.sleep(50);
    }
    return lines;
  }

  private static String first(String s, String regex) {
    Matcher m = Pattern.compile(regex).matcher(s);
    assertTrue(m.find(), regex + " not in " + s);
    return m.group(1);
  }

  private static long sumCounts(String gcBody) {
    Matcher m = Pattern.compile("\":\\[(-?\\d+),-?\\d+]").matcher(gcBody);
    long sum = 0;
    while (m.find()) sum += Math.max(0, Long.parseLong(m.group(1)));
    return sum;
  }
}
