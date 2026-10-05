import type { RunRecord } from '@perfportal/persistence';

/**
 * The simulation's own checks as a tally, or null when there are none to tally.
 *
 * THE ARRAY IS DELIBERATELY NOT SENT. A corpus run declares hundreds of
 * assertions, and a page of 25 such runs would carry every expression across
 * the wire to render one number. The run's own page is where they belong.
 *
 * `null` for a run that reported none at all, which is not the same as a run
 * whose checks all passed — the list renders the first as unavailable and the
 * second as zero failures.
 *
 * ONE DEFINITION, TWO LISTS. The run list and the org-wide test list both
 * draw a run's checks as `failed / total`, and a tally computed twice is how
 * two surfaces come to disagree about the same run.
 */
export function checkTally(
  toolAssertions: RunRecord['toolAssertions'],
): { failed: number; total: number } | null {
  if (toolAssertions === null || toolAssertions === undefined) return null;
  if (toolAssertions.length === 0) return null;
  return {
    failed: toolAssertions.filter((a) => a.outcome === 'failed').length,
    total: toolAssertions.length,
  };
}
