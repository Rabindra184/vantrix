package io.perfportal.agent;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.ByteBufHolder;
import io.netty.channel.Channel;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelPromise;
import io.netty.channel.FileRegion;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The byte meter on one channel Gatling's HTTP client opened, at the HEAD of its pipeline: it
 * sees what crosses the wire -- ciphertext under TLS -- and its {@code channelInactive} is the
 * channel's close.
 *
 * <p>It is added at {@code Bootstrap.connect}'s EXIT, synchronously, never later: Gatling's own
 * listener on the connect future installs the {@code SslHandler}, which writes the ClientHello at
 * once, and a meter added after that listener has run misses it (measured: about 150 bytes a
 * handshake instead of about 1,590). Added at the exit, it is on the channel before any listener
 * can run, whatever order listeners are notified in.
 *
 * <p>It also carries what later events about the channel need: its {@link #ch}, its remote, in
 * {@code host/ip:port} form, and whether it was opened during the warm-up. Every callback passes
 * the message on untouched, whatever the collector does.
 */
final class MeterHandler extends ChannelDuplexHandler {
  static final String NAME = "perfportal-meter";

  /** The last {@link #ch} handed out; the first channel is 1. */
  private static final AtomicLong CHANNELS = new AtomicLong();

  /**
   * The channel's id in the agent's file: a number, unique within this JVM, assigned once here,
   * where the meter is attached, and repeated by every line about the channel. Not Netty's
   * {@code ChannelId.asShortText()}: in Netty 4.2 that is the hex of one random 32-bit int,
   * documented as globally non-unique, and at Gatling's one connection per virtual user it
   * collides within a run (about 1% at 10,000 channels, 63% at 93,000).
   */
  final long ch;

  final String remote;
  final boolean warmup;

  /** Set once the connect succeeded: only an opened channel has a close to report. */
  volatile boolean opened;

  private boolean closed;

  MeterHandler(long ch, String remote, boolean warmup) {
    this.ch = ch;
    this.remote = remote;
    this.warmup = warmup;
  }

  /** Puts a new meter, with the next {@link #ch}, at the head of {@code channel}'s pipeline. */
  static MeterHandler attach(Channel channel, String remote, boolean warmup) {
    MeterHandler meter = new MeterHandler(CHANNELS.incrementAndGet(), remote, warmup);
    channel.pipeline().addFirst(NAME, meter);
    return meter;
  }

  @Override
  public void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception {
    long n = size(msg);
    if (n > 0) Collector.bytes(remote, 0, n);
    super.channelRead(ctx, msg);
  }

  @Override
  public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
    long n = size(msg);
    if (n > 0) Collector.bytes(remote, n, 0);
    super.write(ctx, msg, promise);
  }

  @Override
  public void channelInactive(ChannelHandlerContext ctx) throws Exception {
    reportClose();
    super.channelInactive(ctx);
  }

  /** A meter removed from an open channel cannot see its close; report it now, not never. */
  @Override
  public void handlerRemoved(ChannelHandlerContext ctx) {
    reportClose();
  }

  // Event-loop only: channelInactive and handlerRemoved run on the channel's own loop.
  private void reportClose() {
    if (closed || !opened) return;
    closed = true;
    Collector.close(this);
  }

  private static long size(Object msg) {
    try {
      if (msg instanceof ByteBuf) return ((ByteBuf) msg).readableBytes();
      if (msg instanceof ByteBufHolder) return ((ByteBufHolder) msg).content().readableBytes();
      if (msg instanceof FileRegion) return ((FileRegion) msg).count();
    } catch (Throwable t) {
      AgentMain.fail("meter", t);
    }
    return 0;
  }
}
