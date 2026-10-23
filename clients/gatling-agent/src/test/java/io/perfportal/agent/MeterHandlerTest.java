package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

import io.netty.channel.ChannelId;
import io.netty.channel.embedded.EmbeddedChannel;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MeterHandlerTest {
  private static final String REMOTE = "localhost/127.0.0.1:8080";

  /**
   * A channel id whose short form is the same for every channel: what Netty's own (the hex of one
   * random 32-bit int) does by chance once a run has opened enough channels.
   */
  private static final class CollidingId implements ChannelId {
    private final String longText;

    CollidingId(String longText) {
      this.longText = longText;
    }

    @Override
    public String asShortText() {
      return "deadbeef";
    }

    @Override
    public String asLongText() {
      return longText;
    }

    @Override
    public int compareTo(ChannelId o) {
      return longText.compareTo(o.asLongText());
    }
  }

  @Test
  void channelsWhoseNettyShortIdsCollideStillGetTheirOwnIdAndRegistryEntry() {
    EmbeddedChannel a = new EmbeddedChannel(new CollidingId("a"));
    EmbeddedChannel b = new EmbeddedChannel(new CollidingId("b"));
    try {
      assertEquals(a.id().asShortText(), b.id().asShortText(), "the stub ids collide");
      MeterHandler ma = MeterHandler.attach(a, REMOTE, false);
      MeterHandler mb = MeterHandler.attach(b, REMOTE, false);
      assertNotEquals(ma.ch, mb.ch);
      assertSame(ma, a.pipeline().first(), "the meter is at the head of the pipeline");

      SocketRegistry r = new SocketRegistry();
      r.opened(ma.ch, 50000, REMOTE);
      r.opened(mb.ch, 50001, REMOTE);
      r.closed(ma.ch, 1_000);
      // Two sockets, two entries: a's row is its TIME_WAIT, b's is still ESTABLISHED.
      assertEquals(
          Map.of(REMOTE, Map.of(1, 1, 6, 1)),
          ProcTables.states(
              r,
              2_000,
              ProcTables.table(
                  ProcTables.row(0, 50000, "127.0.0.1", 8080, 6),
                  ProcTables.row(1, 50001, "127.0.0.1", 8080, 1))));
    } finally {
      a.finishAndReleaseAll();
      b.finishAndReleaseAll();
    }
  }
}
