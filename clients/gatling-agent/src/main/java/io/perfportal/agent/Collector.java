package io.perfportal.agent;

import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelFutureListener;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.util.concurrent.Future;
import io.netty.util.concurrent.GenericFutureListener;
import io.gatling.http.engine.tx.HttpTx;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;

/**
 * Where the instrumentation's advice lands. The {@code public} methods are called by advice
 * INLINED into Gatling's and Netty's classes (see {@link Advices}), so their parameters are
 * {@code Object}s and the casts happen here; the rest write the event lines.
 *
 * <p>Every event line ({@code at} = epoch ms, {@code us} = µs):
 *
 * <pre>
 * {"t":"dns","at","us","host","ok"[,"warmup":true]}
 * {"t":"connect","at","us","remote","ok","ch"[,"warmup":true]}
 * {"t":"tls","at","us","remote","ok"[,"ch"][,"warmup":true]}
 * {"t":"close","at","ch","remote"}
 * {"t":"status","at","req","code"}
 * </pre>
 *
 * For an event with a duration, {@code at} is when it STARTED; for a close or a status, when it
 * happened. {@code remote} is {@code host/ip:port} with the RESOLVED ip -- the form {@link
 * SocketRegistry} matches {@code /proc/net/tcp*} rows by.
 *
 * <p>{@code ch} is a JSON NUMBER, the agent's own id for the channel ({@link MeterHandler#ch}):
 * unique within the file, it pairs a {@code connect} with its {@code close} and with the
 * channel's {@code tls}. A {@code tls} line carries it whenever the channel was opened by
 * Gatling's client (and so metered). A {@code status} line carries none: the hook it comes from
 * sees the request's transaction, not its channel.
 *
 * <p>Nothing here throws into the simulation. The first throwable caught goes through {@link
 * AgentMain#fail}, which writes one {@code error} line and seals the writer; from then on {@link
 * AgentMain#writer()} is null and every method here returns at once.
 */
public final class Collector {
  /**
   * Depth of Gatling's {@code DefaultHttpClient.openNewChannelRec} on this thread. {@code
   * Bootstrap.connect} is Netty's, so it is only Gatling's connect while this is above zero. A
   * depth, because {@code openNewChannelRec} can call itself.
   */
  private static final ThreadLocal<int[]> OPENING = ThreadLocal.withInitial(() -> new int[1]);

  private Collector() {}

  // ---------------------------------------------------------------- advice entry points

  /** {@code resolveAll(host, promise, listener)} returned {@code future} or threw {@code thrown}. */
  public static void resolving(String host, long startNanos, Object future, Throwable thrown) {
    try {
      if (AgentMain.writer() == null || host == null || isIpLiteral(host)) return;
      boolean warmup = WarmUp.active();
      if (thrown != null || !(future instanceof Future)) {
        dns(host, startNanos, false, warmup);
        return;
      }
      ((Future<?>) future)
          .addListener(
              (GenericFutureListener<Future<Object>>)
                  done -> dns(host, startNanos, done.isSuccess(), warmup));
    } catch (Throwable t) {
      AgentMain.fail("dns", t);
    }
  }

  public static void enterOpening() {
    OPENING.get()[0]++;
  }

  public static void exitOpening() {
    int[] depth = OPENING.get();
    if (depth[0] > 0) depth[0]--;
  }

  /**
   * {@code Bootstrap.connect(remote, local)} returned {@code channelFuture}. Ignored unless
   * Gatling's client is the caller. The meter goes on the channel NOW, at the call's exit, before
   * anyone's listener on the future can write to it.
   */
  public static void connecting(Object remote, Object channelFuture, long startNanos) {
    try {
      if (OPENING.get()[0] == 0 || AgentMain.writer() == null) return;
      if (!(remote instanceof InetSocketAddress) || !(channelFuture instanceof ChannelFuture)) return;
      InetSocketAddress address = (InetSocketAddress) remote;
      ChannelFuture future = (ChannelFuture) channelFuture;
      Channel ch = future.channel();
      // Netty is in use from here on, so the sampler may read its allocator.
      NettyMemory.arm();
      MeterHandler meter = MeterHandler.attach(ch, remote(address), WarmUp.active());
      future.addListener(
          (ChannelFutureListener) done -> connected(meter, ch, startNanos, done.isSuccess()));
    } catch (Throwable t) {
      AgentMain.fail("connect", t);
    }
  }

  /**
   * {@code DefaultHttpClient.installSslHandler(tx, channel, host, port, ...)} returned the
   * handshake future (or a failed one), or threw. The channel's meter names the remote with its
   * ip and says whether the channel belongs to the warm-up.
   */
  public static void handshaking(
      Object channel, String host, int port, long startNanos, Object handshake, Throwable thrown) {
    try {
      if (AgentMain.writer() == null || !(channel instanceof Channel)) return;
      Channel ch = (Channel) channel;
      MeterHandler meter = ch.pipeline().get(MeterHandler.class);
      String remote = meter != null ? meter.remote : remote(host, ch.remoteAddress(), port);
      boolean warmup = WarmUp.active() || (meter != null && meter.warmup);
      if (thrown != null || !(handshake instanceof Future)) {
        tls(remote, startNanos, false, warmup, meter);
        return;
      }
      ((Future<?>) handshake)
          .addListener(
              (GenericFutureListener<Future<Object>>)
                  done -> tls(remote, startNanos, done.isSuccess(), warmup, meter));
    } catch (Throwable t) {
      AgentMain.fail("tls", t);
    }
  }

  /** {@code GatlingHttpListener.onHttpResponse(status, headers)}, with the listener's {@code tx}. */
  public static void responded(Object tx, Object status) {
    try {
      if (AgentMain.writer() == null) return;
      if (!(tx instanceof HttpTx) || !(status instanceof HttpResponseStatus)) return;
      status(((HttpTx) tx).fullRequestName(), ((HttpResponseStatus) status).code());
    } catch (Throwable t) {
      AgentMain.fail("status", t);
    }
  }

  // ---------------------------------------------------------------- the events

  static void dns(String host, long startNanos, boolean ok, boolean warmup) {
    timed("dns", startNanos, ",\"host\":" + EventWriter.quote(host), ok, warmup);
  }

  static void connected(MeterHandler meter, Channel ch, long startNanos, boolean ok) {
    try {
      if (AgentMain.writer() == null) return;
      if (ok) {
        SocketAddress local = ch.localAddress();
        int localPort = local instanceof InetSocketAddress ? ((InetSocketAddress) local).getPort() : -1;
        AgentMain.sockets().opened(meter.ch, localPort, meter.remote);
        meter.opened = true;
      }
      timed(
          "connect",
          startNanos,
          ",\"remote\":" + EventWriter.quote(meter.remote),
          ok,
          meter.warmup,
          ",\"ch\":" + meter.ch);
    } catch (Throwable t) {
      AgentMain.fail("connect", t);
    }
  }

  static void tls(String remote, long startNanos, boolean ok, boolean warmup, MeterHandler meter) {
    timed(
        "tls",
        startNanos,
        ",\"remote\":" + EventWriter.quote(remote),
        ok,
        warmup,
        meter == null ? "" : ",\"ch\":" + meter.ch);
  }

  static void close(MeterHandler meter) {
    try {
      EventWriter w = AgentMain.writer();
      long now = System.currentTimeMillis();
      AgentMain.sockets().closed(meter.ch, now);
      if (w == null) return;
      w.line(
          "{\"t\":\"close\",\"at\":"
              + now
              + ",\"ch\":"
              + meter.ch
              + ",\"remote\":"
              + EventWriter.quote(meter.remote)
              + "}");
    } catch (Throwable t) {
      AgentMain.fail("close", t);
    }
  }

  static void bytes(String remote, long out, long in) {
    try {
      if (AgentMain.writer() == null) return;
      AgentMain.sockets().addBytes(remote, out, in);
    } catch (Throwable t) {
      AgentMain.fail("bytes", t);
    }
  }

  static void status(String requestName, int code) {
    try {
      EventWriter w = AgentMain.writer();
      if (w == null) return;
      w.line(
          "{\"t\":\"status\",\"at\":"
              + System.currentTimeMillis()
              + ",\"req\":"
              + EventWriter.quote(requestName)
              + ",\"code\":"
              + code
              + "}");
    } catch (Throwable t) {
      AgentMain.fail("status", t);
    }
  }

  private static void timed(String type, long startNanos, String fields, boolean ok, boolean warmup) {
    timed(type, startNanos, fields, ok, warmup, "");
  }

  private static void timed(
      String type, long startNanos, String fields, boolean ok, boolean warmup, String tail) {
    try {
      EventWriter w = AgentMain.writer();
      if (w == null) return;
      long us = Math.max(0, (System.nanoTime() - startNanos) / 1_000);
      long at = System.currentTimeMillis() - us / 1_000;
      w.line(
          "{\"t\":\""
              + type
              + "\",\"at\":"
              + at
              + ",\"us\":"
              + us
              + fields
              + ",\"ok\":"
              + ok
              + tail
              + (warmup ? ",\"warmup\":true" : "")
              + "}");
    } catch (Throwable t) {
      AgentMain.fail(type, t);
    }
  }

  // ---------------------------------------------------------------- naming

  /** {@code host/ip:port}; an unresolved address has no ip and gives {@code host/:port}. */
  static String remote(InetSocketAddress a) {
    return remote(a.getHostString(), a, a.getPort());
  }

  static String remote(String host, SocketAddress address, int port) {
    InetAddress ip =
        address instanceof InetSocketAddress ? ((InetSocketAddress) address).getAddress() : null;
    String literal = "";
    if (ip != null) {
      literal = ip.getHostAddress();
      if (ip instanceof Inet6Address) literal = "[" + literal + "]";
    }
    return host + "/" + literal + ":" + port;
  }

  /**
   * Whether {@code host} is an IPv4 or IPv6 literal. Gatling hands literals to its resolver too,
   * and resolving one is not a DNS lookup, so it is not reported as one.
   */
  static boolean isIpLiteral(String host) {
    if (host.isEmpty()) return false;
    if (host.indexOf(':') >= 0) return true; // only an IPv6 literal carries a colon
    int dots = 0;
    int digits = 0;
    for (int i = 0; i < host.length(); i++) {
      char c = host.charAt(i);
      if (c == '.') {
        if (digits == 0) return false;
        dots++;
        digits = 0;
      } else if (c >= '0' && c <= '9') {
        if (++digits > 3) return false;
      } else {
        return false;
      }
    }
    return dots == 3 && digits > 0;
  }
}
