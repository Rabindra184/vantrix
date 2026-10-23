package io.perfportal.agent;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

/**
 * The sockets Gatling's own HTTP client opened, keyed by channel, and the bytes it moved per
 * remote. The instrumentation writes to it from Netty's event loops; the sampler reads it once a
 * second.
 *
 * <p>A remote is whatever string the instrumentation names it by (Java's {@code
 * InetSocketAddress} form, {@code host/ip:port}). Socket states are counted only for rows of
 * {@code /proc/net/tcp*} that are this JVM's own Gatling sockets -- never the machine's whole
 * table -- so the Remote filter narrows the state chart as Gatling Enterprise's does.
 *
 * <p>Not final only so a test can make it fail on purpose.
 */
class SocketRegistry {
  /**
   * How long a closed socket keeps being matched. Linux holds TIME_WAIT for 60 s, so a socket's
   * TIME_WAIT row stays counted, under its remote, for its whole life and some margin.
   */
  static final long CLOSED_RETENTION_MS = 120_000;

  private final Map<String, Socket> byChannel = new ConcurrentHashMap<>();
  private final Map<String, LongAdder[]> bytes = new ConcurrentHashMap<>();
  private final AtomicLong order = new AtomicLong();

  private static final class Socket {
    final long seq;
    final int localPort;
    final String remote;
    /** The remote's {@code ip:port}, or null when it has none (it then matches any remote). */
    final String ipPort;

    volatile long closedAt = -1;

    /**
     * The remote as the kernel writes it in a {@code /proc/net/tcp} row ({@code [0]}, null for
     * an IPv6 remote) and a {@code tcp6} row ({@code [1]}); computed by the sampler the first
     * time it needs it. An {@code ip:port} that is not an IP literal gets {@link #NEVER}.
     */
    private volatile byte[][] kernelForms;

    Socket(long seq, int localPort, String remote) {
      this.seq = seq;
      this.localPort = localPort;
      this.remote = remote;
      this.ipPort = ipPort(remote);
    }

    boolean liveAt(long nowMs) {
      long c = closedAt;
      return c < 0 || nowMs - c <= CLOSED_RETENTION_MS;
    }

    /** Whether the row's remote, {@code b[start, end)} in the kernel's hex, is this socket's. */
    boolean matches(byte[] b, int start, int end) {
      if (ipPort == null) return true;
      byte[][] forms = kernelForms;
      if (forms == null) kernelForms = forms = kernelForms(ipPort);
      int length = end - start;
      for (byte[] want : forms) {
        if (want == null || want.length != length) continue;
        int i = 0;
        // | 0x20 lower-cases A-F and leaves the digits and ':' as they are.
        while (i < length && (b[start + i] | 0x20) == (want[i] | 0x20)) i++;
        if (i == length) return true;
      }
      return false;
    }
  }

  private static final byte[][] NEVER = new byte[0][];

  void opened(String ch, int localPort, String remote) {
    byChannel.put(ch, new Socket(order.incrementAndGet(), localPort, remote));
  }

  void closed(String ch, long atMs) {
    Socket s = byChannel.get(ch);
    if (s != null && s.closedAt < 0) s.closedAt = atMs;
  }

  /** Forgets sockets closed longer ago than {@link #CLOSED_RETENTION_MS}. */
  void prune(long nowMs) {
    byChannel.values().removeIf(s -> !s.liveAt(nowMs));
  }

  /**
   * A counter for this second's {@code /proc/net/tcp*} rows, over the sockets live at {@code
   * nowMs}; null when there are none, so the tables need not be read at all -- no row of them
   * could be Gatling's.
   */
  StateCounts stateCounts(long nowMs) {
    Socket[] live = new Socket[byChannel.size() + 8];
    int n = 0;
    for (Socket s : byChannel.values()) {
      if (!s.liveAt(nowMs)) continue;
      if (n == live.length) live = Arrays.copyOf(live, n * 2);
      live[n++] = s;
    }
    if (n == 0) return null;
    // Sorted by local port, through one primitive array: no comparator, no boxing.
    long[] keys = new long[n];
    for (int i = 0; i < n; i++) keys[i] = ((long) live[i].localPort << 32) | i;
    Arrays.sort(keys);
    int[] ports = new int[n];
    Socket[] sockets = new Socket[n];
    for (int i = 0; i < n; i++) {
      ports[i] = (int) (keys[i] >>> 32);
      sockets[i] = live[(int) keys[i]];
    }
    return new StateCounts(ports, sockets);
  }

  /**
   * One second's count of Gatling's socket rows, by state under each socket's remote. A row is
   * Gatling's when a tracked socket has its local port AND its remote: Linux lets two sockets
   * share a local port when their remotes differ, so the port alone is not enough. When two
   * tracked sockets would both match (a port reused after a TIME_WAIT), the row counts once, for
   * the open one, else the one closed last.
   */
  static final class StateCounts {
    private final int[] ports;
    private final Socket[] sockets;
    /** Per remote, a count for each of the 256 values the two-digit {@code st} column can take. */
    private final Map<String, int[]> counts = new TreeMap<>();
    /** Rows that got past the local-port check and had their remote compared. */
    int examined;

    private StateCounts(int[] ports, Socket[] sockets) {
      this.ports = ports;
      this.sockets = sockets;
    }

    boolean tracksPort(int localPort) {
      return Arrays.binarySearch(ports, localPort) >= 0;
    }

    /** A row on a tracked local port, its remote at {@code b[remStart, remEnd)} in the kernel's hex. */
    void row(int localPort, byte[] b, int remStart, int remEnd, int state) {
      examined++;
      int i = Arrays.binarySearch(ports, localPort);
      if (i < 0) return;
      while (i > 0 && ports[i - 1] == localPort) i--;
      Socket best = null;
      for (; i < ports.length && ports[i] == localPort; i++) {
        Socket s = sockets[i];
        if (s.matches(b, remStart, remEnd) && (best == null || preferred(s, best))) best = s;
      }
      if (best == null) return;
      counts.computeIfAbsent(best.remote, r -> new int[256])[state & 0xFF]++;
    }

    /** Per remote (in order), each state's count (in order); a state with none is absent. */
    Map<String, Map<Integer, Integer>> asMap() {
      Map<String, Map<Integer, Integer>> out = new TreeMap<>();
      counts.forEach(
          (remote, byState) -> {
            Map<Integer, Integer> m = new TreeMap<>();
            for (int st = 0; st < byState.length; st++) if (byState[st] > 0) m.put(st, byState[st]);
            out.put(remote, m);
          });
      return out;
    }

    /** As {@link #asMap()}, written as the sample line's {@code "states"} object. */
    void appendJson(StringBuilder b) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<String, int[]> e : counts.entrySet()) {
        if (!first) b.append(',');
        first = false;
        b.append(EventWriter.quote(e.getKey())).append(":{");
        int[] byState = e.getValue();
        boolean firstState = true;
        for (int st = 0; st < byState.length; st++) {
          if (byState[st] == 0) continue;
          if (!firstState) b.append(',');
          firstState = false;
          b.append('"').append(st).append("\":").append(byState[st]);
        }
        b.append('}');
      }
      b.append('}');
    }
  }

  private static boolean preferred(Socket a, Socket b) {
    boolean aOpen = a.closedAt < 0;
    boolean bOpen = b.closedAt < 0;
    if (aOpen != bOpen) return aOpen;
    return a.seq > b.seq;
  }

  void addBytes(String remote, long out, long in) {
    LongAdder[] a = bytes.computeIfAbsent(remote, r -> new LongAdder[] {new LongAdder(), new LongAdder()});
    a[0].add(out);
    a[1].add(in);
  }

  /** A snapshot of the bytes moved per remote since the JVM started: {@code {out, in}}. */
  Map<String, long[]> bytesByRemote() {
    Map<String, long[]> out = new TreeMap<>();
    bytes.forEach((remote, a) -> out.put(remote, new long[] {a[0].sum(), a[1].sum()}));
    return Collections.unmodifiableMap(out);
  }

  /**
   * {@code host/ip:port} or {@code host/[v6]:port} as {@code ip:port} without brackets or an IPv6
   * scope, the form {@link ProcTcp} writes; null when there is no port to compare.
   */
  static String ipPort(String remote) {
    if (remote == null) return null;
    String s = remote.substring(remote.lastIndexOf('/') + 1).replace("[", "").replace("]", "");
    int colon = s.lastIndexOf(':');
    if (colon <= 0) return null;
    int pct = s.indexOf('%');
    if (pct >= 0 && pct < colon) s = s.substring(0, pct) + s.substring(colon);
    return s;
  }

  /**
   * {@code ip:port} as the kernel's hex: {@code [tcp form or null, tcp6 form]}. Each 32-bit word
   * of the address is written little-endian, the port big-endian; an IPv4 address appears in
   * tcp6 IPv4-mapped. Only a literal is parsed -- this never resolves a name.
   */
  static byte[][] kernelForms(String ipPort) {
    int colon = ipPort.lastIndexOf(':');
    String ip = ipPort.substring(0, colon);
    int port;
    try {
      port = Integer.parseInt(ipPort.substring(colon + 1));
    } catch (NumberFormatException e) {
      return NEVER;
    }
    if (port < 0 || port > 0xFFFF) return NEVER;
    String portHex = String.format(":%04X", port);
    byte[] v4 = ipv4(ip);
    byte[] address = v4;
    if (address == null && ip.indexOf(':') >= 0) {
      try {
        // A string with a ':' is parsed as an IPv6 literal and never looked up.
        address = InetAddress.getByName(ip).getAddress();
      } catch (UnknownHostException | RuntimeException e) {
        return NEVER;
      }
    }
    if (address == null) return NEVER;
    if (address.length == 4) {
      String word = words(address);
      return new byte[][] {
        ascii(word + portHex), ascii("0000000000000000FFFF0000" + word + portHex)
      };
    }
    return new byte[][] {null, ascii(words(address) + portHex)};
  }

  /** Each 4-byte word of {@code address} in reverse byte order, as upper-case hex. */
  private static String words(byte[] address) {
    StringBuilder b = new StringBuilder(address.length * 2);
    for (int w = 0; w < address.length; w += 4) {
      for (int i = 3; i >= 0; i--) b.append(String.format("%02X", address[w + i] & 0xFF));
    }
    return b.toString();
  }

  /** A dotted-quad IPv4 literal's four bytes, or null when {@code ip} is not one. */
  private static byte[] ipv4(String ip) {
    String[] parts = ip.split("\\.", -1);
    if (parts.length != 4) return null;
    byte[] out = new byte[4];
    for (int i = 0; i < 4; i++) {
      String p = parts[i];
      if (p.isEmpty() || p.length() > 3) return null;
      int v = 0;
      for (int j = 0; j < p.length(); j++) {
        char c = p.charAt(j);
        if (c < '0' || c > '9') return null;
        v = v * 10 + (c - '0');
      }
      if (v > 255) return null;
      out[i] = (byte) v;
    }
    return out;
  }

  private static byte[] ascii(String s) {
    return s.getBytes(StandardCharsets.US_ASCII);
  }
}
