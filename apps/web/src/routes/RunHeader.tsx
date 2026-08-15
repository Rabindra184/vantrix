import type { ReactNode } from 'react';
import type { RunResponse } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { ChevronRightIcon } from '../components/icons';
import { formatDuration, formatStarted } from './format';
import { STATUS, VERDICT, type Mark } from './marks';
import { projectPath } from './paths';

/**
 * What this run IS, before anything about how it went.
 *
 * Everything here comes from payloads the page already holds. Environment,
 * branch and commit are ingest metadata, frozen at accept time (Task 2) —
 * each renders only when the run actually carries it, so a run predating that
 * migration, or one whose caller sent none of the three, looks exactly as it
 * did before this existed rather than growing three dashes.
 *
 * NOT ONE CHARACTER OF VISIBLE TEXT MAY BE ADDED INSIDE A CHIP, however much
 * a "Branch:" or "Commit:" label would help a sighted reader. The chips are
 * pinned by their own text content in three separate ways and each would break
 * differently:
 *
 *   `RunHeader.test.tsx` reads `getByTestId('run-commit')`'s text and asserts
 *   `commitSha.startsWith(visible)` — a label inside makes the visible string
 *   `Commit9b71f35`, which starts nothing.
 *
 *   `run-detail.spec.ts` asserts `getByText('8 peak users')` is visible, which
 *   requires that string to be one element's whole text.
 *
 *   The same spec reads the `<h1>` with `toHaveText`, an EXACT match, so the
 *   heading may hold the simulation and nothing else — no badge, no id, no
 *   copy button.
 *
 * The naming those labels would have provided is already there and is the
 * point of every `role="group"` + `aria-label` below: a screen reader hears
 * "Branch: release/24.8", the sighted reader sees the value in a labelled
 * position. Styling — a tinted pill, an icon, a separator — is unconstrained,
 * because none of it is text.
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
    <header className="flex flex-col gap-3">
      {/* The project above the simulation, not beside it: it is the run's
          address, and the simulation is its identity. A link because the
          reader who wants "this project's other runs" is one click from
          them.

          Drawn as a breadcrumb — project › this run's short id — so the link
          reads as a position in a hierarchy rather than as a stray link above
          a heading. The trailing segment is plain text with `aria-current`,
          never a link to the page you are already on, and it carries the id
          because the `<h1>` beneath carries the SIMULATION: two runs of the
          same simulation are otherwise indistinguishable at a glance, and the
          id is the only thing on this page that tells them apart. */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-muted">
        <Link
          to={projectPath(run.project.slug)}
          className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
        >
          {run.project.name}
        </Link>
        <ChevronRightIcon className="h-3.5 w-3.5 opacity-50" />
        <code aria-current="page" className="text-[12px]">
          {run.id.slice(0, 8)}
        </code>
      </nav>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* The simulation is the run's identity to the person who ran it, so
              it is the heading. Rendered fully-qualified, exactly as the tool
              reported it (`example.ParitySimulation`), rather than trimmed to
              the class name: two simulations in different packages can share a
              class name, and truncating identity to save a few characters is
              how two different runs come to look like the same one. Falls back
              to the short id for a run whose header carried no simulation.

              `break-all` rather than `truncate`: a fully-qualified class name
              is long by design, and hiding the END of it — which is the part
              that distinguishes two simulations in the same package — is the
              one truncation this heading cannot afford. */}
          <h1 className="text-xl font-semibold tracking-tight break-all sm:text-2xl">
            {run.simulation ?? `Run ${run.id.slice(0, 8)}`}
          </h1>
          {run.description != null && run.description !== '' && (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">{run.description}</p>
          )}
        </div>

        {/* The verdict is what the reader came for, so on a wide screen it
            sits at the top right where the eye lands after the heading, and
            on a narrow one it falls back into the flow above the metadata.
            `shrink-0` so a long simulation name never squeezes it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <NamedBadge mark={STATUS[run.status]} testId="run-status" />
          <NamedBadge mark={VERDICT[run.verdict ?? 'none']} testId="run-verdict" />
        </div>
      </div>

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
          spans does nothing at all without `role="group"` alongside it.

          The row is now a bordered strip rather than free-floating text: six
          unrelated values separated only by whitespace read as a sentence
          that has lost its punctuation, and the divider between each is what
          says they are six things. `divide-x` draws it without adding an
          element, and `gap-y` keeps the rows apart when it wraps on a phone —
          where the vertical dividers disappear, which is correct, because
          stacked chips need no separator. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-default bg-surface px-3 py-2 text-[12px] text-muted shadow-panel sm:gap-x-0 sm:divide-x sm:divide-default">
        <Chip label={`Tool: ${run.tool}${run.toolVersion ? ` ${run.toolVersion}` : ''}`}>
          {run.toolVersion ? `${run.tool} ${run.toolVersion}` : run.tool}
        </Chip>
        {/* Provenance from ingest metadata. Each renders only when the run
            carries it: a run submitted without them looks exactly as it did
            before this existed, rather than growing three dashes. The
            spec's §2 promise, now that the platform actually stores them.

            role="group" + aria-label for the same reason every other chip
            here has them: a bare <span>'s implicit role is "generic", which
            is Name-from-PROHIBITED, so aria-label alone does nothing. */}
        {run.environment != null && run.environment !== '' && (
          <Chip label={`Environment: ${run.environment}`} testId="run-environment">
            {run.environment}
          </Chip>
        )}
        {run.branch != null && run.branch !== '' && (
          <Chip label={`Branch: ${run.branch}`} testId="run-branch">
            {run.branch}
          </Chip>
        )}
        {run.commitSha != null && run.commitSha !== '' && (
          // Seven characters visible, the WHOLE sha in the accessible name —
          // the same short-versus-full treatment the run list gives a run id.
          // NOT a link: the platform does not know the repository host, and a
          // chip that looks like a link but is not is worse than plain text.
          <Chip label={`Commit: ${run.commitSha}`} testId="run-commit">
            <code>{run.commitSha.slice(0, 7)}</code>
          </Chip>
        )}
        <Chip
          label={`${isIngestTime ? 'Received' : 'Started'}: ${formatStarted(startedAt)}${
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
          <time dateTime={startedAt} className="tabular-nums">
            {formatStarted(startedAt)}
          </time>
          {isIngestTime && <span className="ml-1">(ingest time — the tool reported no start)</span>}
        </Chip>
        <Chip label={`Duration: ${formatDuration(run.durationMs)}`} testId="run-duration">
          <span className="tabular-nums">{formatDuration(run.durationMs)}</span>
        </Chip>
        {peakUsers !== null && (
          // The aria-label restates the visible text exactly, rather than
          // prefixing a "Peak users:" name onto it — the same shape
          // `NamedBadge` below uses, measured there not to double-announce
          // (see its own docstring) precisely because the two strings match.
          //
          // ONE ELEMENT, ONE STRING. `run-detail.spec.ts` asserts
          // `getByText('8 peak users')` is visible, which only resolves while
          // the count and the words share a single text container — splitting
          // the number into its own styled span would break it.
          <Chip label={`${peakUsers.toLocaleString()} peak users`}>
            {peakUsers.toLocaleString()} peak users
          </Chip>
        )}
      </div>
    </header>
  );
}

/**
 * One metadata chip: a value that is named for assistive tech and unlabelled
 * for the eye.
 *
 * `role="group"` is not decoration — see the module docstring and
 * `NamedBadge` below. A bare `<span>` computes to role "generic", which is
 * Name-from-PROHIBITED, so `aria-label` on it is silently ignored.
 *
 * `children` is passed straight through with no wrapper element, so the
 * chip's own text content stays exactly what the caller wrote — which is what
 * the three text-content assertions in the module docstring depend on.
 */
function Chip({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      data-testid={testId}
      className="whitespace-nowrap sm:px-3 sm:first:pl-0 sm:last:pr-0"
    >
      {children}
    </span>
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
