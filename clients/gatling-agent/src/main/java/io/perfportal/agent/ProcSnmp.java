package io.perfportal.agent;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reads the machine's TCP counters from {@code /proc/net/snmp}: the {@code Tcp:} header line and
 * the {@code Tcp:} value line after it, every field by its header name. Most are cumulative
 * counters ({@code ActiveOpens}, {@code AttemptFails}, {@code OutSegs}, {@code RetransSegs} ...);
 * {@code CurrEstab} is a gauge and {@code MaxConn} is {@code -1} by RFC 2012.
 */
final class ProcSnmp {
  private ProcSnmp() {}

  /** Every {@code Tcp:} field in the kernel's order, or null when the line pair is unreadable. */
  static Map<String, Long> parseTcp(String content) {
    String header = null;
    for (String line : content.split("\n")) {
      if (!line.startsWith("Tcp:")) continue;
      if (header == null) {
        header = line;
        continue;
      }
      String[] names = header.trim().split("\\s+");
      String[] values = line.trim().split("\\s+");
      if (names.length != values.length || names.length < 2) return null;
      Map<String, Long> out = new LinkedHashMap<>();
      try {
        for (int i = 1; i < names.length; i++) out.put(names[i], Long.parseLong(values[i]));
      } catch (NumberFormatException e) {
        return null;
      }
      return out;
    }
    return null;
  }
}
