package io.perfportal.agent;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.ByteBufHolder;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelPromise;
import io.netty.channel.FileRegion;

/**
 * The byte meter on one channel Gatling's HTTP client opened, at the HEAD of its pipeline: it
 * sees what crosses the wire -- ciphertext under TLS -- and its {@code channelInactive} is the
 * channel's close.
 *
 * <p>It is added at {@code Bootstrap.connect}'s EXIT, never in a connect listener: Gatling's own
 * listener on the same future installs the {@code SslHandler}, which writes the ClientHello at
 * once, and a meter added after that would miss it.
 *
 * <p>It also carries what later events about the channel need: its remote, in {@code
 * host/ip:port} form, and whether it was opened during the warm-up. Every callback passes the
 * message on untouched, whatever the collector does.
 */
final class MeterHandler extends ChannelDuplexHandler {
  static final String NAME = "perfportal-meter";

  final String remote;
  final String ch;
  final boolean warmup;

  /** Set once the connect succeeded: only an opened channel has a close to report. */
  volatile boolean opened;

  private boolean closed;

  MeterHandler(String remote, String ch, boolean warmup) {
    this.remote = remote;
    this.ch = ch;
    this.warmup = warmup;
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
