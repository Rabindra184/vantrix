import type { UseQueryResult } from '@tanstack/react-query';
import type { RunnerJobListResponse } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';
import { RUNNER_STATUS_INFO, runnerReadiness, type RunnerReadinessKind } from './runnerReadiness';

/**
 * Status colours, read through `var()`: they are declared on `:root` rather
 * than in `@theme`, so `text-status-*` utilities emit nothing. A state that
 * accuses nothing (unknown, idle) is the not-applicable grey — none of these
 * may read as "available", which is the whole point of `runnerReadiness`.
 */
const READINESS_COLOR: Record<RunnerReadinessKind, string> = {
  busy: 'var(--color-status-pending)',
  waiting: 'var(--color-status-pending)',
  stalled: 'var(--color-status-failed)',
  idle: 'var(--color-status-not-applicable)',
  unknown: 'var(--color-status-not-applicable)',
};

/**
 * ═══ THE RUNNER'S STATUS, ONE LINE (clean UI, PR 4) ═══
 *
 * Add results and New on-prem run both draw this: the headline, one short
 * fact, and the caveat every state shares behind one ⓘ. Before, each page
 * printed the state as a headline, a two-sentence explanation and a footnote,
 * and said the caveat twice.
 *
 * A FAILED QUERY IS ITS OWN STATUS, and carries no ⓘ: "this page could not
 * ask" is not a runner state, so the states' caveat says nothing about it.
 *
 * `query` is narrowed to the three fields read, so a test can hand it a plain
 * object and both pages can hand it their own `useQuery` result.
 */
export default function RunnerStatusLine({
  query,
}: {
  readonly query: Pick<UseQueryResult<RunnerJobListResponse, Error>, 'isPending' | 'isError' | 'data'>;
}) {
  if (query.isPending) {
    return (
      <p data-testid="runner-status" className="text-[0.8125rem] text-muted">
        Checking…
      </p>
    );
  }

  const items = query.isError ? undefined : query.data?.items;
  const readiness = items === undefined ? null : runnerReadiness(items);
  const headline = readiness?.headline ?? 'Status unavailable';
  const fact = readiness?.fact ?? 'The job list could not be loaded';
  const colour = READINESS_COLOR[readiness?.kind ?? 'unknown'];

  return (
    <p data-testid="runner-status" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.8125rem]">
      {/* The dot is `aria-hidden` and the WORDS carry the state, so the status
          is not a colour a reader has to have learnt. */}
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase"
        style={{ color: colour }}
      >
        <span aria-hidden="true">●</span>
        {headline}
      </span>
      {/* A SPOKEN SEPARATOR (PR 4 cleanup): the "·" is decoration, so without
          this a screen reader heard the headline and the fact as one run-on
          phrase. Real spaces between the pieces too, not only the flex gap: a
          gap moves pixels, and a copy reads text nodes. */}
      <span className="sr-only">,</span>{' '}
      <span aria-hidden="true" className="text-muted">
        ·
      </span>{' '}
      <span className="text-muted">{fact}</span>{' '}
      {readiness !== null && <InfoTip label="About runner status">{RUNNER_STATUS_INFO}</InfoTip>}
    </p>
  );
}
