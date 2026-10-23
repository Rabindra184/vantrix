package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The fixtures under {@code src/test/resources/proc/} are real files, copied unedited out of a
 * Linux container's {@code /proc} while it held TCP connections of each shape these parsers have
 * to read: IPv4, IPv6, IPv4-mapped IPv6, a listener, and a TIME_WAIT.
 */
class ProcParsersTest {
  static String fixture(String name) {
    try (InputStream in = ProcParsersTest.class.getResourceAsStream("/proc/" + name)) {
      if (in == null) throw new IllegalStateException("no fixture proc/" + name);
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  @Test
  void parsesCpuJiffies() {
    assertArrayEquals(
        new long[] {2172484, 0, 2313797, 116144375, 1779744, 0, 1596614, 0},
        ProcStat.parse(fixture("stat")));
  }

  @Test
  void padsAnOldKernelsShorterCpuLineWithZeros() {
    // Before 2.6.11 the line stops at softirq; the missing fields are zero, not a failure.
    assertArrayEquals(
        new long[] {1, 2, 3, 4, 5, 6, 7, 0}, ProcStat.parse("cpu  1 2 3 4 5 6 7\ncpu0 1 2 3\n"));
  }

  @Test
  void readsNoCpuFiguresFromAFileItCannotRead() {
    assertNull(ProcStat.parse("intr 1 2 3\n"));
    assertNull(ProcStat.parse("cpu  1 two 3\n"));
  }

  @Test
  void parsesMemTotalAndAvailable() {
    assertArrayEquals(new long[] {8022316, 6169700}, ProcMeminfo.parse(fixture("meminfo")));
  }

  @Test
  void hasNoMemoryFiguresWithoutMemAvailable() {
    // Kernels before 3.14 have no MemAvailable, and free memory is not the same figure.
    assertNull(ProcMeminfo.parse("MemTotal:        8022316 kB\nMemFree:  100 kB\n"));
  }

  @Test
  void parsesTcpCounters() {
    Map<String, Long> t = ProcSnmp.parseTcp(fixture("net/snmp"));
    assertTrue(
        t.containsKey("ActiveOpens") && t.containsKey("RetransSegs") && t.containsKey("AttemptFails"),
        t.toString());
    assertEquals(15, t.size(), t.toString());
    assertEquals(5L, t.get("ActiveOpens"));
    assertEquals(-1L, t.get("MaxConn"));
    assertEquals(17L, t.get("OutSegs"));
    // In the kernel's own order, so the line reads like the file.
    assertEquals(List.of("RtoAlgorithm", "RtoMin", "RtoMax"), List.copyOf(t.keySet()).subList(0, 3));
  }

  @Test
  void readsNoTcpCountersWithoutTheTcpLinePair() {
    assertNull(ProcSnmp.parseTcp("Ip: Forwarding\nIp: 1\n"));
  }

  @Test
  void countsTcp4AndMappedTcp6RowsForTheSocketsTheyAre() {
    SocketRegistry r = new SocketRegistry();
    // 0100007F:B78E -> 0100007F:1F90, ESTABLISHED.
    r.opened(1, 0xB78E, "localhost/127.0.0.1:8080");
    // ...FFFF00000100007F:B79E -> ::ffff:127.0.0.1:8080 counts for the IPv4 remote it maps.
    r.opened(2, 0xB79E, "mapped/127.0.0.1:8080");
    // The TIME_WAIT the closed connection left behind.
    r.opened(3, 0xB7A0, "closed/127.0.0.1:8080");
    r.closed(3, 1_000);
    // A real IPv6 remote.
    r.opened(4, 0xC3D6, "six/[0:0:0:0:0:0:0:1]:8080");
    // An outbound connection to a public address.
    r.opened(5, 0xD684, "one/1.1.1.1:80");
    // On the dual-stack LISTENER's port, but to a remote the listener (all-zero remote) is not.
    r.opened(6, 8080, "local/127.0.0.1:47000");

    assertEquals(
        Map.of(
            "localhost/127.0.0.1:8080", Map.of(1, 1),
            "mapped/127.0.0.1:8080", Map.of(1, 1),
            "closed/127.0.0.1:8080", Map.of(6, 1),
            "six/[0:0:0:0:0:0:0:1]:8080", Map.of(1, 1),
            "one/1.1.1.1:80", Map.of(1, 1)),
        ProcTables.states(r, 2_000, fixture("net/tcp"), fixture("net/tcp6")));
  }

  @Test
  void skipsALineItCannotRead() {
    SocketRegistry r = new SocketRegistry();
    r.opened(1, 0xB78E, "localhost/127.0.0.1:8080");
    assertEquals(
        Map.of("localhost/127.0.0.1:8080", Map.of(1, 1)),
        ProcTables.states(
            r,
            1_000,
            "  sl  local_address rem_address   st\n"
                + "   0: garbage\n"
                + "   1: 0100007F:B78E 0100007F:1F9 01 00000000:00000000\n"
                + "   2: 0100007F:B78E 0100007F:1F90 zz 00000000:00000000\n"
                + "   3: 0100007F:B78E 0100007F:1F90 01 00000000:00000000\n"));
  }

  /**
   * A load generator's table is mostly sockets that are not this JVM's Gatling sockets. A row on
   * an untracked local port is rejected on that port alone: its remote and state are never read
   * (here they are not even well formed), and only the rows on tracked ports reach the remote
   * comparison.
   */
  @Test
  void rejectsARowOnAnUntrackedPortBeforeReadingAnythingElseInIt() {
    SocketRegistry r = new SocketRegistry();
    String remote = "target/10.1.2.3:8080";
    for (int i = 0; i < 5; i++) r.opened(i, 40_000 + i, remote);
    StringBuilder tcp = new StringBuilder(ProcTables.HEADER);
    int sl = 0;
    for (int i = 0; i < 30_000; i++) {
      int port = 10_000 + i; // never 40000-40004
      tcp.append(
          i % 2 == 0
              ? ProcTables.row(sl++, port, "10.9.8.7", 443, 1)
              : String.format("%4d: 0100007F:%04X not-an-address !! 0:0\n", sl++, port));
    }
    // The tracked sockets: four ESTABLISHED, one in TIME_WAIT...
    for (int i = 0; i < 4; i++) tcp.append(ProcTables.row(sl++, 40_000 + i, "10.1.2.3", 8080, 1));
    tcp.append(ProcTables.row(sl++, 40_004, "10.1.2.3", 8080, 6));
    // ...and a socket that shares a tracked local port but not its remote: examined, not counted.
    tcp.append(ProcTables.row(sl++, 40_000, "10.1.2.4", 8080, 1));

    SocketRegistry.StateCounts counts = r.stateCounts(1_000);
    ProcTcp.count(ProcTcp.Table.of(tcp.toString()), counts);
    assertEquals(Map.of(remote, Map.of(1, 4, 6, 1)), counts.asMap());
    assertEquals(6, counts.examined, "rows that reached the remote comparison");
  }

}
