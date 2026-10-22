package io.perfportal.agent;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the machine's socket table from {@code /proc/net/tcp} and {@code /proc/net/tcp6}: for
 * each row, its local port, its remote address and its state.
 *
 * <p>The kernel writes each address as hex 32-bit words in host byte order (little-endian on
 * every platform the runner ships for) and each port as big-endian hex. A remote is normalised
 * to {@code InetAddress.getHostAddress() + ":" + port}, the form Java names it by, and an
 * IPv4-mapped tcp6 address ({@code ::ffff:a.b.c.d}) reads as the IPv4 address it maps -- Java's
 * dual-stack sockets land in tcp6 that way while their channel reports the plain IPv4 address.
 */
final class ProcTcp {
  private ProcTcp() {}

  static final class Row {
    final int localPort;
    final String remoteIpPort;
    /** The {@code st} column: 1 ESTABLISHED, 2 SYN_SENT, ... 6 TIME_WAIT, ... 0x0A LISTEN. */
    final int state;

    Row(int localPort, String remoteIpPort, int state) {
      this.localPort = localPort;
      this.remoteIpPort = remoteIpPort;
      this.state = state;
    }

    @Override
    public String toString() {
      return localPort + "->" + remoteIpPort + " st=" + state;
    }
  }

  /** Every readable row; the header line and any row that cannot be read are skipped. */
  static List<Row> parse(String content) {
    List<Row> rows = new ArrayList<>();
    for (String line : content.split("\n")) {
      String[] f = line.trim().split("\\s+");
      if (f.length < 4 || !f[0].endsWith(":")) continue;
      Row row = row(f[1], f[2], f[3]);
      if (row != null) rows.add(row);
    }
    return rows;
  }

  private static Row row(String local, String remote, String st) {
    try {
      int localColon = local.indexOf(':');
      int remoteColon = remote.indexOf(':');
      if (localColon < 0 || remoteColon < 0) return null;
      int localPort = Integer.parseInt(local.substring(localColon + 1), 16);
      InetAddress address = address(remote.substring(0, remoteColon));
      if (address == null) return null;
      int remotePort = Integer.parseInt(remote.substring(remoteColon + 1), 16);
      return new Row(localPort, address.getHostAddress() + ":" + remotePort, Integer.parseInt(st, 16));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static InetAddress address(String hex) {
    if (hex.length() != 8 && hex.length() != 32) return null;
    byte[] bytes = new byte[hex.length() / 2];
    // Each 32-bit word is little-endian: reverse the four bytes of every word.
    for (int word = 0; word < bytes.length / 4; word++) {
      for (int b = 0; b < 4; b++) {
        int at = word * 8 + (3 - b) * 2;
        bytes[word * 4 + b] = (byte) Integer.parseInt(hex.substring(at, at + 2), 16);
      }
    }
    try {
      // For an IPv4-mapped address getByAddress already returns the Inet4Address.
      return InetAddress.getByAddress(bytes);
    } catch (UnknownHostException e) {
      return null;
    }
  }
}
