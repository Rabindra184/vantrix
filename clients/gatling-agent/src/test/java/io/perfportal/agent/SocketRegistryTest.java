package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SocketRegistryTest {
  private static final String REMOTE = "localhost/127.0.0.1:8080";

  private static ProcTcp.Row row(int localPort, String remote, int state) {
    return new ProcTcp.Row(localPort, remote, state);
  }

  @Test
  void countsOnlyGatlingsOwnSockets() {
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, REMOTE);
    Map<String, Map<Integer, Integer>> states =
        r.statesByRemote(
            List.of(row(50000, "127.0.0.1:8080", 1), row(50001, "127.0.0.1:8080", 1)), 1_000);
    assertEquals(Map.of(REMOTE, Map.of(1, 1)), states);
  }

  @Test
  void aRowOnATrackedPortToAnotherRemoteIsNotGatlings() {
    // Linux lets two sockets share a local port when their remotes differ, so the port alone
    // does not make a row Gatling's.
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, REMOTE);
    assertEquals(Map.of(), r.statesByRemote(List.of(row(50000, "10.0.0.9:443", 1)), 1_000));
  }

  @Test
  void matchesAnIpv6RemoteWrittenWithBrackets() {
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, "localhost/[0:0:0:0:0:0:0:1]:8080");
    assertEquals(
        Map.of("localhost/[0:0:0:0:0:0:0:1]:8080", Map.of(1, 1)),
        r.statesByRemote(List.of(row(50000, "0:0:0:0:0:0:0:1:8080", 1)), 1_000));
  }

  @Test
  void keepsAClosedSocketsTimeWaitFor120Seconds() {
    SocketRegistry r = new SocketRegistry();
    long t = 1_000_000;
    r.opened("ch-1", 50000, REMOTE);
    r.closed("ch-1", t);
    List<ProcTcp.Row> rows = List.of(row(50000, "127.0.0.1:8080", 6));
    assertEquals(Map.of(REMOTE, Map.of(6, 1)), r.statesByRemote(rows, t + 119_000));
    assertEquals(Map.of(), r.statesByRemote(rows, t + 121_000));
  }

  @Test
  void countsEachRowOnceAndGroupsStatesByRemote() {
    SocketRegistry r = new SocketRegistry();
    r.opened("a", 50000, REMOTE);
    r.opened("b", 50002, REMOTE);
    r.opened("c", 50003, "other/10.0.0.9:443");
    Map<String, Map<Integer, Integer>> states =
        r.statesByRemote(
            List.of(
                row(50000, "127.0.0.1:8080", 1),
                row(50002, "127.0.0.1:8080", 1),
                row(50003, "10.0.0.9:443", 8)),
            1_000);
    assertEquals(Map.of(REMOTE, Map.of(1, 2), "other/10.0.0.9:443", Map.of(8, 1)), states);
  }

  @Test
  void bytesAreCumulativePerRemote() {
    SocketRegistry r = new SocketRegistry();
    r.addBytes(REMOTE, 100, 10);
    r.addBytes(REMOTE, 5, 1);
    r.addBytes("other/10.0.0.9:443", 7, 0);
    Map<String, long[]> bytes = r.bytesByRemote();
    assertEquals(2, bytes.size());
    assertArrayEquals(new long[] {105, 11}, bytes.get(REMOTE));
    assertArrayEquals(new long[] {7, 0}, bytes.get("other/10.0.0.9:443"));
    // A snapshot: later traffic does not rewrite what was already read.
    r.addBytes(REMOTE, 1, 1);
    assertArrayEquals(new long[] {105, 11}, bytes.get(REMOTE));
    assertTrue(r.bytesByRemote().get(REMOTE)[0] == 106);
  }
}
