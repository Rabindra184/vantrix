package io.perfportal.agent;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Appends one JSON object per line to the agent's NDJSON file, from any thread.
 *
 * <p>Every method is {@code synchronized}, so a line is written whole or not at all and two
 * threads never interleave. Nothing here throws once the file is open: an I/O failure silences
 * the writer for good, because the agent must never fail or slow the simulation it observes.
 *
 * <p>The file is capped at {@code maxBytes}: the first line that would cross it is replaced by
 * one {@code {"t":"capped","at":<epochMs>}} line, and every later line is dropped. The capped
 * line itself may cross the limit, by its own length and no more.
 */
final class EventWriter {
  private final OutputStream out;
  private final long maxBytes;
  private long written;
  private boolean capped;
  private boolean closed;

  private EventWriter(OutputStream out, long maxBytes) {
    this.out = out;
    this.maxBytes = maxBytes;
  }

  static EventWriter open(Path out, long maxBytes) throws IOException {
    OutputStream stream =
        Files.newOutputStream(
            out,
            StandardOpenOption.CREATE,
            StandardOpenOption.TRUNCATE_EXISTING,
            StandardOpenOption.WRITE);
    return new EventWriter(new BufferedOutputStream(stream, 64 * 1024), maxBytes);
  }

  /** Writes {@code json} and a newline; {@code json} must be one JSON object with no newline. */
  synchronized void line(String json) {
    if (closed || capped) return;
    byte[] bytes = (json + "\n").getBytes(StandardCharsets.UTF_8);
    try {
      if (written + bytes.length > maxBytes) {
        capped = true;
        byte[] marker =
            ("{\"t\":\"capped\",\"at\":" + System.currentTimeMillis() + "}\n")
                .getBytes(StandardCharsets.UTF_8);
        out.write(marker);
        written += marker.length;
        out.flush();
        return;
      }
      out.write(bytes);
      written += bytes.length;
    } catch (IOException e) {
      silence();
    }
  }

  synchronized void flush() {
    if (closed) return;
    try {
      out.flush();
    } catch (IOException e) {
      silence();
    }
  }

  synchronized boolean capped() {
    return capped;
  }

  synchronized void close() {
    if (closed) return;
    try {
      out.flush();
    } catch (IOException ignored) {
      // closing anyway
    }
    silence();
  }

  private void silence() {
    closed = true;
    try {
      out.close();
    } catch (IOException ignored) {
      // nothing left to do
    }
  }

  /**
   * {@code s} as a JSON string literal, quotes included; {@code null} becomes {@code null}. The
   * one escaping helper in the agent, which carries no JSON library.
   */
  static String quote(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder(s.length() + 2);
    b.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':
          b.append("\\\"");
          break;
        case '\\':
          b.append("\\\\");
          break;
        case '\n':
          b.append("\\n");
          break;
        case '\r':
          b.append("\\r");
          break;
        case '\t':
          b.append("\\t");
          break;
        case '\b':
          b.append("\\b");
          break;
        case '\f':
          b.append("\\f");
          break;
        default:
          if (c < 0x20) {
            b.append(String.format("\\u%04x", (int) c));
          } else {
            b.append(c);
          }
      }
    }
    return b.append('"').toString();
  }
}
