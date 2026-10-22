package io.perfportal.agent;

import java.io.IOException;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;

/**
 * Writes one {@code {"t":"s",...}} line a second, on the wall-clock second, from a daemon thread
 * named {@code perfportal-agent-sampler}:
 *
 * <pre>{"t":"s","at":&lt;ms&gt;,"gc":{"&lt;collector&gt;":[count,timeMs],...},"heap":[used,committed,max],
 *  "netty":[direct,heap]|null,"cpu":[8 jiffies],"mem":[totalKb,availableKb],"tcp":{&lt;Tcp fields&gt;},
 *  "bytes":{"&lt;remote&gt;":[out,in]},"states":{"&lt;remote&gt;":{"&lt;st&gt;":n}}}</pre>
 *
 * <p>Every counter is CUMULATIVE -- GC counts and times, CPU jiffies, the TCP counters, bytes --
 * and the reader differences consecutive samples; gauges (heap, Netty, memory, states) are as
 * read. {@code cpu}, {@code mem}, {@code tcp} and {@code states} are machine figures, present
 * only on Linux with a readable {@code /proc} (and each absent for a second it could not be
 * read); {@code netty} is null until the instrumentation has seen a connect.
 *
 * <p>The line is flushed as it is written, so a JVM killed mid-run loses at most one second. The
 * first unexpected error is reported once, through the agent's failure path, and sampling stops:
 * nothing is ever thrown into the simulation.
 */
final class Sampler {
  static final String THREAD_NAME = "perfportal-agent-sampler";
  private static final long PERIOD_MS = 1_000;

  private final Thread thread;

  private Sampler(Thread thread) {
    this.thread = thread;
  }

  /**
   * Starts sampling into {@code writer}. {@code linux} is {@link #machineRefusal()} {@code ==
   * null}: whether the machine figures are read from {@code /proc}.
   */
  static Sampler start(EventWriter writer, SocketRegistry sockets, ClassLoader cl, boolean linux) {
    return start(writer, sockets, cl, linux ? Path.of("/proc") : null, AgentMain::fail);
  }

  /** As above, reading machine figures under {@code procRoot} (null: none). */
  static Sampler start(
      EventWriter writer,
      SocketRegistry sockets,
      ClassLoader cl,
      Path procRoot,
      BiConsumer<String, Throwable> onFailure) {
    Thread t = new Thread(() -> loop(writer, sockets, cl, procRoot, onFailure), THREAD_NAME);
    t.setDaemon(true);
    t.start();
    return new Sampler(t);
  }

  void stop() {
    thread.interrupt();
  }

  void join(long millis) throws InterruptedException {
    thread.join(millis);
  }

  boolean alive() {
    return thread.isAlive();
  }

  /**
   * Null when machine figures can be collected here, otherwise why not -- the header's {@code
   * reasons.machine}.
   */
  static String machineRefusal() {
    String os = System.getProperty("os.name", "");
    if (!os.startsWith("Linux")) {
      return "machine figures are collected on Linux only (os.name=" + os + ")";
    }
    if (!Files.isDirectory(Path.of("/proc/self")) || !Files.isReadable(Path.of("/proc/stat"))) {
      return "machine figures need a readable /proc, which this Linux does not have";
    }
    return null;
  }

  private static void loop(
      EventWriter writer,
      SocketRegistry sockets,
      ClassLoader cl,
      Path procRoot,
      BiConsumer<String, Throwable> onFailure) {
    try {
      long tick = nextTick(-1, System.currentTimeMillis());
      while (writer.accepting()) {
        long wait = tick - System.currentTimeMillis();
        if (wait > 0) Thread.sleep(wait);
        long at = System.currentTimeMillis();
        sockets.prune(at);
        String line = sample(at, sockets, cl, procRoot);
        writer.line(line);
        writer.flush();
        tick = nextTick(tick, System.currentTimeMillis());
      }
    } catch (InterruptedException e) {
      // stopped
    } catch (Throwable t) {
      onFailure.accept("sampler", t);
    }
  }

  /**
   * The tick after {@code previous}, one second on; or, when that has already passed (or there
   * is none), the next whole wall-clock second after {@code now}. A late tick is skipped rather
   * than fired in a burst: a sample is a reading, and three in one instant say nothing.
   */
  static long nextTick(long previous, long now) {
    long next = previous + PERIOD_MS;
    if (previous >= 0 && next > now) return next;
    return (now / PERIOD_MS + 1) * PERIOD_MS;
  }

  /** One sample line, read now. Machine figures come from under {@code procRoot}, if any. */
  static String sample(long at, SocketRegistry sockets, ClassLoader cl, Path procRoot) {
    StringBuilder b = new StringBuilder(512);
    b.append("{\"t\":\"s\",\"at\":").append(at);

    b.append(",\"gc\":{");
    boolean first = true;
    for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
      if (!first) b.append(',');
      first = false;
      b.append(EventWriter.quote(gc.getName()))
          .append(":[")
          .append(gc.getCollectionCount())
          .append(',')
          .append(gc.getCollectionTime())
          .append(']');
    }
    b.append('}');

    MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
    b.append(",\"heap\":[")
        .append(heap.getUsed())
        .append(',')
        .append(heap.getCommitted())
        .append(',')
        .append(heap.getMax())
        .append(']');

    long[] netty = NettyMemory.read(cl);
    b.append(",\"netty\":");
    if (netty == null) b.append("null");
    else appendArray(b, netty);

    if (procRoot != null) {
      String stat = read(procRoot.resolve("stat"));
      long[] cpu = stat == null ? null : ProcStat.parse(stat);
      if (cpu != null) appendArray(b.append(",\"cpu\":"), cpu);

      String meminfo = read(procRoot.resolve("meminfo"));
      long[] mem = meminfo == null ? null : ProcMeminfo.parse(meminfo);
      if (mem != null) appendArray(b.append(",\"mem\":"), mem);

      String snmp = read(procRoot.resolve("net/snmp"));
      Map<String, Long> tcp = snmp == null ? null : ProcSnmp.parseTcp(snmp);
      if (tcp != null) {
        b.append(",\"tcp\":{");
        first = true;
        for (Map.Entry<String, Long> e : tcp.entrySet()) {
          if (!first) b.append(',');
          first = false;
          b.append(EventWriter.quote(e.getKey())).append(':').append(e.getValue());
        }
        b.append('}');
      }
    }

    b.append(",\"bytes\":{");
    first = true;
    for (Map.Entry<String, long[]> e : sockets.bytesByRemote().entrySet()) {
      if (!first) b.append(',');
      first = false;
      appendArray(b.append(EventWriter.quote(e.getKey())).append(':'), e.getValue());
    }
    b.append('}');

    if (procRoot != null) {
      List<ProcTcp.Row> rows = new ArrayList<>();
      String tcp4 = read(procRoot.resolve("net/tcp"));
      String tcp6 = read(procRoot.resolve("net/tcp6"));
      if (tcp4 != null) rows.addAll(ProcTcp.parse(tcp4));
      if (tcp6 != null) rows.addAll(ProcTcp.parse(tcp6));
      if (tcp4 != null || tcp6 != null) {
        b.append(",\"states\":{");
        first = true;
        for (Map.Entry<String, Map<Integer, Integer>> e : sockets.statesByRemote(rows, at).entrySet()) {
          if (!first) b.append(',');
          first = false;
          b.append(EventWriter.quote(e.getKey())).append(":{");
          boolean firstState = true;
          for (Map.Entry<Integer, Integer> st : e.getValue().entrySet()) {
            if (!firstState) b.append(',');
            firstState = false;
            b.append('"').append(st.getKey()).append("\":").append(st.getValue());
          }
          b.append('}');
        }
        b.append('}');
      }
    }

    return b.append('}').toString();
  }

  private static void appendArray(StringBuilder b, long[] values) {
    b.append('[');
    for (int i = 0; i < values.length; i++) {
      if (i > 0) b.append(',');
      b.append(values[i]);
    }
    b.append(']');
  }

  /** A {@code /proc} file's content, or null when it cannot be read this second. */
  private static String read(Path file) {
    try {
      return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }
}
