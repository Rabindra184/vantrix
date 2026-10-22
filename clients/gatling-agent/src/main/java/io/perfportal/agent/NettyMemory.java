package io.perfportal.agent;

import java.lang.reflect.Method;

/**
 * Reads Netty's own allocator metrics -- used direct and used heap memory of {@code
 * ByteBufAllocator.DEFAULT} -- from the simulation's Netty, by reflection, since the agent
 * bundles no Netty of its own.
 *
 * <p>It reads nothing until {@link #arm()} is called, on the first connect the instrumentation
 * observes. Touching {@code ByteBufAllocator.DEFAULT} initialises Netty's allocator; doing that
 * from the agent before the simulation does would run Netty's static setup on the agent's
 * thread and at the agent's moment, and the agent must never change what the JVM it rides in
 * would have done.
 */
final class NettyMemory {
  private static volatile boolean armed;
  private static volatile Reader reader;

  private NettyMemory() {}

  /** Netty is in use: from now on {@link #read} may touch its allocator. */
  static void arm() {
    armed = true;
  }

  /** For tests, which share one JVM. */
  static void disarm() {
    armed = false;
    reader = null;
  }

  /**
   * {@code {usedDirect, usedHeap}} in bytes, or null before {@link #arm()}, with no class
   * loader, or when {@code cl} has no Netty allocator that reports its metrics.
   */
  static long[] read(ClassLoader cl) {
    if (!armed || cl == null) return null;
    try {
      Reader r = reader;
      if (r == null || r.cl != cl) {
        r = Reader.of(cl);
        if (r == null) return null;
        reader = r;
      }
      return new long[] {
        ((Number) r.usedDirect.invoke(r.metric)).longValue(),
        ((Number) r.usedHeap.invoke(r.metric)).longValue()
      };
    } catch (Exception | LinkageError e) {
      return null;
    }
  }

  private static final class Reader {
    final ClassLoader cl;
    final Object metric;
    final Method usedDirect;
    final Method usedHeap;

    private Reader(ClassLoader cl, Object metric, Method usedDirect, Method usedHeap) {
      this.cl = cl;
      this.metric = metric;
      this.usedDirect = usedDirect;
      this.usedHeap = usedHeap;
    }

    /**
     * Resolved through the public interfaces ({@code ByteBufAllocatorMetricProvider}, {@code
     * ByteBufAllocatorMetric}), never the implementation class, so no access check can refuse
     * it. The metric object is a live view, so it is fetched once.
     */
    static Reader of(ClassLoader cl) throws ReflectiveOperationException {
      Class<?> allocator = Class.forName("io.netty.buffer.ByteBufAllocator", false, cl);
      Object def = allocator.getField("DEFAULT").get(null);
      Class<?> provider = Class.forName("io.netty.buffer.ByteBufAllocatorMetricProvider", false, cl);
      if (!provider.isInstance(def)) return null;
      Object metric = provider.getMethod("metric").invoke(def);
      Class<?> metricType = Class.forName("io.netty.buffer.ByteBufAllocatorMetric", false, cl);
      return new Reader(
          cl, metric, metricType.getMethod("usedDirectMemory"), metricType.getMethod("usedHeapMemory"));
    }
  }
}
