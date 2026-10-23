package io.perfportal.agent;

import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

import java.net.SocketAddress;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.utility.JavaModule;

/**
 * Installs the HTTP instrumentation: the hook points, each observed in a real Gatling 3.15.1 run
 * (Netty 4.2.14), and only ever installed behind {@link VersionGate}.
 *
 * <ul>
 *   <li>DNS: the two leaf resolvers' {@code resolveAll} -- the JDK one ({@code
 *       InetAddressNameResolver$1}) and Netty's async one ({@code InetAddressNameResolverWrapper})
 *       -- so one lookup is one event; the shuffling, in-flight and alias wrappers are skipped.
 *   <li>TCP connect: {@code Bootstrap.connect(remote, local)}, counted only while {@code
 *       DefaultHttpClient.openNewChannelRec} is on the stack; the byte meter goes on there.
 *   <li>TLS: {@code DefaultHttpClient.installSslHandler}, the one place Gatling's client adds an
 *       {@code SslHandler} -- it has the channel, so the event names the remote with its ip.
 *   <li>Status: {@code GatlingHttpListener.onHttpResponse}, with the transaction's request name.
 *   <li>Warm-up: {@code HttpEngine.warmUp}, which blocks until the warm-up answers.
 * </ul>
 *
 * Everything outside {@code io.gatling.http.} and Netty's {@code Bootstrap} is ignored by NAME
 * before any matcher sees it: the cheaper of the matchers the spike measured.
 */
final class Instrumentation {
  private Instrumentation() {}

  static void install(java.lang.instrument.Instrumentation inst) {
    new AgentBuilder.Default()
        .disableClassFormatChanges()
        .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
        .with(
            new AgentBuilder.Listener.Adapter() {
              @Override
              public void onError(
                  String typeName,
                  ClassLoader classLoader,
                  JavaModule module,
                  boolean loaded,
                  Throwable throwable) {
                AgentMain.fail("instrument " + typeName, throwable);
              }
            })
        .ignore(not(nameStartsWith("io.gatling.http.").or(named("io.netty.bootstrap.Bootstrap"))))
        .type(
            named("io.gatling.http.client.resolver.InetAddressNameResolver$1")
                .or(named("io.gatling.http.client.resolver.InetAddressNameResolverWrapper")))
        .transform(
            (builder, type, loader, module, domain) ->
                builder.visit(
                    Advice.to(Advices.Dns.class)
                        .on(named("resolveAll").and(takesArguments(3)).and(takesArgument(0, String.class)))))
        .type(named("io.gatling.http.client.impl.DefaultHttpClient"))
        .transform(
            (builder, type, loader, module, domain) ->
                builder
                    .visit(Advice.to(Advices.Opening.class).on(named("openNewChannelRec")))
                    .visit(
                        Advice.to(Advices.Tls.class)
                            .on(named("installSslHandler").and(takesArguments(5)))))
        .type(named("io.netty.bootstrap.Bootstrap"))
        .transform(
            (builder, type, loader, module, domain) ->
                builder.visit(
                    Advice.to(Advices.Connect.class)
                        .on(
                            named("connect")
                                .and(takesArguments(2))
                                .and(takesArgument(0, SocketAddress.class))
                                .and(takesArgument(1, SocketAddress.class)))))
        .type(named("io.gatling.http.engine.GatlingHttpListener"))
        .transform(
            (builder, type, loader, module, domain) ->
                builder.visit(Advice.to(Advices.Status.class).on(named("onHttpResponse"))))
        .type(named("io.gatling.http.engine.HttpEngine"))
        .transform(
            (builder, type, loader, module, domain) ->
                builder.visit(Advice.to(Advices.WarmUpWindow.class).on(named("warmUp"))))
        .installOn(inst);
  }
}
