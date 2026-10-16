/**
 * ═══ THE PARTITION KEY, AS THE UTC CALENDAR DAY IT IS ═══
 *
 * `run_started_on` is the run's start date in UTC — `startedOnFrom` derives it
 * that way and Prisma writes it that way. Every Date this package is handed for
 * it is therefore UTC midnight.
 *
 * node-postgres does NOT send a Date as that day. It renders a Date parameter
 * in the PROCESS's local zone, and Postgres casts what arrives to a date — so on
 * a host west of UTC, 2026-10-16T00:00Z went out as 2026-10-15T20:00-04:00 and
 * landed on the 15th. Measured: TZ=America/New_York renders it 2026-10-15. A
 * worker there wrote buckets a day early, a recompute's DELETE missed the
 * legacy rows on the right day while its INSERT wrote new ones on the wrong
 * one, and a reader there looked on the wrong day too. East of UTC the local
 * date happens to be right, which is why it hid.
 *
 * So the day is bound as `YYYY-MM-DD` text, read off the UTC fields — the shape
 * `telemetry.ts`' `sampledOn` already uses for its own partition key. One
 * function for the writer, the delete and the reader, so they cannot disagree.
 */
export function partitionDay(runStartedOn: Date): string {
  return runStartedOn.toISOString().slice(0, 10);
}
