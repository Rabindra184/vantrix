/** One bucket of a users series: what started, what ended, and the peak running at once. */
export interface UsersBucket {
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

/**
 * ═══ THE RUN'S "ALL USERS" SERIES ═══
 *
 * The per-scenario users rows summed per bucket offset, ascending — Gatling's
 * own "All users" series. `GET /v1/runs/:id/users` serves it as `total`, and
 * the AI run analysis states the run's peak concurrency from it, so the two
 * read ONE definition: a second copy could let the analysis cite a peak the
 * chart beside it does not draw.
 *
 * `maxConcurrent` is the SUM of each scenario's maximum within the bucket —
 * verified against Gatling across all 63 fixture buckets. Summing maxima is
 * normally wrong (max(a+b) != max(a)+max(b)); here it is what parity
 * requires. Do not "fix" this to a true max-of-sums. What it never does is add
 * each scenario's peak over the WHOLE run: the run's peak is the largest
 * bucket total, not a sum of peaks reached at different moments.
 *
 * The rows may arrive in any order; the input is not mutated.
 */
export function sumUsersByOffset(rows: readonly UsersBucket[]): UsersBucket[] {
  const total = new Map<number, UsersBucket>();
  for (const r of rows) {
    const t = total.get(r.startOffsetMs) ?? {
      startOffsetMs: r.startOffsetMs, started: 0, ended: 0, maxConcurrent: 0,
    };
    t.started += r.started;
    t.ended += r.ended;
    t.maxConcurrent += r.maxConcurrent;
    total.set(r.startOffsetMs, t);
  }
  return [...total.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
}
