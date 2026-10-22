package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EventWriterTest {
  @TempDir Path dir;

  @Test
  void writesOneLinePerCall() throws Exception {
    Path out = dir.resolve("a.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    w.line("{\"t\":\"a\"}");
    w.line("{\"t\":\"b\"}");
    w.close();
    assertEquals(List.of("{\"t\":\"a\"}", "{\"t\":\"b\"}"), Files.readAllLines(out));
    assertFalse(w.capped());
  }

  @Test
  void capsAndSaysSoOnce() throws Exception {
    Path out = dir.resolve("c.ndjson");
    EventWriter w = EventWriter.open(out, 40);
    for (int i = 0; i < 10; i++) w.line("{\"t\":\"ab\"}"); // 10 bytes
    w.close();
    List<String> lines = Files.readAllLines(out);
    String last = lines.get(lines.size() - 1);
    assertTrue(last.startsWith("{\"t\":\"capped\",\"at\":"), last);
    assertTrue(last.matches("\\{\"t\":\"capped\",\"at\":\\d+}"), last);
    assertEquals(1, lines.stream().filter(l -> l.contains("capped")).count());
    // Every kept line is a whole line written before the cap.
    for (String l : lines.subList(0, lines.size() - 1)) assertEquals("{\"t\":\"ab\"}", l);
    assertTrue(lines.size() > 1, "some lines fit before the cap");
    long size = Files.size(out);
    long cappedBytes = (last + "\n").getBytes(StandardCharsets.UTF_8).length;
    assertTrue(size <= 40 + cappedBytes, "size " + size);
    assertTrue(w.capped());
  }

  @Test
  void writesNothingAfterClose() throws Exception {
    Path out = dir.resolve("x.ndjson");
    EventWriter w = EventWriter.open(out, 1_000_000);
    w.line("{\"t\":\"a\"}");
    w.close();
    w.line("{\"t\":\"b\"}"); // must neither throw nor write
    w.flush();
    assertEquals(List.of("{\"t\":\"a\"}"), Files.readAllLines(out));
  }

  @Test
  void concurrentWritersNeverInterleaveLines() throws Exception {
    Path out = dir.resolve("m.ndjson");
    EventWriter w = EventWriter.open(out, Long.MAX_VALUE);
    int threads = 8;
    int perThread = 1000;
    CountDownLatch start = new CountDownLatch(1);
    List<Thread> ts = new ArrayList<>();
    for (int t = 0; t < threads; t++) {
      final int id = t;
      Thread th =
          new Thread(
              () -> {
                try {
                  start.await();
                } catch (InterruptedException e) {
                  return;
                }
                for (int i = 0; i < perThread; i++) {
                  w.line("{\"t\":\"x\",\"thread\":" + id + ",\"i\":" + i + ",\"pad\":"
                      + EventWriter.quote("p".repeat(i % 50)) + "}");
                }
              });
      ts.add(th);
      th.start();
    }
    start.countDown();
    for (Thread th : ts) th.join();
    w.close();
    List<String> lines = Files.readAllLines(out);
    assertEquals(threads * perThread, lines.size());
    for (String l : lines) {
      assertTrue(
          l.matches("\\{\"t\":\"x\",\"thread\":\\d,\"i\":\\d+,\"pad\":\"p*\"}"),
          "not one whole JSON object: " + l);
    }
  }

  @Test
  void quoteEscapesWhatJsonRequires() {
    assertEquals("\"plain\"", EventWriter.quote("plain"));
    assertEquals("\"a\\\"b\\\\c\"", EventWriter.quote("a\"b\\c"));
    assertEquals("\"\\n\\r\\t\\b\\f\"", EventWriter.quote("\n\r\t\b\f"));
    assertEquals("\"\\u0000\\u001f\"", EventWriter.quote("\u0000\u001f"));
    assertEquals("\"héllo ✓\"", EventWriter.quote("héllo ✓"));
    assertEquals("null", EventWriter.quote(null));
  }
}
