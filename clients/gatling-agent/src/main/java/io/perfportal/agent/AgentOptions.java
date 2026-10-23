package io.perfportal.agent;

import java.nio.file.Path;

/**
 * The agent's {@code -javaagent:gatling-agent.jar=<args>} arguments: {@code key=value} pairs
 * separated by {@code ,}. {@code out=<path>} is where the NDJSON goes; {@code max=<bytes>} caps
 * it. Without {@code out} the agent does nothing at all.
 *
 * <p>Parsing never throws: an unreadable {@code max} keeps the default, and an unknown key is
 * ignored, because a typo in an option must not fail the simulation it rides in.
 */
final class AgentOptions {
  static final long DEFAULT_MAX_BYTES = 268_435_456L; // 256 MiB

  private static final AgentOptions DISABLED = new AgentOptions(null, DEFAULT_MAX_BYTES);

  private final Path out;
  private final long maxBytes;

  private AgentOptions(Path out, long maxBytes) {
    this.out = out;
    this.maxBytes = maxBytes;
  }

  static AgentOptions disabled() {
    return DISABLED;
  }

  static AgentOptions parse(String agentArgs) {
    if (agentArgs == null || agentArgs.isEmpty()) return DISABLED;
    String out = null;
    long max = DEFAULT_MAX_BYTES;
    for (String pair : agentArgs.split(",")) {
      int eq = pair.indexOf('=');
      if (eq < 0) continue;
      String key = pair.substring(0, eq).trim();
      String value = pair.substring(eq + 1).trim();
      if (key.equals("out")) {
        out = value;
      } else if (key.equals("max")) {
        try {
          long parsed = Long.parseLong(value);
          if (parsed > 0) max = parsed;
        } catch (NumberFormatException ignored) {
          // keep the default
        }
      }
    }
    if (out == null || out.isEmpty()) return DISABLED;
    try {
      return new AgentOptions(Path.of(out), max);
    } catch (RuntimeException invalidPath) {
      return DISABLED;
    }
  }

  boolean isDisabled() {
    return out == null;
  }

  /** Null when disabled. */
  Path out() {
    return out;
  }

  long maxBytes() {
    return maxBytes;
  }
}
