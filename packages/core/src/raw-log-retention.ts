/** Ninety days: long enough to re-verify, recompute or re-download a run inside a quarter. */
export const DEFAULT_RAW_LOG_RETENTION_DAYS = 90;

/**
 * `RAW_LOG_RETENTION_DAYS`: how many days a run's raw log is kept after its
 * ingest. A whole, non-negative number of days — `0` keeps raw logs for ever —
 * or the default when unset or blank (compose passes an unset variable as an
 * EMPTY string). Anything else THROWS, naming the variable, so the process
 * refuses to start rather than guessing: a `-1` written to mean "for ever"
 * falling back to ninety days would delete logs nobody chose to delete.
 *
 * ONE definition, read by two processes: the worker ACTS on the setting (the
 * sweeper deletes past it) and the API STATES it (Administration › Data
 * integrity). Two copies of this rule could let the page state a retention
 * the worker does not apply.
 */
export function parseRawLogRetentionDays(value: string | undefined): number {
  const text = value?.trim() ?? '';
  if (text === '') return DEFAULT_RAW_LOG_RETENTION_DAYS;
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `RAW_LOG_RETENTION_DAYS must be a whole number of days (0 keeps raw logs for ever); got "${value}"`,
    );
  }
  return Number(text);
}

/**
 * ═══ THE DAY A RUN'S RAW LOG FALLS DUE FOR DELETION ═══
 *
 * The UTC calendar day of the ingest, plus `days`, as the UTC midnight that
 * starts that day; null when raw logs are kept for ever (`days` of 0).
 * `ingested_at` is the retention clock the sweeper reads too.
 *
 * ONE rule, used by two processes: the worker stores it on the verification
 * row, and the API derives it at READ time from the deployment's CURRENT
 * setting — a date stored once at verify time goes stale when the setting
 * changes. It is the day retention may delete the log, not a promise that it
 * will: a run still to be verified or recomputed, or whose verification found
 * a mismatch, keeps its log past it.
 */
export function retainedUntil(ingestedAt: Date, days: number): Date | null {
  if (days === 0) return null;
  return new Date(Date.UTC(ingestedAt.getUTCFullYear(), ingestedAt.getUTCMonth(), ingestedAt.getUTCDate() + days));
}
