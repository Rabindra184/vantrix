import type { ReactNode } from 'react';
import type { RunIdentity, RunResponse } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { ChevronRightIcon } from '../components/icons';
import { formatDuration, formatInstant } from './format';
import { STATUS, VERDICT, type Mark } from './marks';
import { projectPath, projectTestPath } from './paths';

/**
 * The bordered box the metadata sits in, at each of the two widths that draw
 * one.
 *
 * ═══ NO `sm:` HERE, AND THAT IS THE WHOLE REASON THESE ARE TWO CONSTANTS ═══
 *
 * The strip used to be `grid grid-cols-2 … sm:flex … sm:divide-x`: a
 * two-column grid on a phone, a divided row from 640px up. `useIsCompact` is
 * `max-width: 767px`. So the class boundary and the JS boundary DISAGREED over
 * a 127px band — between 640 and 767 a viewport is compact to the hook and
 * wide to the stylesheet — and a component that reads both would have taken
 * the phone's structure with the desktop's spacing there.
 *
 * Splitting them removes the question rather than answering it. Neither
 * carries a responsive variant, so neither can disagree with anything: the
 * ONE caller picks by the same 767 the hook uses, and the dead
 * `grid grid-cols-2` that `sm:flex` used to override goes with it. (That the
 * caller picks correctly is a property of `RunHeader`, not of these strings —
 * `RunHeader.test.tsx` is where it is asserted.)
 *
 * **When a JS breakpoint and a CSS breakpoint describe the same decision, they
 * have to be the same number — or one of them has to stop existing.**
 *
 * `Chip`'s own cell padding moved from `sm:` to `md:` for exactly this reason:
 * 768 is where the divided row it belongs to starts.
 */
const BOX =
  'rounded-lg border border-default bg-surface px-4 py-3 font-mono text-[12px] text-muted shadow-panel';
const STRIP = `flex flex-wrap items-start gap-y-3 divide-x divide-default ${BOX}`;
const COMPACT_STRIP = `flex flex-col gap-3 ${BOX}`;

/**
 * What this run IS, before anything about how it went.
 *
 * Everything here comes from payloads the page already holds. Environment,
 * branch and commit are ingest metadata, frozen at accept time (Task 2) —
 * each renders only when the run actually carries it, so a run predating that
 * migration, or one whose caller sent none of the three, looks exactly as it
 * did before this existed rather than growing three dashes.
 *
 * NOT ONE CHARACTER OF VISIBLE TEXT MAY BE ADDED INSIDE A CHIP'S VALUE NODE,
 * however much a "Branch:" or "Commit:" label would help a sighted reader.
 * The values are pinned by their own text content in three separate ways and
 * each would break differently:
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
 * INSIDE THE VALUE NODE is the operative phrase, and it is what the
 * control-room redesign changed. This row was a `<dl>` whose `<dt>`s named
 * every value; the design pass replaced it with bare values named only by
 * `aria-label`, and the paragraph that used to sit here conceded the loss —
 * "the sighted reader sees the value in a labelled position" was doing a lot
 * of work for a row where position was the ONLY label. A reader had to infer
 * that `63s` was a duration and `a3f9c21` a commit.
 *
 * `Chip` now renders a visible uppercase overline ABOVE the value, and the
 * `role="group"`, the `aria-label` and the `data-testid` all stay on the
 * value node itself. So every pin above still measures exactly what it
 * measured — the value's text, and the value's own authored name — while the
 * cell gains the label it lost. Styling of either part is unconstrained;
 * only the value's TEXT is.
 */
export default function RunHeader({
  identity,
  status,
  verdict,
  peakUsers,
  compact,
}: {
  /**
   * PARTIAL, and the partiality is the point. A terminal run supplies every
   * field; a non-terminal one supplies what it knows at open time; a run read
   * from an API pod that predates the widened 202 supplies only its id. Each
   * part below renders only when its field is present — the same rule the
   * environment/branch/commit chips already followed, extended to the
   * breadcrumb and the tool chip.
   */
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  /**
   * `undefined` means NOT EVALUATED YET and omits the badge; `null` means
   * evaluated with no verdict and renders `VERDICT['none']` as before.
   *
   * Collapsing the two would put "no verdict" on a running run, which reads as
   * evaluated-and-nothing-found — a claim about a run nobody has finished
   * measuring. Same distinction `RunTabs`' `errorCount: number | null` draws.
   */
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly peakUsers: number | null;
  /**
   * `useIsCompact()`, PASSED IN — the shape `DesktopOnly` already uses and for
   * its stated reason: "so a caller can test both paths". `RunShell` already
   * calls that hook for the time brush, so this is one more CONSUMER of the
   * app's single JS breakpoint rather than a second breakpoint. What it
   * decides, and why a Tailwind class could not, is at the metadata strip
   * below.
   *
   * REQUIRED, with no default. `= false` would keep every existing caller
   * compiling and leave the one caller that knows the answer silently not
   * giving it — the shape CLAUDE.md records costing `listEnabled` a whole
   * class of SLA gate. `DesktopOnly` requires it for the same reason.
   */
  readonly compact: boolean;
}) {
  // See the Duration chip below for why this is `activityMs` first.
  const runDurationMs = identity.activityMs ?? identity.durationMs;

  // The tool's own start when the parser has produced it, ingest time
  // otherwise — the same rule, spelled the same way, as the run list's
  // `startedAt` (RunList.tsx's RunRow). The two screens must not disagree
  // about when a run started. Both are optional on a partial identity, so a
  // run that has told us neither yet renders no chip at all rather than a
  // dash — see the Started/Received chip below.
  const startedAt = identity.toolStartedAt ?? identity.startedAt ?? null;
  const isIngestTime = identity.toolStartedAt == null;

  /* ═══ ONE SET OF CHIPS, PLACED BY EXACTLY ONE OF TWO STRIPS — review M02 ═══
   *
   * M02's remaining half: "keep run name, environment, outcome, and primary
   * metrics BEFORE secondary metadata". At 375px this strip was a 191px
   * `grid-cols-2` block between the `<h1>` and the decision band, so the run's
   * own totals began at y=876 on an 812px screen — the last stretch of the
   * finding, after M18 stopped mounting the brush here and C01 and M02's first
   * half shortened the band.
   *
   * Version, branch, commit, started, duration and peak users are that
   * secondary metadata. ENVIRONMENT IS NOT: the finding names it beside the
   * run name and the outcome, and it is the one chip that changes what every
   * number below it MEANS — a p95 from staging and a p95 from production are
   * not the same measurement.
   *
   * EACH CHIP IS BUILT ONCE AND PLACED BY EXACTLY ONE STRIP. The obvious
   * alternative — draw both arrangements and hide one with `max-sm:hidden` —
   * puts two copies of every value in the accessibility tree, and a
   * screen-reader user hears the commit twice with nothing to say which is
   * which. Every `textContent` assertion over this header would keep passing
   * throughout, the way CLAUDE.md records for `truncate` and for M02's own
   * first half.
   *
   * The desktop strip keeps the order it has always had — version,
   * environment, then the rest — so nothing about this is visible above
   * 768px. */
  const versionChip = (
    <>
        {/* Omitted entirely when the identity carries no tool — same
            rolling-deploy render as the breadcrumb above. */}
        {identity.tool != null && (
          <Chip
            name="Version"
            label={`Tool: ${identity.tool}${identity.toolVersion ? ` ${identity.toolVersion}` : ''}`}
          >
            {identity.toolVersion ? `${identity.tool} ${identity.toolVersion}` : identity.tool}
          </Chip>
        )}
    </>
  );
  const environmentChip = (
    <>
        {/* Provenance from ingest metadata. Each renders only when the run
            carries it: a run submitted without them looks exactly as it did
            before this existed, rather than growing three dashes. The
            spec's §2 promise, now that the platform actually stores them.

            role="group" + aria-label for the same reason every other chip
            here has them: a bare <span>'s implicit role is "generic", which
            is Name-from-PROHIBITED, so aria-label alone does nothing. */}
        {identity.environment != null && identity.environment !== '' && (
          <Chip name="Environment" label={`Environment: ${identity.environment}`} testId="run-environment">
            {identity.environment}
          </Chip>
        )}
    </>
  );
  const restChips = (
    <>
        {identity.branch != null && identity.branch !== '' && (
          <Chip name="Branch" label={`Branch: ${identity.branch}`} testId="run-branch">
            {identity.branch}
          </Chip>
        )}
        {identity.commitSha != null && identity.commitSha !== '' && (
          // Seven characters visible, the WHOLE sha in the accessible name —
          // the same short-versus-full treatment the run list gives a run id.
          // NOT a link: the platform does not know the repository host, and a
          // chip that looks like a link but is not is worse than plain text.
          <Chip name="Commit" label={`Commit: ${identity.commitSha}`} testId="run-commit">
            <code>{identity.commitSha.slice(0, 7)}</code>
          </Chip>
        )}
        {/* Omitted entirely when neither the tool's own start nor an ingest
            time is known yet — a run read from a pod old enough to send only
            an id has neither. */}
        {startedAt !== null && (
          <Chip
            name={isIngestTime ? 'Received' : 'Started'}
            label={`${isIngestTime ? 'Received' : 'Started'}: ${formatInstant(startedAt)}${
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
              {formatInstant(startedAt)}
            </time>
            {isIngestTime && <span className="ml-1">(ingest time — the tool reported no start)</span>}
          </Chip>
        )}
        {/* `activityMs`, NOT `durationMs`, AND THE FALLBACK IS THE OLD VALUE.
            `durationMs` is the span the SERIES OFFSETS live in — header start
            to last event — which the time axis needs and a reader does not
            mean by "Duration". Showing it here made this page contradict
            itself: the throughput tile divides by the ACTIVITY span, so
            `throughput x duration` did not equal the request count on the
            same screen (14.32 req/s over a stated 63s is 907, printed beside
            a stated 895). Gatling's own report anchors at the first event too
            and reads "1m 2s" where `durationMs` rounds to 63s.

            `?? durationMs` for runs ingested before migration 20260822090000,
            which have no `activityMs` and cannot be backfilled — those keep
            rendering exactly what they rendered before rather than a dash. */}
        <Chip name="Duration" label={`Duration: ${formatDuration(runDurationMs)}`} testId="run-duration">
          <span className="tabular-nums">{formatDuration(runDurationMs)}</span>
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
          <Chip name="Peak users" label={`${peakUsers.toLocaleString()} peak users`}>
            {peakUsers.toLocaleString()} peak users
          </Chip>
        )}
    </>
  );

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
          id is the only thing on this page that tells them apart.

          OMITTED ENTIRELY when the identity carries no project — the
          rolling-deploy render, where an old pod's 202 body sent only
          `{ id, status, statusUrl }`. A breadcrumb to nowhere is worse than
          no breadcrumb, and the next poll that reaches a new pod fills it
          back in. */}
      {identity.project != null && (
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted"
        >
          <Link
            to={projectPath(identity.project.slug)}
            className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
          >
            {identity.project.name}
          </Link>
          {/* THE TEST IS A RUNG, NOT A DECORATION — it is the level the trend
              this run belongs to is computed at (`TRENDS_SQL` cohorts on
              `test_id`), so a reader who wants "the other runs of this same
              thing" is one click from them here and nowhere else on the page.

              OMITTED, not dashed, when the run belongs to no test: one still
              pending, one that failed before the worker could read its
              simulation class, one ingested before migration
              `20260822220000_test_entity`. Those runs are reachable only from
              the project's run list, and a breadcrumb rung pointing at a test
              that does not exist is worse than a two-rung breadcrumb. `!= null`
              covers BOTH absences at once — `null` (this run has no test) and
              `undefined` (an API pod that predates the field), which look the
              same to a reader and must render the same. */}
          {identity.test != null && (
            <>
              <ChevronRightIcon className="h-3.5 w-3.5 opacity-50" />
              <Link
                to={projectTestPath(identity.project.slug, identity.test.slug)}
                data-testid="run-test"
                className="transition-ui min-w-0 truncate font-medium text-accent hover:underline hover:underline-offset-2"
              >
                {identity.test.name}
              </Link>
            </>
          )}
          <ChevronRightIcon className="h-3.5 w-3.5 opacity-50" />
          <code aria-current="page" className="text-[12px]">
            {identity.id.slice(0, 8)}
          </code>
        </nav>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* The simulation is the run's identity to the person who ran it, so
              it is the heading. Rendered fully-qualified, exactly as the tool
              reported it (`example.ParitySimulation`), rather than trimmed to
              the class name: two simulations in different packages can share a
              class name, and truncating identity to save a few characters is
              how two different runs come to look like the same one. Falls back
              to the short id for a run whose header carried no simulation —
              including a run whose identity is nothing but that id.

              `break-all` rather than `truncate`: a fully-qualified class name
              is long by design, and hiding the END of it — which is the part
              that distinguishes two simulations in the same package — is the
              one truncation this heading cannot afford. */}
          <h1 className="text-xl font-semibold tracking-tight break-all sm:text-2xl">
            {identity.simulation ?? `Run ${identity.id.slice(0, 8)}`}
          </h1>
          {identity.description != null && identity.description !== '' && (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
              {identity.description}
            </p>
          )}
        </div>

        {/* The verdict is what the reader came for, so on a wide screen it
            sits at the top right where the eye lands after the heading, and
            on a narrow one it falls back into the flow above the metadata.
            `shrink-0` so a long simulation name never squeezes it.

            The verdict badge is OMITTED — not rendered as `VERDICT['none']`
            — while `verdict` is `undefined`: that is a run nobody has
            finished measuring yet, and "no verdict" reads as
            evaluated-and-nothing-found, a claim about a run that has not
            been judged at all. `null` still renders `VERDICT['none']`, as
            before — that is a real, evaluated absence. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <NamedBadge mark={STATUS[status]} testId="run-status" />
          {verdict !== undefined && <NamedBadge mark={VERDICT[verdict ?? 'none']} testId="run-verdict" />}
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
      {/* `font-mono` on the whole strip: every chip is a VALUE — tool
          version, branch, sha, timestamp, duration, user count — and the
          redesign's rule is that data wears the mono face. One class here
          rather than six, and the commit's own <code> stops being the odd
          one out. Classes only; the chip TEXT is pinned three ways (module
          docstring) and gains nothing. */}
      {compact ? (
        /* ═══ A PROP, NOT A CLASS, AND THE DISTINCTION IS THE POINT ═══
         *
         * M02's first half WAS a class (`max-sm:hidden` on the band's prose),
         * and `RunDecisionBand` argues for that at length: this app has one JS
         * breakpoint, and it exists because a class can only HIDE what a phone
         * has already paid to mount. Nothing here is expensive to mount —
         * seven `<span>`s — so by that rule this should have been a class too.
         *
         * A class cannot express it. The metadata must not be HIDDEN on a
         * phone, it must be ONE TAP AWAY, and `<details>` is how this repo
         * already does that (the run list's filters, the percentile method,
         * the glossary). `open` is a DOM ATTRIBUTE, and no media query writes
         * one. **A class can change how a thing LOOKS; it cannot change a
         * control's STATE.**
         *
         * MEASURED, because the obvious objection is that CSS can force the
         * content visible instead — `@media (min-width: 768px) { summary {
         * display: none } details::details-content { content-visibility:
         * visible } }`. On Playwright 1.62.1's browsers that paints in
         * chromium, firefox AND webkit, so this is not the engine-support
         * problem an earlier draft of this comment claimed. What it costs is
         * that the e2e suite could no longer see it: Playwright's WebKit path
         * SKIPS `Element.checkVisibility()` and substitutes "has a closed
         * `<details>` ancestor", reading the attribute and never the CSS — so
         * a forced-open chip reports `isVisible: false` and vanishes from
         * `getByRole` and `ariaSnapshot` on one of the three engines
         * `test:e2e:cross` runs, while WebKit itself paints it and answers
         * `checkVisibility(): true`.
         *
         * THAT IS A HARNESS FACT, NOT AN ACCESSIBILITY ONE, and this file
         * writes it down as such deliberately: CLAUDE.md already records
         * costing the redesign its uppercase headings by promoting a measured
         * Playwright behaviour into a design prohibition. The reason above —
         * a media query cannot write an attribute — stands on its own.
         *
         * So `compact` is a prop, off the `useIsCompact()` call `RunShell`
         * already makes for the brush: a second CONSUMER of the app's one
         * breakpoint, not a second breakpoint. */
        <div className={COMPACT_STRIP}>
          {environmentChip}
          <details className="group" data-testid="run-metadata">
            {/* A `<summary>` contributes an ARIA group and NOT a heading — the
                mechanism `RunGlossary` documents. A heading here would put a
                rung in the run page's outline between its one `<h1>` and the
                `<h2>`s the tab specs assert as exact lists.

                "Run details", NOT "Branch, commit and timing". Naming the
                contents reads better and is a LIE on some runs: the tool,
                branch and commit chips are all conditional, so a summary
                promising them describes a run that carried them. That is the
                stale-cross-reference shape this review has already paid for
                twice — the `Cnt/s` hint naming a deleted tile, and "Mint one
                under Access" naming a renamed page — and the answer is the one
                `RunGlossary` settled on: say something that stays true. */}
            <summary
              data-testid="run-metadata-toggle"
              className="w-fit cursor-pointer list-none font-sans text-[12px] font-medium text-accent hover:underline hover:underline-offset-2"
            >
              <span className="group-open:hidden">Run details</span>
              <span className="hidden group-open:inline">Hide run details</span>
            </summary>
            {/* CLOSED, ALWAYS — unlike the run list's filter disclosure and the
                time window, both of which open themselves because a URL can
                arrive already filtered or already narrowed, and a shortened
                list under a shut control reads as data that is missing.
                Nothing here is ever in a state a reader has to be told about:
                these are the same six values on every run. */}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              {versionChip}
              {restChips}
            </div>
          </details>
        </div>
      ) : (
        <div className={STRIP}>
          {versionChip}
          {environmentChip}
          {restChips}
        </div>
      )}
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
  name,
  label,
  testId,
  children,
}: {
  /**
   * The VISIBLE label, above the value. Restores what the design pass
   * removed: this row was a `<dl>` whose `<dt>`s named each value for
   * everyone, became a bare row of values named only by `aria-label`, and
   * this module's own docstring has carried the complaint ever since — a
   * sighted reader had to infer that "63s" was a duration from its position.
   * The control-room mockups label every cell, and so does this again.
   */
  readonly name: string;
  readonly label: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 md:px-4 md:first:pl-0 md:last:pr-0">
      {/* An overline, not a heading — same rule as the rail's "Projects" and
          the gate strip's "Release gate": nothing queries a `<p>` by
          accessible name, so `uppercase` is safe HERE in a way it is not on
          a column heading. */}
      <p className="text-[12px] font-medium text-muted">{name}</p>
      {/* THE GROUP, THE NAME AND THE TESTID ALL STAY ON THE VALUE NODE, and
          the visible label above sits OUTSIDE it. That is what keeps the
          three text-content pins in the module docstring true while the cell
          gains a label: `getByTestId('run-commit').textContent` is still the
          seven-character sha and nothing else, and `toHaveAccessibleName`
          still reads this element's own `aria-label`. Putting the label
          inside would make that text content `COMMITa3f9c21`, which starts
          nothing. */}
      <span
        role="group"
        aria-label={label}
        data-testid={testId}
        className="mt-1 block truncate whitespace-nowrap text-[12px] text-primary"
      >
        {children}
      </span>
    </div>
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
