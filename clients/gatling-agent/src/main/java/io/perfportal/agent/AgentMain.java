package io.perfportal.agent;

import java.lang.instrument.Instrumentation;
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

  private AgentMain() {}

  public static void premain(String agentArgs, Instrumentation inst) {
    try {
      AgentOptions options = AgentOptions.parse(agentArgs);
      if (options.isDisabled()) return;
      EventWriter w = EventWriter.open(options.out(), options.maxBytes());
      writer = w;
      Thread closer = new Thread(w::close, "perfportal-agent-close");
      closer.setDaemon(true);
      Runtime.getRuntime().addShutdownHook(closer);

      VersionGate.Result gate = VersionGate.check(ClassLoader.getSystemClassLoader());
      w.line(header(gate, System.currentTimeMillis(), true, null));
      w.flush();
    } catch (Throwable t) {
      fail("premain", t);
    }
  }

  /** The writer every collector appends to; null when the agent is off or has failed. */
  static EventWriter writer() {
    return failed.get() ? null : writer;
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
      String message = t.getClass().getName() + (t.getMessage() == null ? "" : ": " + t.getMessage());
      w.line(
          "{\"t\":\"error\",\"at\":"
              + System.currentTimeMillis()
              + ",\"where\":"
              + EventWriter.quote(where)
              + ",\"message\":"
              + EventWriter.quote(message)
              + "}");
      w.flush();
    } catch (Throwable ignored) {
      // the agent must never throw into the JVM it rides in
    }
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
