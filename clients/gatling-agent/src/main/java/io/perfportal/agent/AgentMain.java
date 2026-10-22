package io.perfportal.agent;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The {@code Premain-Class}: loaded by {@code -javaagent:gatling-agent.jar=out=<path>[,max=<n>]}
 * into a Gatling JVM, before the simulation starts.
 *
 * <p>The one rule is that the agent never fails or alters the simulation. Everything runs inside
 * {@code catch (Throwable)}; a failure writes at most one {@code error} line and stops
 * collection, and the JVM carries on exactly as it would have without the agent.
 */
public final class AgentMain {
  static final String VERSION = "0.1.0";
  static final String FORMAT = "perfportal-agent/1";

  private static volatile EventWriter writer;
  private static final AtomicBoolean failed = new AtomicBoolean();
  private static final SocketRegistry sockets = new SocketRegistry();

  private AgentMain() {}

  public static void premain(String agentArgs, java.lang.instrument.Instrumentation inst) {
    try {
      AgentOptions options = AgentOptions.parse(agentArgs);
      if (options.isDisabled()) return;
      EventWriter w = EventWriter.open(options.out(), options.maxBytes());
      writer = w;
      Thread closer = new Thread(w::close, "perfportal-agent-close");
      closer.setDaemon(true);
      Runtime.getRuntime().addShutdownHook(closer);

      VersionGate.Result gate = VersionGate.check(ClassLoader.getSystemClassLoader());
      String machineRefusal = Sampler.machineRefusal();
      boolean machine = machineRefusal == null;
      w.line(header(gate, System.currentTimeMillis(), machine, machineRefusal));
      w.flush();
      // Always on, whatever the version gate decided: JVM and machine figures need no hook.
      Sampler.start(w, sockets, ClassLoader.getSystemClassLoader(), machine);
      if (gate.http()) {
        try {
          Instrumentation.install(inst);
        } catch (Throwable t) {
          fail("instrumentation", t);
        }
      }
    } catch (Throwable t) {
      fail("premain", t);
    }
  }

  /** The writer every collector appends to; null when the agent is off or has failed. */
  static EventWriter writer() {
    return failed.get() ? null : writer;
  }

  /** The sockets Gatling opened, which the instrumentation fills and the sampler reads. */
  static SocketRegistry sockets() {
    return sockets;
  }

  /**
   * Records the first failure as one {@code error} line and stops collection. Later failures are
   * dropped: one cause is what a reader needs, and a failing collector could repeat forever.
   */
  static void fail(String where, Throwable t) {
    try {
      if (!failed.compareAndSet(false, true)) return;
      EventWriter w = writer;
      if (w == null) return;
      recordFailure(w, where, t);
    } catch (Throwable ignored) {
      // the agent must never throw into the JVM it rides in
    }
  }

  /**
   * Writes the one {@code error} line and seals {@code w}, so it is the file's last line: a
   * collector that cached the writer before the failure appends nothing after it.
   */
  static void recordFailure(EventWriter w, String where, Throwable t) {
    String message = t.getClass().getName() + (t.getMessage() == null ? "" : ": " + t.getMessage());
    w.line(
        "{\"t\":\"error\",\"at\":"
            + System.currentTimeMillis()
            + ",\"where\":"
            + EventWriter.quote(where)
            + ",\"message\":"
            + EventWriter.quote(message)
            + "}");
    w.seal();
  }

  /**
   * The first line of every file. {@code reasons} names each collector that is off and why;
   * a collector that is on has no entry.
   */
  static String header(
      VersionGate.Result gate, long startedAt, boolean machine, String machineReason) {
    StringBuilder reasons = new StringBuilder("{");
    if (!gate.http()) reasons.append("\"http\":").append(EventWriter.quote(gate.reason()));
    if (!machine) {
      if (reasons.length() > 1) reasons.append(',');
      reasons.append("\"machine\":").append(EventWriter.quote(machineReason));
    }
    reasons.append('}');
    return "{\"t\":\"header\",\"format\":"
        + EventWriter.quote(FORMAT)
        + ",\"agentVersion\":"
        + EventWriter.quote(VERSION)
        + ",\"gatlingHttpClient\":"
        + EventWriter.quote(gate.gatlingHttpClient())
        + ",\"gatlingHttp\":"
        + EventWriter.quote(gate.gatlingHttp())
        + ",\"java\":"
        + EventWriter.quote(System.getProperty("java.version"))
        + ",\"os\":"
        + EventWriter.quote(System.getProperty("os.name"))
        + ",\"startedAt\":"
        + startedAt
        + ",\"collects\":{\"http\":"
        + gate.http()
        + ",\"machine\":"
        + machine
        + "},\"reasons\":"
        + reasons
        + "}";
  }
}
