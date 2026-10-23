package io.perfportal.agent;

/**
 * Reads the machine's cumulative CPU time from {@code /proc/stat}: the aggregate {@code cpu}
 * line, in jiffies since boot, in the kernel's own order -- user, nice, system, idle, iowait, irq,
 * softirq, steal. Counters, not rates: the reader differences two samples.
 */
final class ProcStat {
  static final int FIELDS = 8;

  private ProcStat() {}

  /**
   * The eight jiffy counters, or null when {@code content} has no readable {@code cpu} line.
   * A kernel that writes fewer fields (before 2.6.11 the line stops at softirq) reads its missing
   * fields as zero; the guest fields after steal are already counted inside user and nice.
   */
  static long[] parse(String content) {
    for (String line : content.split("\n")) {
      if (!line.startsWith("cpu ")) continue;
      String[] f = line.trim().split("\\s+");
      long[] out = new long[FIELDS];
      try {
        for (int i = 0; i < FIELDS && i + 1 < f.length; i++) out[i] = Long.parseLong(f[i + 1]);
      } catch (NumberFormatException e) {
        return null;
      }
      return out;
    }
    return null;
  }
}
