package io.perfportal.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
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
    /** The remote in {@link ProcTcp.Row#remoteIpPort} form, or null when it has none. */
    final String ipPort;

    volatile long closedAt = -1;

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

    boolean matches(String rowIpPort) {
      return ipPort == null || ipPort.equals(rowIpPort);
    }
  }

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
   * The rows that are Gatling's own sockets, counted by state under each socket's remote. A row
   * is Gatling's when a tracked socket has its local port AND its remote: Linux lets two sockets
   * share a local port when their remotes differ, so the port alone is not enough. When two
   * tracked sockets would both match (a port reused after a TIME_WAIT), the row counts once, for
   * the open one, else the one closed last.
   */
  Map<String, Map<Integer, Integer>> statesByRemote(List<ProcTcp.Row> rows, long nowMs) {
    Map<Integer, List<Socket>> byPort = new HashMap<>();
    for (Socket s : byChannel.values()) {
      if (s.liveAt(nowMs)) byPort.computeIfAbsent(s.localPort, p -> new ArrayList<>()).add(s);
    }
    Map<String, Map<Integer, Integer>> out = new TreeMap<>();
    for (ProcTcp.Row row : rows) {
      List<Socket> candidates = byPort.get(row.localPort);
      if (candidates == null) continue;
      Socket best = null;
      for (Socket s : candidates) {
        if (s.matches(row.remoteIpPort) && (best == null || preferred(s, best))) best = s;
      }
      if (best == null) continue;
      out.computeIfAbsent(best.remote, r -> new TreeMap<>()).merge(row.state, 1, Integer::sum);
    }
    return out;
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
}
