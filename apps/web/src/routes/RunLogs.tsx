import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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
 * LIVE: while the run is not terminal the events are re-read every 2s. The
 * query key is stable for the run's whole life, so the events already read
 * outlive every later read: when the run finishes, an effect watching the
 * previous `terminal` in a ref (initialised to the CURRENT value, so mounting
 * on a finished run reads once, not twice) calls `refetch()` exactly once —
 * the events the runner wrote while it was finishing — and the polling stops.
 *
 * FREEZE, DO NOT BLANK. A failed read never takes the log off the screen: with
 * events already read, the panel stays and a quiet status line says the last
 * refresh failed. Only a first read that fails, with nothing to show, is an
 * alert. react-query keeps `data` beside `status: 'error'` after a failed
 * refetch, which is why the data — not `isError` — decides what is drawn.
 *
 * `role="log"` so a screen reader announces new events politely, and an
 * `sr-only` heading so a reader moving by heading can reach the section — the
 * reason the Charts tab carries one too.
 */
export default function RunLogs() {
  const { runId } = useParams<{ runId: string }>();
  const { terminal } = useRunTerminal(runId);
  const events = useQuery({
    queryKey: runEventsQueryKey(runId ?? ''),
    queryFn: () => fetchRunEvents(runId!),
    enabled: runId !== undefined,
    refetchInterval: terminal ? false : RUN_EVENTS_POLL_MS,
  });

  const wasTerminal = useRef(terminal);
  const { refetch } = events;
  useEffect(() => {
    if (terminal && !wasTerminal.current) void refetch();
    wasTerminal.current = terminal;
  }, [terminal, refetch]);

  const data = events.data;

  return (
    <section aria-labelledby="run-logs-heading" className="flex flex-col">
      <h2 id="run-logs-heading" className="sr-only">Logs</h2>
      {data === undefined ? (
        events.isError ? (
          <ErrorState title="This run’s events could not be loaded" detail={explain(events.error)} />
        ) : (
          <LoadingState label="Loading this run’s events…" />
        )
      ) : (
        <>
          {!data.recorded ? (
            <EmptyState
              title="This run has no events"
              body="PerfPortal holds no on-prem runner job for this run — it was uploaded or streamed by a client, or its runner job has since been removed by retention."
            />
          ) : data.events.length === 0 ? (
            <EmptyState title="No events were recorded for this run — it ran before PerfPortal began recording them." />
          ) : (
            <LogPanel events={data.events} />
          )}
          {/* MOUNTED WITH THE LOG, EMPTY UNTIL A REFRESH FAILS. A live region
              is announced when it CHANGES; one inserted already holding its
              message is usually not announced at all (ProjectRail records the
              same lesson). There is one per page, so it is always here while
              there is a log, and the sentence arrives in it. `empty:mt-0`
              keeps a silent region from costing the layout a gap. */}
          <p role="status" className="mt-3 text-[0.8125rem] text-muted empty:mt-0">
            {events.isError ? 'Could not refresh this run’s events; showing the last ones read.' : null}
          </p>
        </>
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
      // Focusable so a keyboard user can scroll it: a phase row is wider than
      // a phone's viewport and the panel scrolls sideways.
      tabIndex={0}
      // The border is for the DARK theme: this panel's ground is dark in both
      // themes and equals the dark page canvas exactly (#0d1220), so without an
      // edge the lines float on the page with nothing saying where the panel is.
      className="overflow-x-auto rounded-xl border border-default bg-log-bg p-4 font-mono text-[0.8125rem] leading-relaxed text-log-text"
    >
      {events.map((event, index) => (
        <LogLine key={`${event.at}-${index}`} event={event} />
      ))}
    </div>
  );
}

/**
 * One event. A PHASE row is Gatling Enterprise's separator — the dashes fill
 * the line, and they and the `---|` / `|` around the name are `aria-hidden`, so
 * a screen reader hears the phase once rather than a hundred and fifty hyphens.
 */
function LogLine({ event }: { readonly event: RunEvent }) {
  const time = <span className="text-log-time">[{formatLogTime(Date.parse(event.at))}]</span>;
  if (event.phase !== null) {
    return (
      <div data-testid="run-log-line" data-phase={event.phase} className="flex whitespace-nowrap">
        {time}
        {/* The ornaments are `aria-hidden` for the same reason the dashes
            are: a screen reader hears the phase name, not punctuation. The
            spaces stay OUTSIDE them so the visible text is unchanged. */}
        <span className="whitespace-pre text-log-muted">
          {' '}<span aria-hidden>---|</span>{' '}{event.phase}{' '}<span aria-hidden>|</span>
        </span>
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
