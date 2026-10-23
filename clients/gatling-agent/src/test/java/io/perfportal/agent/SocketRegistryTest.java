package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class SocketRegistryTest {
  private static final String REMOTE = "localhost/127.0.0.1:8080";

  private static String row(int localPort, String remote, int state) {
    int colon = remote.lastIndexOf(':');
    return ProcTables.row(
        0, localPort, remote.substring(0, colon), Integer.parseInt(remote.substring(colon + 1)), state);
  }

  private static Map<String, Map<Integer, Integer>> states(SocketRegistry r, long now, String... rows) {
    return ProcTables.states(r, now, ProcTables.table(rows));
  }

  @Test
  void countsOnlyGatlingsOwnSockets() {
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, REMOTE);
    Map<String, Map<Integer, Integer>> states =
        states(r, 1_000, row(50000, "127.0.0.1:8080", 1), row(50001, "127.0.0.1:8080", 1));
    assertEquals(Map.of(REMOTE, Map.of(1, 1)), states);
  }

  @Test
  void aRowOnATrackedPortToAnotherRemoteIsNotGatlings() {
    // Linux lets two sockets share a local port when their remotes differ, so the port alone
    // does not make a row Gatling's.
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, REMOTE);
    assertEquals(Map.of(), states(r, 1_000, row(50000, "10.0.0.9:443", 1)));
  }

  @Test
  void matchesAnIpv6RemoteWrittenWithBrackets() {
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, "localhost/[0:0:0:0:0:0:0:1]:8080");
    assertEquals(
        Map.of("localhost/[0:0:0:0:0:0:0:1]:8080", Map.of(1, 1)),
        states(r, 1_000, row(50000, "0:0:0:0:0:0:0:1:8080", 1)));
  }

  @Test
  void keepsAClosedSocketsTimeWaitFor120Seconds() {
    SocketRegistry r = new SocketRegistry();
    long t = 1_000_000;
    r.opened("ch-1", 50000, REMOTE);
    r.closed("ch-1", t);
    String row = row(50000, "127.0.0.1:8080", 6);
    assertEquals(Map.of(REMOTE, Map.of(6, 1)), states(r, t + 119_000, row));
    assertEquals(Map.of(), states(r, t + 121_000, row));
  }

  @Test
  void countsEachRowOnceAndGroupsStatesByRemote() {
    SocketRegistry r = new SocketRegistry();
    r.opened("a", 50000, REMOTE);
    r.opened("b", 50002, REMOTE);
    r.opened("c", 50003, "other/10.0.0.9:443");
    Map<String, Map<Integer, Integer>> states =
        states(
            r,
            1_000,
            row(50000, "127.0.0.1:8080", 1),
            row(50002, "127.0.0.1:8080", 1),
            row(50003, "10.0.0.9:443", 8));
    assertEquals(Map.of(REMOTE, Map.of(1, 2), "other/10.0.0.9:443", Map.of(8, 1)), states);
  }

  @Test
  void aPortReusedAfterATimeWaitCountsOnceForTheOpenSocket() {
    SocketRegistry r = new SocketRegistry();
    r.opened("old", 50000, "old/127.0.0.1:8080");
    r.closed("old", 1_000);
    r.opened("new", 50000, "new/127.0.0.1:8080");
    assertEquals(
        Map.of("new/127.0.0.1:8080", Map.of(1, 1)),
        states(r, 2_000, row(50000, "127.0.0.1:8080", 1)));
  }

  @Test
  void aTcp6RowCountsForTheIpv4RemoteItMaps() {
    SocketRegistry r = new SocketRegistry();
    r.opened("ch-1", 50000, REMOTE);
    assertEquals(
        Map.of(REMOTE, Map.of(1, 1)),
        ProcTables.states(
            r, 1_000, ProcTables.table(ProcTables.mappedRow(0, 50000, "127.0.0.1", 8080, 1))));
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
