package io.perfportal.agent;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * Counts, by state, the rows of {@code /proc/net/tcp} and {@code /proc/net/tcp6} that are
 * Gatling's own sockets -- and touches every OTHER row as little as possible.
 *
 * <p>This runs once a second inside the JVM being measured, and a load generator's socket table
 * is mostly Gatling's own connections plus whatever else the machine holds: tens of thousands of
 * rows. So a row is rejected on its local port alone, read straight out of the bytes, before its
 * remote or its state is looked at; nothing is split, no {@code String} or {@code InetAddress} is
 * built for any row, and the file is read into a buffer the caller keeps from one second to the
 * next. Only a row on a tracked local port has its remote compared, as the kernel's own hex,
 * against {@link SocketRegistry}'s precomputed hex of each tracked socket's remote.
 *
 * <p>The kernel writes each address as hex 32-bit words in host byte order (little-endian on
 * every platform the runner ships for), each port as big-endian hex, and the state as two hex
 * digits. An IPv4-mapped tcp6 address ({@code ::ffff:a.b.c.d}) counts for a socket whose remote
 * is the plain IPv4 address: Java's dual-stack sockets land in tcp6 that way while their channel
 * reports the IPv4 address.
 */
final class ProcTcp {
  private ProcTcp() {}

  /** Where the sampler gets a table's bytes from; tests feed a synthetic file through it. */
  @FunctionalInterface
  interface Source {
    /** Reads {@code file} into {@code into}; false when it cannot be read this second. */
    boolean read(Path file, Table into);
  }

  /** The default source: the file itself. */
  static final Source FILES = ProcTcp::read;

  /** A table's bytes, in a buffer kept from one sample to the next so reading it allocates nothing. */
  static final class Table {
    byte[] bytes = new byte[16 * 1024];
    int length;

    static Table of(String content) {
      Table t = new Table();
      t.bytes = content.getBytes(StandardCharsets.US_ASCII);
      t.length = t.bytes.length;
      return t;
    }
  }

  static boolean read(Path file, Table into) {
    try (InputStream in = Files.newInputStream(file)) {
      byte[] b = into.bytes;
      int length = 0;
      while (true) {
        if (length == b.length) b = Arrays.copyOf(b, b.length * 2);
        int n = in.read(b, length, b.length - length);
        if (n < 0) break;
        length += n;
      }
      into.bytes = b;
      into.length = length;
      return true;
    } catch (IOException | RuntimeException e) {
      return false;
    }
  }

  /**
   * Adds every row of {@code table} that is a tracked socket to {@code counts}. The header line
   * and any row that cannot be read are skipped.
   */
  static void count(Table table, SocketRegistry.StateCounts counts) {
    byte[] b = table.bytes;
    int end = table.length;
    int i = 0;
    while (i < end) {
      int lineEnd = indexOf(b, (byte) '\n', i, end);
      countLine(b, i, lineEnd, counts);
      i = lineEnd + 1;
    }
  }

  private static void countLine(byte[] b, int i, int end, SocketRegistry.StateCounts counts) {
    // sl: a token ending in ':' (the header's "sl" does not).
    i = skipSpaces(b, i, end);
    int slEnd = tokenEnd(b, i, end);
    if (slEnd == i || b[slEnd - 1] != ':') return;
    // local_address: only its port, and only to reject the row.
    int localStart = skipSpaces(b, slEnd, end);
    int localEnd = tokenEnd(b, localStart, end);
    int colon = indexOf(b, (byte) ':', localStart, localEnd);
    if (colon == localEnd) return;
    int localPort = hex(b, colon + 1, localEnd);
    if (localPort < 0 || localPort > 0xFFFF || !counts.tracksPort(localPort)) return;
    // rem_address, then st -- read only for a row on a tracked port.
    int remStart = skipSpaces(b, localEnd, end);
    int remEnd = tokenEnd(b, remStart, end);
    if (!wellFormedRemote(b, remStart, remEnd)) return;
    int stStart = skipSpaces(b, remEnd, end);
    int state = hex(b, stStart, tokenEnd(b, stStart, end));
    if (state < 0 || state > 0xFF) return;
    counts.row(localPort, b, remStart, remEnd, state);
  }

  /** {@code 8 hex:4 hex} (tcp) or {@code 32 hex:4 hex} (tcp6). */
  private static boolean wellFormedRemote(byte[] b, int start, int end) {
    int addr = end - start - 5;
    return (addr == 8 || addr == 32)
        && b[start + addr] == ':'
        && allHex(b, start, start + addr)
        && allHex(b, start + addr + 1, end);
  }

  private static boolean allHex(byte[] b, int start, int end) {
    for (int i = start; i < end; i++) if (digit(b[i]) < 0) return false;
    return true;
  }

  /** The hex number in {@code [start, end)} of 1 to 7 digits (so it fits an int); -1 otherwise. */
  static int hex(byte[] b, int start, int end) {
    if (start >= end || end - start > 7) return -1;
    int v = 0;
    for (int i = start; i < end; i++) {
      int d = digit(b[i]);
      if (d < 0) return -1;
      v = v * 16 + d;
    }
    return v;
  }

  private static int digit(byte c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  }

  private static int skipSpaces(byte[] b, int i, int end) {
    while (i < end && (b[i] == ' ' || b[i] == '\t')) i++;
    return i;
  }

  private static int tokenEnd(byte[] b, int i, int end) {
    while (i < end && b[i] != ' ' && b[i] != '\t' && b[i] != '\r') i++;
    return i;
  }

  private static int indexOf(byte[] b, byte c, int i, int end) {
    while (i < end && b[i] != c) i++;
    return i;
  }
}
