import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { RunEvent } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import { fetchRunEvents, RUN_EVENTS_POLL_MS, runEventsQueryKey } from '../api/runEvents';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatLogTime } from './format';
import { highlightLogMessage } from './logLine';
import { useRunTerminal } from './useRunWindow';

/**
 * ═══ THE LOGS TAB ═══ (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * A run's lifecycle events in one dark, monospace block, the way Gatling
 * Enterprise's Logs tab shows its own: `[time] [source] message` lines and
 * `---| Phase |---` separators, nothing else on the tab, no controls. Never
 * Gatling's console.
 *
 * LIVE: while the run is not terminal the events are re-read every 2s; the
 * run's terminal flip changes the query key, so the tab reads once more and
 * stops (`runEventsQueryKey`).
 *
 * `role="log"` so a screen reader announces new events politely, and an
 * `sr-only` heading so a reader moving by heading can reach the section — the
 * reason the Charts tab carries one too.
 */
export default function RunLogs() {
  const { runId } = useParams<{ runId: string }>();
  const { terminal } = useRunTerminal(runId);
  const events = useQuery({
    queryKey: runEventsQueryKey(runId ?? '', terminal),
    queryFn: () => fetchRunEvents(runId!),
    enabled: runId !== undefined,
    refetchInterval: terminal ? false : RUN_EVENTS_POLL_MS,
    placeholderData: keepPreviousData,
  });

  return (
    <section aria-labelledby="run-logs-heading" className="flex flex-col gap-3">
      <h2 id="run-logs-heading" className="sr-only">Logs</h2>
      {events.isPending ? (
        <LoadingState label="Loading this run’s events…" />
      ) : events.isError ? (
        <ErrorState title="This run’s events could not be loaded" detail={explain(events.error)} />
      ) : !events.data.recorded ? (
        <EmptyState
          title="This run has no events"
          body="Only a run the on-prem runner executes records its lifecycle events; this one was uploaded or streamed by a client."
        />
      ) : events.data.events.length === 0 ? (
        <EmptyState title="No events were recorded for this run — it ran before PerfPortal began recording them." />
      ) : (
        <LogPanel events={events.data.events} />
      )}
    </section>
  );
}

function explain(error: unknown): string {
  if (error instanceof ProblemError) return `${error.detail} ${error.remediation}`;
  return error instanceof Error ? error.message : 'The request failed.';
}

function LogPanel({ events }: { readonly events: readonly RunEvent[] }) {
  return (
    <div
      role="log"
      aria-label="Run events"
      className="overflow-x-auto rounded-xl bg-log-bg p-4 font-mono text-[0.8125rem] leading-relaxed text-log-text"
    >
      {events.map((event, index) => (
        <LogLine key={`${event.at}-${index}`} event={event} />
      ))}
    </div>
  );
}

/**
 * One event. A PHASE row is Gatling Enterprise's separator — the dashes fill
 * the line, and are `aria-hidden` so a screen reader hears the phase once
 * rather than a hundred and fifty hyphens.
 */
function LogLine({ event }: { readonly event: RunEvent }) {
  const time = <span className="text-log-time">[{formatLogTime(Date.parse(event.at))}]</span>;
  if (event.phase !== null) {
    return (
      <div data-testid="run-log-line" data-phase={event.phase} className="flex whitespace-nowrap">
        {time}
        <span className="whitespace-pre text-log-muted">{` ---| ${event.phase} |`}</span>
        <span aria-hidden className="min-w-0 flex-1 overflow-hidden text-log-muted">{'-'.repeat(160)}</span>
      </div>
    );
  }
  return (
    <div data-testid="run-log-line" className="whitespace-pre-wrap break-words">
      {time}{' '}
      <span className="text-log-muted">[{event.source}]</span>{' '}
      {highlightLogMessage(event.message ?? '').map((segment, index) =>
        segment.value ? (
          <span key={index} data-kind="value" className="text-log-value">{segment.text}</span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </div>
  );
}
