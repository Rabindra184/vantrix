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
import java.util.stream.Collectors;
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
  void parsesTcp4AndMappedTcp6Rows() {
    List<ProcTcp.Row> v4 = ProcTcp.parse(fixture("net/tcp"));
    List<ProcTcp.Row> v6 = ProcTcp.parse(fixture("net/tcp6"));
    assertEquals(3, v4.size());
    assertEquals(6, v6.size());

    // 0100007F:B78E -> 0100007F:1F90, ESTABLISHED.
    ProcTcp.Row a = byLocal(v4, 0xB78E);
    assertEquals("127.0.0.1:8080", a.remoteIpPort);
    assertEquals(1, a.state);
    // ...FFFF00000100007F:B79E -> ::ffff:127.0.0.1:8080 reads as the IPv4 address it maps.
    ProcTcp.Row b = byLocal(v6, 0xB79E);
    assertEquals("127.0.0.1:8080", b.remoteIpPort);
    assertEquals(1, b.state);
    // The TIME_WAIT the closed connection left behind.
    ProcTcp.Row tw = byLocal(v4, 0xB7A0);
    assertEquals(6, tw.state);
    // A real IPv6 remote, in InetAddress.getHostAddress() form.
    assertEquals("0:0:0:0:0:0:0:1:8080", byLocal(v6, 0xC3D6).remoteIpPort);
    // An outbound connection to a public address.
    assertEquals("1.1.1.1:80", byLocal(v4, 0xD684).remoteIpPort);
    // The dual-stack listener: state 0A, an all-zero remote.
    List<ProcTcp.Row> listeners =
        v6.stream().filter(r -> r.state == 0x0A).collect(Collectors.toList());
    assertEquals(1, listeners.size());
    assertEquals(8080, listeners.get(0).localPort);
  }

  @Test
  void skipsALineItCannotRead() {
    List<ProcTcp.Row> rows =
        ProcTcp.parse(
            "  sl  local_address rem_address   st\n"
                + "   0: garbage\n"
                + "   1: 0100007F:B78E 0100007F:1F90 01 00000000:00000000\n");
    assertEquals(1, rows.size());
  }

  private static ProcTcp.Row byLocal(List<ProcTcp.Row> rows, int port) {
    List<ProcTcp.Row> found =
        rows.stream().filter(r -> r.localPort == port).collect(Collectors.toList());
    assertEquals(1, found.size(), "rows on local port " + port);
    return found.get(0);
  }
}
