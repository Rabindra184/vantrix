import type { RunResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { formatDuration, formatStarted } from './format';
import { STATUS, VERDICT, type Mark } from './marks';

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

      {/* NAME/VALUE PAIRS, IN A CHIP ROW RATHER THAN A `<dl>`. The header this
          replaced was a `<dl>` carrying this comment: "A description list,
          not a grid of divs: these are name/value pairs and `<dt>`/`<dd>` is
          what tells a screen reader that 'Duration' names '61s' rather than
          merely preceding it." That argument was never answered, only
          deleted along with the markup it was about — a flat row of bare
          `<span>`s named nothing, so "63s" was announced between a
          timestamp and a peak-user count with no indication which
          measurement it was. The chip-row LOOK is a legitimate call (spec §4
          specifies sources, not markup) and is kept; what is restored is the
          naming, the same way `NamedBadge` below already has to: a bare
          `<span>`'s implicit role is "generic", which is Name-from-PROHIBITED
          (see `NamedBadge`'s own docstring), so `aria-label` on one of these
          spans does nothing at all without `role="group"` alongside it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span role="group" aria-label={`Tool: ${run.tool}${run.toolVersion ? ` ${run.toolVersion}` : ''}`}>
          {run.toolVersion ? `${run.tool} ${run.toolVersion}` : run.tool}
        </span>
        <span
          role="group"
          aria-label={`${isIngestTime ? 'Received' : 'Started'}: ${formatStarted(startedAt)}${
            isIngestTime ? ' (ingest time — the tool reported no start)' : ''
          }`}
        >
          {/* <time dateTime> carries the machine-readable instant beside the
              human one; the text itself is localised. Same treatment as the
              run list. The wrapping `role="group"` + `aria-label` is what
              says this timestamp is a START (or, when the tool reported
              none, a RECEIVED) time — the `Started`/`Received` distinction
              the old `<dl>`'s `Field` label carried, restated here since a
              bare `<time>` names nothing on its own either. */}
          <time dateTime={startedAt}>{formatStarted(startedAt)}</time>
          {isIngestTime && <span className="ml-1">(ingest time — the tool reported no start)</span>}
        </span>
        <span
          role="group"
          aria-label={`Duration: ${formatDuration(run.durationMs)}`}
          data-testid="run-duration"
        >
          {formatDuration(run.durationMs)}
        </span>
        {peakUsers !== null && (
          // The aria-label restates the visible text exactly, rather than
          // prefixing a "Peak users:" name onto it — the same shape
          // `NamedBadge` below uses, measured there not to double-announce
          // (see its own docstring) precisely because the two strings match.
          <span role="group" aria-label={`${peakUsers.toLocaleString()} peak users`}>
            {peakUsers.toLocaleString()} peak users
          </span>
        )}
        <NamedBadge mark={STATUS[run.status]} testId="run-status" />
        <NamedBadge mark={VERDICT[run.verdict ?? 'none']} testId="run-verdict" />
      </div>
    </header>
  );
}

/**
 * `Badge`, given a name and a testid where it sits with no ancestor that
 * would compute one from its content on its own.
 *
 * `Badge` itself is untouched (`apps/web/src/components/Badge.tsx`) — this
 * is scoped to `RunHeader` on purpose, not fixed on the shared component,
 * because the shared component was never broken: `RunList.tsx`'s badges
 * already get a correct accessible name for free, since each one sits
 * inside a `<td>` (implicit role "cell"), and a cell computes its OWN name
 * from its descendants' content. `Badge`'s root is a bare `<span>`, whose
 * implicit ARIA role is "generic" — and "generic" is Name-from-PROHIBITED,
 * so a `<span data-testid="run-status">` wrapping a Badge with no role of
 * its own reports `""` to `toHaveAccessibleName`, regardless of the visible
 * label text sitting right inside it. `RunHeader` is the one place a badge
 * has no `<td>` (or other name-from-content) ancestor, so it is the one
 * place that needs its own fix.
 *
 * `role="group"`, not `role="img"`. `img` was tried first and reverted: it
 * makes an element's children PRESENTATIONAL, so the visible label stops
 * being individually exposed and the whole node reads to assistive tech as
 * a picture — wrong for a text pill, and `getByRole('img', { name: … })`
 * would newly match every badge on the page, including `RunList.tsx`'s,
 * which this component has no business changing the semantics of. `group`
 * is "Name from: author" too (so `aria-label` still supplies the name) but
 * does not imply a graphic and does not make children presentational.
 *
 * MEASURED, not assumed, that this does not double-announce: a `role=group`
 * whose `aria-label` restates its own visible content risks a screen reader
 * reading the name once for the group and again while entering its
 * children. Checked with a real `ariaSnapshot()` against the built app
 * (Chromium's actual accessibility tree, not jsdom) — `- group "complete"`,
 * with NO nested child text node, the same shape `RunList.tsx`'s
 * `- cell "complete"` already has. Chromium prunes the plain-text `<span>`
 * that contributes to an ancestor's computed name rather than exposing it a
 * second time, so nothing here duplicates what a screen reader announces.
 */
function NamedBadge({ mark, testId }: { readonly mark: Mark; readonly testId: string }) {
  return (
    <span role="group" aria-label={mark.label} data-testid={testId}>
      <Badge mark={mark} />
    </span>
  );
}
