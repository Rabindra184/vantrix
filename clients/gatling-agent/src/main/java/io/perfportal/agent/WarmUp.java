package io.perfportal.agent;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Whether Gatling's HTTP warm-up is running. {@code HttpEngine.warmUp} BLOCKS until the warm-up
 * request has been answered, so everything Gatling resolves, connects or handshakes while it runs
 * is warm-up traffic, and is tagged {@code "warmup":true} -- and a channel opened then stays
 * tagged for its whole life (see {@link MeterHandler#warmup}).
 *
 * <p>A depth rather than a boolean, so a nested or concurrent warm-up cannot clear the flag under
 * another one still running. Public only because the advice inlined into {@code HttpEngine} calls
 * it.
 */
public final class WarmUp {
  private static final AtomicInteger depth = new AtomicInteger();

  private WarmUp() {}

  public static void enter() {
    depth.incrementAndGet();
  }

  public static void exit() {
    depth.decrementAndGet();
  }

  public static boolean active() {
    return depth.get() > 0;
  }
}
