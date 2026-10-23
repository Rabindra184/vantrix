package io.perfportal.agent;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Map;

/**
 * Builds {@code /proc/net/tcp} and {@code tcp6} tables in the kernel's own format, with an
 * encoder written here rather than borrowed from the code under test.
 */
final class ProcTables {
  private ProcTables() {}

  static final String HEADER =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout"
          + " inode\n";

  /** A tcp row (an IPv4 remote) or a tcp6 row (an IPv6 remote), from a loopback local address. */
  static String row(int sl, int localPort, String remoteIp, int remotePort, int state) {
    String local = remoteIp.indexOf(':') >= 0 ? words(bytes("::1")) : words(bytes("127.0.0.1"));
    return line(sl, local, localPort, words(bytes(remoteIp)), remotePort, state);
  }

  /** A tcp6 row whose remote is the IPv4-mapped form of {@code remoteIpv4}. */
  static String mappedRow(int sl, int localPort, String remoteIpv4, int remotePort, int state) {
    String mapped = "0000000000000000FFFF0000" + words(bytes(remoteIpv4));
    return line(sl, mapped, localPort, mapped, remotePort, state);
  }

  static String line(int sl, String local, int localPort, String remote, int remotePort, int state) {
    return String.format(
        "%4d: %s:%04X %s:%04X %02X 00000000:00000000 00:00000000 00000000  1000        0 %d 1"
            + " 0000000000000000 20 4 30 10 -1\n",
        sl, local, localPort, remote, remotePort, state, 100_000 + sl);
  }

  /** What the sampler would report as {@code states} for these tables, read at {@code nowMs}. */
  static Map<String, Map<Integer, Integer>> states(SocketRegistry r, long nowMs, String... tables) {
    SocketRegistry.StateCounts counts = r.stateCounts(nowMs);
    if (counts == null) return Map.of();
    for (String t : tables) ProcTcp.count(ProcTcp.Table.of(t), counts);
    return counts.asMap();
  }

  static String table(String... rows) {
    return HEADER + String.join("", rows);
  }

  private static byte[] bytes(String ip) {
    try {
      return InetAddress.getByName(ip).getAddress();
    } catch (UnknownHostException e) {
      throw new IllegalArgumentException(ip, e);
    }
  }

  /** Each 32-bit word little-endian, as the kernel prints it. */
  private static String words(byte[] a) {
    StringBuilder b = new StringBuilder();
    for (int w = 0; w < a.length; w += 4) {
      for (int i = 3; i >= 0; i--) b.append(String.format("%02X", a[w + i] & 0xFF));
    }
    return b.toString();
  }
}
