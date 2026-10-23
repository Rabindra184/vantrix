package io.perfportal.agent;

import net.bytebuddy.asm.Advice;

/**
 * The advice {@link Instrumentation} weaves into Gatling and Netty. Advice bodies are INLINED into
 * the target methods, so each one only hands its arguments to {@link Collector} -- as {@code
 * Object}s, cast there -- and suppresses every throwable: nothing the agent does can reach the
 * simulation, whatever happens inside it.
 *
 * <p>The agent jar is on the system class path, which Gatling and the simulation share, so the
 * inlined calls resolve {@code Collector} and {@code WarmUp} directly.
 */
final class Advices {
  private Advices() {}

  /** {@code InetAddressNameResolver$1.resolveAll} and {@code InetAddressNameResolverWrapper.resolveAll}. */
  static final class Dns {
    private Dns() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static long enter() {
      return System.nanoTime();
    }

    @Advice.OnMethodExit(suppress = Throwable.class, onThrowable = Throwable.class)
    static void exit(
        @Advice.Enter long startNanos,
        @Advice.Argument(0) String host,
        @Advice.Return Object future,
        @Advice.Thrown Throwable thrown) {
      Collector.resolving(host, startNanos, future, thrown);
    }
  }

  /** {@code DefaultHttpClient.openNewChannelRec}: marks the {@code Bootstrap.connect} it makes as Gatling's. */
  static final class Opening {
    private Opening() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static void enter() {
      Collector.enterOpening();
    }

    @Advice.OnMethodExit(suppress = Throwable.class, onThrowable = Throwable.class)
    static void exit() {
      Collector.exitOpening();
    }
  }

  /** {@code Bootstrap.connect(SocketAddress, SocketAddress)}. */
  static final class Connect {
    private Connect() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static long enter() {
      return System.nanoTime();
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    static void exit(
        @Advice.Enter long startNanos,
        @Advice.Argument(0) Object remote,
        @Advice.Return Object channelFuture) {
      Collector.connecting(remote, channelFuture, startNanos);
    }
  }

  /** {@code DefaultHttpClient.installSslHandler(HttpTx, Channel, String host, int port, String)}. */
  static final class Tls {
    private Tls() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static long enter() {
      return System.nanoTime();
    }

    @Advice.OnMethodExit(suppress = Throwable.class, onThrowable = Throwable.class)
    static void exit(
        @Advice.Enter long startNanos,
        @Advice.Argument(1) Object channel,
        @Advice.Argument(2) String host,
        @Advice.Argument(3) int port,
        @Advice.Return Object handshake,
        @Advice.Thrown Throwable thrown) {
      Collector.handshaking(channel, host, port, startNanos, handshake, thrown);
    }
  }

  /** {@code GatlingHttpListener.onHttpResponse(HttpResponseStatus, HttpHeaders)}. */
  static final class Status {
    private Status() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static void enter(@Advice.FieldValue("tx") Object tx, @Advice.Argument(0) Object status) {
      Collector.responded(tx, status);
    }
  }

  /** {@code HttpEngine.warmUp(HttpComponents)}, which blocks until the warm-up has answered. */
  static final class WarmUpWindow {
    private WarmUpWindow() {}

    @Advice.OnMethodEnter(suppress = Throwable.class)
    static void enter() {
      WarmUp.enter();
    }

    @Advice.OnMethodExit(suppress = Throwable.class, onThrowable = Throwable.class)
    static void exit() {
      WarmUp.exit();
    }
  }
}
