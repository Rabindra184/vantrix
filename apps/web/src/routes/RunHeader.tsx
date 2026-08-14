import type { RunResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { formatDuration, formatStarted } from './format';
import { STATUS, VERDICT } from './marks';

/**
 * What this run IS, before anything about how it went.
 *
 * Everything here comes from payloads the page already holds. There is no
 * environment and no branch: `IngestMetadataSchema` accepts both and nothing
 * stores them, so the platform does not know them — see the spec's §2. Adding
 * a blank chip would claim we asked and got nothing back.
 */
export default function RunHeader({
  run,
  peakUsers,
}: {
  readonly run: RunResponse;
  readonly peakUsers: number | null;
}) {
  // The tool's own start when the parser has produced it, ingest time
  // otherwise — the same rule, spelled the same way, as the run list's
  // `startedAt` (RunList.tsx's RunRow). The two screens must not disagree
  // about when a run started.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;

  return (
    <header className="flex flex-col gap-2">
      {/* The simulation is the run's identity to the person who ran it, so
          it is the heading. Rendered fully-qualified, exactly as the tool
          reported it (`example.ParitySimulation`), rather than trimmed to
          the class name: two simulations in different packages can share a
          class name, and truncating identity to save a few characters is
          how two different runs come to look like the same one. Falls back
          to the short id for a run whose header carried no simulation. */}
      <h1 className="text-2xl font-semibold">{run.simulation ?? `Run ${run.id.slice(0, 8)}`}</h1>
      {run.description != null && run.description !== '' && (
        <p className="text-muted">{run.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span>{run.toolVersion ? `${run.tool} ${run.toolVersion}` : run.tool}</span>
        <span>
          {/* <time dateTime> carries the machine-readable instant beside the
              human one; the text itself is localised. Same treatment as the
              run list. */}
          <time dateTime={startedAt}>{formatStarted(startedAt)}</time>
          {isIngestTime && <span className="ml-1">(ingest time — the tool reported no start)</span>}
        </span>
        <span data-testid="run-duration">{formatDuration(run.durationMs)}</span>
        {peakUsers !== null && <span>{peakUsers.toLocaleString()} peak users</span>}
        {/* `data-testid` goes on `Badge` itself, not on a wrapping `<span>`:
            a bare span has ARIA's "generic" role, whose accessible name is
            prohibited outright, so `getByTestId('run-status')` would resolve
            to an element Chromium can never name — see Badge.tsx's own
            docstring, which is where this actually got caught. */}
        <Badge mark={STATUS[run.status]} data-testid="run-status" />
        <Badge mark={VERDICT[run.verdict ?? 'none']} data-testid="run-verdict" />
      </div>
    </header>
  );
}
