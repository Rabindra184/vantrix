package io.perfportal.agent;

/** Reads the machine's memory from {@code /proc/meminfo}: {@code MemTotal} and {@code MemAvailable}. */
final class ProcMeminfo {
  private ProcMeminfo() {}

  /**
   * {@code {MemTotal kB, MemAvailable kB}}, or null when either is missing. {@code MemAvailable}
   * (kernel 3.14+) is the kernel's own estimate of memory a new workload can use without
   * swapping; {@code MemFree} is a different, smaller figure and is never substituted for it.
   */
  static long[] parse(String content) {
    long total = -1;
    long available = -1;
    for (String line : content.split("\n")) {
      if (line.startsWith("MemTotal:")) total = kb(line);
      else if (line.startsWith("MemAvailable:")) available = kb(line);
    }
    return total < 0 || available < 0 ? null : new long[] {total, available};
  }

  private static long kb(String line) {
    String[] f = line.trim().split("\\s+");
    if (f.length < 2) return -1;
    try {
      return Long.parseLong(f[1]);
    } catch (NumberFormatException e) {
      return -1;
    }
  }
}
